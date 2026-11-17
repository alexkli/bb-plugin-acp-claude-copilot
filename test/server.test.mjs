import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { closeUsageDb } from "../usage.ts";

const OTHER = { id: "gh-copilot", displayName: "GitHub Copilot", command: "copilot", args: ["--acp"] };
const SESSION = "0b7c3f4e-1d2a-4b5c-8d9e-0f1a2b3c4d5e";

/**
 * Loads the plugin against a fake bb whose ACP agents plugin stores
 * customAgents in memory; bb's data folder is a temp folder, so copilot-api's
 * state is too (nothing is started).
 */
async function load({ customAgents = JSON.stringify([OTHER]), registered = true, acpDown = false, providerId = "acp-claude-copilot" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-server-"));
  const dataDir = join(root, "plugins", "acp-claude-copilot", "host-data");
  let stored = customAgents;
  const { bb, harness } = createFakePluginHost({
    pluginId: "acp-claude-copilot",
    sdk: {
      plugins: {
        getSettings: async () => {
          if (acpDown) throw new Error("HTTP 404: unknown plugin");
          return { pluginId: "provider-acp", values: { customAgents: stored } };
        },
        updateSettings: async ({ values }) => {
          stored = values.customAgents;
          return { pluginId: "provider-acp", values };
        },
      },
      providers: { list: async () => (registered ? [{ id: "acp-claude-copilot" }] : []) },
      system: { config: async () => ({ dataDir: root }) },
      threads: {
        get: async ({ threadId }) => ({ id: threadId, providerId }),
        events: { list: async () => [{ type: "thread/identity", data: { providerThreadId: SESSION } }] },
        listRunning: async () => [],
      },
    },
  });
  await plugin(bb);
  const agents = () => (stored === "" ? [] : JSON.parse(stored));
  const ours = () => agents().find((agent) => agent.id === "claude-copilot");
  return { harness, dataDir, agents, ours };
}

const cli = async (harness, ...argv) => {
  const { exitCode, stdout, stderr } = await harness.runCli(argv);
  return { exitCode, stdout, stderr };
};

const signIn = (dataDir) => {
  mkdirSync(join(dataDir, "copilot-api"), { recursive: true });
  writeFileSync(join(dataDir, "copilot-api", "github_token"), "gho_test");
};

test("the provision service adds the entry next to other agents, with the data folder and bb's permission modes", async () => {
  const { harness, dataDir, agents, ours } = await load();
  await harness.runService("provision").done;
  assert.deepEqual(harness.needsConfigurationMessages, []);
  assert.deepEqual(agents()[0], OTHER);
  const entry = ours();
  assert.match(entry.command, /\/bin\/claude-copilot-acp$/);
  assert.deepEqual(entry.permissionCli, { full: ["--bb-permission-mode=full"], workspaceWrite: ["--bb-permission-mode=accept-edits"] });
  assert.equal(entry.supportsManualCompaction, true);
  assert.equal(entry.env.CLAUDE_COPILOT_DATA_DIR, dataDir);
  assert.equal(entry.env.ANTHROPIC_MODEL, "claude-opus-5-5");
  assert.equal("CLAUDE_COPILOT_SANDBOX" in entry.env, false);
});

test("turning the sandbox off in the settings sets CLAUDE_COPILOT_SANDBOX=0", async () => {
  const { harness, ours } = await load();
  await harness.runService("provision").done;
  const view = await harness.callRpc("setSettings", { sandbox: false });
  assert.equal(view.settings.sandbox, false);
  await cli(harness, "repair"); // waits for the provisioning the change started
  assert.equal(ours().env.CLAUDE_COPILOT_SANDBOX, "0");
});

test("status passes once registered and signed in; an outdated entry fails it until repair", async () => {
  const stale = { id: "claude-copilot", displayName: "Claude Code (Copilot ACP)", command: "/old/claude-copilot-acp", args: [], env: {} };
  const { harness, dataDir, ours } = await load({ customAgents: JSON.stringify([OTHER, stale]) });
  signIn(dataDir);

  const before = await cli(harness, "status");
  assert.equal(before.exitCode, 1);
  assert.match(before.stdout, /ACP customAgents entry "claude-copilot": OUTDATED \(run: bb acp-claude-copilot repair\)/);

  const repaired = await cli(harness, "repair");
  assert.deepEqual(repaired, { exitCode: 0, stdout: "acp-claude-copilot: repaired\n", stderr: "" });
  assert.match(ours().command, /\/bin\/claude-copilot-acp$/);

  const after = await cli(harness, "status");
  assert.equal(after.exitCode, 0, after.stdout);
  assert.match(after.stdout, /^Launcher: .*\/bin\/claude-copilot-acp\n/);
  assert.match(after.stdout, /ACP adapter: bundled @agentclientprotocol\/claude-agent-acp 0\.107\.3\n/);
  assert.match(after.stdout, /ACP customAgents entry "claude-copilot": current\n/);
  assert.match(after.stdout, /bb provider acp-claude-copilot: registered\n/);
  assert.match(after.stdout, /Bash sandbox in Accept Edits: on\n/);
  assert.match(after.stdout, /copilot-api: stopped \(starts with the next message\)\nGitHub: signed in\n/);
  assert.deepEqual(await cli(harness, "repair"), { exitCode: 0, stdout: "acp-claude-copilot: already up to date\n", stderr: "" });
});

test("status fails without a GitHub sign-in, or when bb has not registered the provider", async () => {
  const unsigned = await load();
  await unsigned.harness.runService("provision").done;
  const a = await cli(unsigned.harness, "status");
  assert.equal(a.exitCode, 1);
  assert.match(a.stdout, /GitHub: NOT signed in \(run: bb acp-claude-copilot login\)/);

  const unregistered = await load({ registered: false });
  signIn(unregistered.dataDir);
  await unregistered.harness.runService("provision").done;
  const b = await cli(unregistered.harness, "status");
  assert.equal(b.exitCode, 1);
  assert.match(b.stdout, /bb provider acp-claude-copilot: NOT registered/);
});

test("unregister removes only this plugin's entry", async () => {
  const { harness, agents } = await load();
  await harness.runService("provision").done;
  assert.equal(agents().length, 2);
  const first = await cli(harness, "unregister");
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /unregistered/);
  assert.deepEqual(agents(), [OTHER]);
  assert.deepEqual(await cli(harness, "unregister"), { exitCode: 0, stdout: "acp-claude-copilot: not registered\n", stderr: "" });
});

