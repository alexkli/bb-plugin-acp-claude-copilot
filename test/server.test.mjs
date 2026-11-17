import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { closeUsageDb } from "../usage.ts";

const OTHER = { id: "gh-copilot", displayName: "GitHub Copilot", command: "copilot", args: ["--acp"] };
const OLD_ENTRY = {
  id: "claude-copilot",
  displayName: "Claude Code (Copilot ACP)",
  command: "/old/bin/claude-copilot-acp",
  args: [],
  env: { CLAUDE_COPILOT_DATA_DIR: "/old/host-data", ANTHROPIC_MODEL: "claude-opus-5-5", CLAUDE_COPILOT_ASK_PLAN_APPROVAL: "0" },
};
const SESSION = "0b7c3f4e-1d2a-4b5c-8d9e-0f1a2b3c4d5e";

/**
 * Loads the plugin against a fake bb whose ACP agents plugin stores
 * customAgents in memory and whose provider list shows what this plugin
 * registered; bb's data folder is a temp folder, so copilot-api's state is too
 * (nothing is started).
 */
async function load({ customAgents = JSON.stringify([OTHER]), acpDown = false, providerId = "acp-claude-copilot" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-server-"));
  const dataDir = join(root, "plugins", "acp-claude-copilot", "host-data");
  let stored = customAgents;
  let harnessRef;
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
      providers: {
        list: async () =>
          harnessRef.registrations.providerRegistrations.map((p) => ({ id: p.id, pluginId: "acp-claude-copilot", capabilities: { supportsFork: p.capabilities.fork !== "none" } })),
      },
      system: { config: async () => ({ dataDir: root }) },
      threads: {
        get: async ({ threadId }) => ({ id: threadId, providerId }),
        events: { list: async () => [{ type: "thread/identity", data: { providerThreadId: SESSION } }] },
        listRunning: async () => [],
      },
    },
  });
  harnessRef = harness;
  await plugin(bb);
  const agents = () => (stored === "" ? [] : JSON.parse(stored));
  const env = () => readFileSync(join(dataDir, "agent.env"), "utf8");
  return { harness, dataDir, agents, env, raw: () => stored };
}

const cli = async (harness, ...argv) => {
  const { exitCode, stdout, stderr } = await harness.runCli(argv);
  return { exitCode, stdout, stderr };
};

const signIn = (dataDir) => {
  mkdirSync(join(dataDir, "copilot-api"), { recursive: true });
  writeFileSync(join(dataDir, "copilot-api", "github_token"), "gho_test");
};

test("the provider service registers acp-claude-copilot with forks and writes the agent's settings with the data folder", async () => {
  const { harness, dataDir, agents, env } = await load();
  await harness.runService("provider").done;
  assert.deepEqual(harness.needsConfigurationMessages, []);
  assert.deepEqual(harness.registrations.providerRegistrations.map((p) => [p.id, p.capabilities.fork]), [["acp-claude-copilot", "tip"]]);
  const spec = harness.registrations.providerRegistrations[0].experimental_bridgeOptions.acpLaunchSpec;
  assert.match(spec.command, /\/bin\/claude-copilot-acp$/);
  assert.deepEqual(spec.env, { CLAUDE_COPILOT_ENV_FILE: join(dataDir, "agent.env") });
  assert.deepEqual(spec.permissionCli, { full: ["--bb-permission-mode=full"], workspaceWrite: ["--bb-permission-mode=accept-edits"] });
  assert.match(env(), new RegExp(`^export CLAUDE_COPILOT_DATA_DIR='${dataDir}'$`, "m"));
  assert.match(env(), /^export ANTHROPIC_MODEL='claude-opus-5-5'$/m);
  assert.doesNotMatch(env(), /CLAUDE_COPILOT_SANDBOX/);
  assert.equal(statSync(join(dataDir, "agent.env")).mode & 0o777, 0o600);
  assert.deepEqual(agents(), [OTHER], "no customAgents entry");
});

test("handover: the old entry is removed, other agents stay, and the user's own variables move to Extra environment variables", async () => {
  const { harness, agents, env, raw } = await load({ customAgents: JSON.stringify([OTHER, OLD_ENTRY]) });
  await harness.runService("provider").done;
  assert.deepEqual(agents(), [OTHER]);
  assert.equal(raw(), JSON.stringify([OTHER]), "the setting keeps its formatting");
  assert.match(env(), /^export CLAUDE_COPILOT_ASK_PLAN_APPROVAL='0'$/m);
  assert.doesNotMatch(env(), /old\/host-data/, "managed variables come from the settings, not the old entry");
  const view = await harness.callRpc("getSettings", null);
  assert.equal(view.settings.extraEnv, "CLAUDE_COPILOT_ASK_PLAN_APPROVAL=0");
});

