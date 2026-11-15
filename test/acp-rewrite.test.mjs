import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { rewriteMessage } from "../bin/acp-rewrite.mjs";
import { healthy, prepareHome, stop } from "../bin/copilot-api.mjs";
import { fakePluginDir } from "./fixtures/plugin-dir.mjs";

const labels = new Map([
  ["my-claude-gpt-5", { name: "GPT-5 (OpenAI, 400K)" }],
  ["claude-sonnet-5-5", { name: "Claude Sonnet 5.5", description: "Claude Sonnet 5.5 · Anthropic · 200K context · via GitHub Copilot" }],
]);
const hidden = new Set(["agent"]);

const modelOption = (options) => ({ id: "model", name: "Model", type: "select", currentValue: "default", options });

test("hides the listed options and names Copilot models in a session/new result", () => {
  const msg = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      sessionId: "s1",
      configOptions: [
        { id: "mode", name: "Mode", type: "select", options: [] },
        { id: "agent", name: "Agent", type: "select", options: [] },
        modelOption([
          { value: "default", name: "Default", description: "Recommended" },
          { value: "my-claude-gpt-5", name: "my-claude-gpt-5", description: "" },
          { value: "claude-sonnet-5-5", name: "Sonnet", description: "Sonnet 5.5 for everyday tasks" },
        ]),
      ],
      models: {
        currentModelId: "default",
        availableModels: [{ modelId: "default", name: "Default" }, { modelId: "my-claude-gpt-5", name: "my-claude-gpt-5" }],
      },
    },
  };
  rewriteMessage(msg, { hidden, labels });
  assert.deepEqual(msg.result.configOptions.map((o) => o.id), ["mode", "model"]);
  assert.deepEqual(msg.result.configOptions[1].options, [
    { value: "default", name: "Default", description: "Recommended" },
    { value: "my-claude-gpt-5", name: "GPT-5 (OpenAI, 400K)", description: "GitHub Copilot model my-claude-gpt-5" },
    { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", description: "Claude Sonnet 5.5 · Anthropic · 200K context · via GitHub Copilot" },
  ]);
  assert.equal(msg.result.models.availableModels[1].name, "GPT-5 (OpenAI, 400K)");
});

test("names models in grouped options and config_option_update", () => {
  const msg = {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption([{ group: "copilot", name: "Copilot", options: [{ value: "my-claude-gpt-5", name: "x" }] }])],
      },
    },
  };
  rewriteMessage(msg, { hidden, labels });
  assert.equal(msg.params.update.configOptions[0].options[0].options[0].name, "GPT-5 (OpenAI, 400K)");
});

test("removes the cost from usage_update and keeps the rest", () => {
  const msg = {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.42, currency: "USD" } } },
  };
  rewriteMessage(msg, { hidden, labels });
  assert.deepEqual(msg.params.update, { sessionUpdate: "usage_update", used: 1200, size: 200000 });
});

test("leaves other messages and values alone", () => {
  const chunk = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } };
  assert.deepEqual(rewriteMessage(structuredClone(chunk), { hidden, labels }), chunk);
  const unknown = { jsonrpc: "2.0", id: 2, result: { configOptions: [modelOption([{ value: "opus", name: "Opus" }])] } };
  assert.deepEqual(rewriteMessage(structuredClone(unknown), { hidden, labels }), unknown);
  assert.equal(rewriteMessage(null, { hidden, labels }), null);
});

// -- the proxy with a (fake) copilot-api ---------------------------------------------

const dataDirs = [];
after(async () => {
  for (const dir of dataDirs) await stop(dir);
});

test("proxy: starts copilot-api, points the adapter at it with every Copilot model, names them, strips cost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-proxy-"));
  const dataDir = join(dir, "data");
  dataDirs.push(dataDir);
  const { home, state } = await prepareHome(dataDir);
  writeFileSync(join(home, "github_token"), "gho_x");
  const pluginDir = fakePluginDir();
  // the proxy finds copilot-api next to its own folder: run a copy from the fake plugin folder
  const bin = join(pluginDir, "bin");
  cpSync(join(import.meta.dirname, "..", "bin"), bin, { recursive: true });

  // a fake adapter that reports its environment, offers a model option and a cost
  const agent = join(dir, "agent.mjs");
  writeFileSync(
    agent,
    `const env = process.env;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
send({ jsonrpc: "2.0", method: "test/env", params: {
  base: env.ANTHROPIC_BASE_URL, token: env.ANTHROPIC_AUTH_TOKEN, apiKey: env.ANTHROPIC_API_KEY ?? null,
  modelConfig: env.CLAUDE_MODEL_CONFIG ?? null } });
send({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1", configOptions: [
  { id: "agent", name: "Agent", type: "select", options: [] },
  { id: "model", name: "Model", type: "select", currentValue: "default", options: [
    { value: "default", name: "Default" }, { value: "my-claude-gpt-5", name: "my-claude-gpt-5" },
    { value: "claude-sonnet-5-5", name: "Sonnet", description: "Sonnet 5.5 for everyday tasks" }] }] } });
send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 1, currency: "USD" } } } });
`,
  );
  const proxy = spawn(process.execPath, [join(bin, "claude-copilot-acp-proxy.mjs"), process.execPath, agent], {
    env: { ...process.env, CLAUDE_COPILOT_DATA_DIR: dataDir, ANTHROPIC_API_KEY: "sk-ant-must-not-pass", XDG_STATE_HOME: dir },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const received = [];
  createInterface({ input: proxy.stdout }).on("line", (line) => received.push(JSON.parse(line)));
  proxy.stdin.end();
  const code = await new Promise((r) => proxy.on("exit", r));
  assert.equal(code, 0);

  const env = received.find((m) => m.method === "test/env").params;
  assert.equal(env.base, `http://127.0.0.1:${state.port}`);
  assert.equal(env.token, state.apiKey);
  assert.equal(env.apiKey, null, "an Anthropic API key must not reach copilot-api");
  assert.deepEqual(JSON.parse(env.modelConfig), { availableModels: ["claude-sonnet-5-5", "my-claude-gpt-5", "my-claude-gemini-3-pro[1m]"] });

  const result = received.find((m) => m.id === 1).result;
  assert.deepEqual(result.configOptions.map((o) => o.id), ["model"], "subagent option hidden");
  assert.equal(result.configOptions[0].options[1].name, "GPT-5 (OpenAI, 400K)");
  assert.equal(result.configOptions[0].options[2].name, "Claude Sonnet 5.5");
  assert.match(result.configOptions[0].options[2].description, /^Claude Sonnet 5\.5 · Anthropic · .* · via GitHub Copilot$/);
  const usage = received.find((m) => m.params?.update?.sessionUpdate === "usage_update").params.update;
  assert.equal("cost" in usage, false);
});