test("when the ACP agents plugin's settings can't be read, bb shows the plugin as needing configuration", async () => {
  const { harness } = await load({ acpDown: true });
  await harness.runService("provision").done;
  assert.equal(harness.needsConfigurationMessages.length, 1);
  assert.match(harness.needsConfigurationMessages[0], /Could not register the Claude Code \(Copilot ACP\) agent: .*not available.*bb acp-claude-copilot repair/);
  const status = await cli(harness, "status");
  assert.equal(status.exitCode, 1);
  assert.match(status.stdout, /ACP customAgents entry: unknown/);
});

test("an unknown subcommand names the valid ones", async () => {
  const { harness } = await load();
  const { exitCode, stderr } = await cli(harness, "nope");
  assert.equal(exitCode, 2);
  assert.match(stderr, /status \| repair \| unregister \| login \| logout \| start \| stop/);
});

/** copilot-api's usage database with one request of `nano` AI units for the session. */
function recordUsage(dataDir, nano) {
  const home = join(dataDir, "copilot-api");
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, "copilot-api.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS token_usage_events (session_id TEXT, model TEXT, total_nano_aiu INTEGER,
    input_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, output_tokens INTEGER, created_at_ms INTEGER)`);
  db.prepare("INSERT INTO token_usage_events VALUES (?, 'claude-opus-5-5', ?, 10, 0, 0, 5, ?)").run(SESSION, nano, Date.now());
  db.close();
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test("a watched thread's credits: the server invalidates the read when the usage changes, not before", async (t) => {
  const { harness, dataDir } = await load();
  recordUsage(dataDir, 2e9);
  t.after(closeUsageDb);
  const first = await harness.callRpc("sessionCredits", { threadId: "thr_a" });
  assert.equal(first.status, "ok");
  assert.equal(first.usage.credits, 2);

  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const unwatch = harness.experimental_watchRpc("sessionCredits", { input: { threadId: "thr_a" } });
  await settle();
  mock.timers.tick(5000);
  await settle();
  assert.deepEqual(harness.experimental_rpcInvalidations, [], "unchanged usage: no refresh");

  recordUsage(dataDir, 3e9);
  mock.timers.tick(5000);
  await settle();
  assert.deepEqual(harness.experimental_rpcInvalidations, [["session-credits:thr_a"]]);
  unwatch();
});

test("other providers' threads are unsupported and not watched", async () => {
  const { harness } = await load({ providerId: "claude-code" });
  assert.deepEqual(await harness.callRpc("sessionCredits", { threadId: "thr_b" }), { status: "unsupported" });
  const unwatch = harness.experimental_watchRpc("sessionCredits", { input: { threadId: "thr_b" } });
  await settle();
  unwatch();
  assert.deepEqual(harness.experimental_rpcInvalidations, []);
});
