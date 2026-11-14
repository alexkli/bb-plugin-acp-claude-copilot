import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { rewriteMessage } from "../bin/acp-rewrite.mjs";
import { prepareHome, stop } from "../bin/copilot-api.mjs";
import { fakePluginDir } from "./fixtures/plugin-dir.mjs";

const labels = new Map([
  ["my-claude-gpt-5", "GPT-5 (OpenAI, 400K)"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 (Anthropic, 200K)"],
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
    { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (Anthropic, 200K)", description: "Sonnet 5.5 for everyday tasks" },
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
    { value: "default", name: "Default" }, { value: "my-claude-gpt-5", name: "my-claude-gpt-5" }] }] } });
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
  const usage = received.find((m) => m.params?.update?.sessionUpdate === "usage_update").params.update;
  assert.equal("cost" in usage, false);
});