// -- prompts: copilot-api started again when it stopped, or a clear error -----------

/** A fake adapter that echoes every line it gets from bb as a test/echo notification. */
function echoAgent(dir) {
  const agent = join(dir, "echo-agent.mjs");
  writeFileSync(
    agent,
    `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test/echo", params: { line } }) + "\\n"));
`,
  );
  return agent;
}

/** Runs the proxy from a fake plugin folder; returns a sender and the messages bb got. */
function startProxy(dir, dataDir) {
  const pluginDir = fakePluginDir();
  const bin = join(pluginDir, "bin");
  cpSync(join(import.meta.dirname, "..", "bin"), bin, { recursive: true });
  const proxy = spawn(process.execPath, [join(bin, "claude-copilot-acp-proxy.mjs"), process.execPath, echoAgent(dir)], {
    env: { ...process.env, CLAUDE_COPILOT_DATA_DIR: dataDir, XDG_STATE_HOME: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const received = [];
  createInterface({ input: proxy.stdout }).on("line", (line) => received.push(JSON.parse(line)));
  const until = async (check) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
    return check();
  };
  return {
    send: (msg) => proxy.stdin.write(JSON.stringify(msg) + "\n"),
    received,
    until,
    close: async () => {
      if (proxy.exitCode !== null) return proxy.exitCode;
      proxy.stdin.end();
      return await new Promise((r) => proxy.on("exit", r));
    },
  };
}

test("proxy: a prompt without a GitHub sign-in comes back as an error that says so; other requests pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-proxy-"));
  const dataDir = join(dir, "data");
  const p = startProxy(dir, dataDir);
  after(() => p.close());
  p.send({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId: "s1", prompt: [] } });
  p.send({ jsonrpc: "2.0", id: 8, method: "session/new", params: {} });
  assert.ok(await p.until(() => p.received.some((m) => m.id === 7) && p.received.some((m) => m.method === "test/echo")));
  const error = p.received.find((m) => m.id === 7).error;
  assert.match(error.message, /Not signed in to GitHub Copilot/);
  assert.match(error.message, /bb acp-claude-copilot login/);
  const echoed = p.received.filter((m) => m.method === "test/echo").map((m) => JSON.parse(m.params.line).id);
  assert.deepEqual(echoed, [8], "the prompt does not reach the adapter, the other request does");
  assert.equal(await p.close(), 0);
});

test("proxy: a prompt after copilot-api stopped (idle stop) starts it again, then reaches the adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-proxy-"));
  const dataDir = join(dir, "data");
  dataDirs.push(dataDir);
  const { home, state } = await prepareHome(dataDir);
  writeFileSync(join(home, "github_token"), "gho_x");
  const p = startProxy(dir, dataDir);
  after(() => p.close());
  // the proxy starts copilot-api before the adapter; then the plugin stops it
  assert.ok(await p.until(() => existsSync(join(dataDir, "copilot-api.pid"))));
  for (let i = 0; i < 100 && !(await healthy(state)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await healthy(state), true);
  assert.equal(await stop(dataDir), true);
  for (let i = 0; i < 50 && (await healthy(state)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await healthy(state), false);

  p.send({ jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: "s1", prompt: [] } });
  assert.ok(await p.until(() => p.received.some((m) => m.method === "test/echo")));
  assert.equal(JSON.parse(p.received.find((m) => m.method === "test/echo").params.line).id, 9);
  assert.equal(await healthy(state), true, "copilot-api runs again");
  assert.equal(p.received.some((m) => m.id === 9 && m.error), false);
  assert.equal(await p.close(), 0);
});
