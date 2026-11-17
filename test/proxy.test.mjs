// The proxy and launcher end to end against a fake adapter: bb's permission
// mode and the Bash sandbox, and which adapter the launcher runs. Without
// CLAUDE_COPILOT_DATA_DIR the proxy starts no copilot-api.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { cleanEnv } from "./fixtures/env.mjs";

const PLUGIN = join(import.meta.dirname, "..");

/** A fake ACP adapter: reports its argv, then echoes every bb -> agent line back as test/received. */
function writeFakeAdapter(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
send({ jsonrpc: "2.0", method: "test/started", params: { argv: process.argv.slice(2), copilot: process.env.CLAUDE_COPILOT_SESSION ?? null } });
createInterface({ input: process.stdin }).on("line", (line) => send({ jsonrpc: "2.0", method: "test/received", params: JSON.parse(line) }));
`,
  );
}

/** Runs `command` speaking ACP: sends `toAgent` once the agent started, collects agent -> bb messages until `expected` arrived. */
async function run(command, args, env, toAgent, expected) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const received = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(received)}; stderr ${stderr}`)), 10_000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      received.push(JSON.parse(line));
      if (received.at(-1).method === "test/started") for (const m of toAgent) child.stdin.write(JSON.stringify(m) + "\n");
      if (received.length >= expected) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", () => setTimeout(() => reject(new Error(`exited early; got ${JSON.stringify(received)}; stderr ${stderr}`)), 200));
  });
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));
  return received;
}

const SESSION_NEW = { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/w", mcpServers: [], additionalDirectories: ["/storage"] } };
const SESSION_LOAD = { jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "s1", cwd: "/w", mcpServers: [] } };
const SET_MODE = { jsonrpc: "2.0", id: 3, method: "session/set_mode", params: { sessionId: "s1", modeId: "default" } };

async function runProxy(permissionArgs, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "copilot-proxy-"));
  const adapter = join(dir, "adapter.mjs");
  writeFakeAdapter(adapter);
  const toAgent = [SESSION_NEW, SESSION_LOAD, SET_MODE];
  return run(process.execPath, [join(PLUGIN, "bin", "claude-copilot-acp-proxy.mjs"), process.execPath, adapter, ...permissionArgs], cleanEnv(dir, env), toAgent, 1 + toAgent.length);
}

const sent = (received, method) => received.find((m) => m.params?.method === method).params;
const sandboxOf = (received, method = "session/new") => sent(received, method).params._meta?.claudeCode?.options?.sandbox;

test("proxy: Accept Edits runs Bash in the sandbox on every session start; bb's argument never reaches the adapter", async () => {
  const received = await runProxy(["--bb-permission-mode=accept-edits"]);
  assert.deepEqual(received[0].params.argv, []);
  assert.deepEqual(sandboxOf(received), {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    network: { allowLocalBinding: true },
    filesystem: { allowWrite: ["/storage"] },
  });
  assert.equal(sandboxOf(received, "session/load").enabled, true, "a resumed session gets it too");
  assert.equal(sandboxOf(received, "session/load").filesystem, undefined);
  assert.deepEqual(sent(received, "session/set_mode"), SET_MODE, "other requests pass unchanged");
});

test("proxy: Full Access, an unknown mode and the opt-out get no sandbox", async () => {
  for (const [args, env] of [[["--bb-permission-mode=full"], {}], [[], {}], [["--bb-permission-mode=accept-edits"], { CLAUDE_COPILOT_SANDBOX: "0" }]]) {
    const received = await runProxy(args, env);
    assert.deepEqual(received[0].params.argv, [], JSON.stringify(args));
    assert.deepEqual(sent(received, "session/new"), SESSION_NEW, JSON.stringify({ args, env }));
  }
});

/** A copy of the plugin's bin/ next to a fake bundled adapter in node_modules. */
function pluginCopy() {
  const dir = mkdtempSync(join(tmpdir(), "copilot-launcher-"));
  const root = join(dir, "plugin");
  cpSync(join(PLUGIN, "bin"), join(root, "bin"), { recursive: true });
  chmodSync(join(root, "bin", "claude-copilot-acp"), 0o755);
  writeFakeAdapter(join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"));
  return { dir, launcher: join(root, "bin", "claude-copilot-acp") };
}

const launch = (launcher, dir, args, env = {}) => run(launcher, args, cleanEnv(dir, env), [SESSION_NEW], 2);
const launcherLog = (dir) => readFileSync(join(dir, "state", "claude-copilot-acp", "launcher.log"), "utf8");

test("launcher: runs the bundled adapter in Copilot mode, with bb's permission mode applied by the proxy", async () => {
  const { dir, launcher } = pluginCopy();
  const received = await launch(launcher, dir, ["--bb-permission-mode=accept-edits"]);
  assert.deepEqual(received[0].params, { argv: [], copilot: "1" });
  assert.equal(sandboxOf(received).enabled, true);
  assert.match(launcherLog(dir), /data=none model=default adapter=node\n$/);
});

test("launcher: the ACP adapter command setting wins over the bundled adapter", async () => {
  const { dir, launcher } = pluginCopy();
  const other = join(dir, "other-adapter.mjs");
  writeFakeAdapter(other);
  const received = await launch(launcher, dir, ["--bb-permission-mode=full"], { CLAUDE_AGENT_ACP: `${process.execPath} ${other} --from-setting` });
  assert.deepEqual(received[0].params.argv, ["--from-setting"]);
  assert.equal(sandboxOf(received), undefined);
  assert.match(launcherLog(dir), /adapter=\//);
});