test("a claude-copilot agent this plugin didn't add is left alone", async () => {
  const usersOwn = { id: "claude-copilot", command: "/usr/local/bin/my-claude" };
  const text = `${JSON.stringify([OTHER, usersOwn], null, 4)}\n`;
  const { harness, raw } = await load({ customAgents: text });
  await harness.runService("provider").done;
  assert.equal(raw(), text);
});

test("settings: the sandbox opt-out and extra variables reach the agent's settings; bad extra variables are refused", async () => {
  const { harness, env } = await load();
  await harness.runService("provider").done;
  const view = await harness.callRpc("setSettings", { sandbox: false, extraEnv: "FOO=1 CLAUDE_COPILOT_DATA_DIR=/x" });
  assert.equal(view.settings.sandbox, false);
  await cli(harness, "repair"); // waits for the setup the change started
  assert.match(env(), /^export CLAUDE_COPILOT_SANDBOX='0'$/m);
  assert.match(env(), /^export FOO='1'$/m);
  assert.doesNotMatch(env(), /CLAUDE_COPILOT_DATA_DIR='\/x'/, "the settings win over extra variables");
  await assert.rejects(harness.callRpc("setSettings", { extraEnv: "not a pair" }), /NAME=value/);
});

test("status: fails before registration and with a leftover entry, passes once set up and signed in; repair sets up", async () => {
  const { harness, dataDir } = await load({ customAgents: JSON.stringify([OTHER, OLD_ENTRY]) });
  signIn(dataDir);
  const before = await cli(harness, "status");
  assert.equal(before.exitCode, 1);
  assert.match(before.stdout, /bb provider acp-claude-copilot: NOT registered \(run: bb acp-claude-copilot repair\)/);
  assert.match(before.stdout, /Old provider-acp customAgents entry "claude-copilot": LEFTOVER/);

  assert.deepEqual(await cli(harness, "repair"), { exitCode: 0, stdout: "acp-claude-copilot: repaired\n", stderr: "" });
  const after = await cli(harness, "status");
  assert.equal(after.exitCode, 0, after.stdout);
  assert.match(after.stdout, /^Launcher: .*\/bin\/claude-copilot-acp\n/);
  assert.match(after.stdout, /ACP adapter: bundled @agentclientprotocol\/claude-agent-acp 0\.107\.3\n/);
  assert.match(after.stdout, /bb provider acp-claude-copilot: registered by this plugin, side chats on\n/);
  assert.doesNotMatch(after.stdout, /LEFTOVER/);
  assert.match(after.stdout, /Agent settings file: .*agent\.env\n/);
  assert.match(after.stdout, /Bash sandbox in Accept Edits: on\n/);
  assert.match(after.stdout, /copilot-api: stopped \(starts with the next message\)\nGitHub: signed in\n/);
  assert.deepEqual(await cli(harness, "repair"), { exitCode: 0, stdout: "acp-claude-copilot: already up to date\n", stderr: "" });
});

test("status fails without a GitHub sign-in", async () => {
  const { harness } = await load();
  await harness.runService("provider").done;
  const status = await cli(harness, "status");
  assert.equal(status.exitCode, 1);
  assert.match(status.stdout, /GitHub: NOT signed in \(run: bb acp-claude-copilot login\)/);
});

test("without the ACP agents plugin there is nothing to hand over: the provider registers anyway", async () => {
  const { harness, dataDir } = await load({ acpDown: true });
  signIn(dataDir);
  await harness.runService("provider").done;
  assert.deepEqual(harness.needsConfigurationMessages, []);
  assert.equal(harness.registrations.providerRegistrations.length, 1);
  assert.equal((await cli(harness, "status")).exitCode, 0);
});

test("an unknown subcommand names the valid ones", async () => {
  const { harness } = await load();
  const { exitCode, stderr } = await cli(harness, "unregister");
  assert.equal(exitCode, 2);
  assert.match(stderr, /status \| repair \| login \| logout \| start \| stop/);
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
