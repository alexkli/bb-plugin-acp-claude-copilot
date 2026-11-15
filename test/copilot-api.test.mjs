import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  acquireLock,
  ensure,
  healthy,
  isSignedIn,
  listModels,
  modelConfig,
  modelLabel,
  modelLabels,
  paths,
  prepareHome,
  proxyStatus,
  stop,
  toCopilotModels,
} from "../bin/copilot-api.mjs";
import { fakePluginDir } from "./fixtures/plugin-dir.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "copilot-api-"));

test("prepareHome creates the state once and keeps it", async () => {
  const dataDir = tmp();
  const first = await prepareHome(dataDir);
  assert.equal(first.home, join(dataDir, "copilot-api"));
  assert.ok(Number.isInteger(first.state.port) && first.state.port > 0);
  assert.match(first.state.apiKey, /^bbacc-[0-9a-f]{48}$/);
  assert.match(first.state.adminKey, /^bbacc-admin-[0-9a-f]{48}$/);
  assert.equal(statSync(paths(dataDir).state).mode & 0o777, 0o600);
  const second = await prepareHome(dataDir);
  assert.deepEqual(second.state, first.state, "same port and keys on every call");
});

test("prepareHome locks config.json's auth to our keys and keeps the rest", async () => {
  const dataDir = tmp();
  const home = join(dataDir, "copilot-api");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ smallModel: "gpt-5-mini", auth: { apiKeys: ["someone-else"], extra: 1 } }));
  const { state } = await prepareHome(dataDir);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(config.smallModel, "gpt-5-mini");
  assert.deepEqual(config.auth, { apiKeys: [state.apiKey], extra: 1, adminApiKey: state.adminKey });
});

test("a broken state file is replaced", async () => {
  const dataDir = tmp();
  writeFileSync(join(dataDir, "proxy.json"), "{\"port\": 0}");
  const { state } = await prepareHome(dataDir);
  assert.ok(state.port > 0 && state.apiKey);
});

test("isSignedIn needs a non-empty GitHub token", async () => {
  const dataDir = tmp();
  const { home } = await prepareHome(dataDir);
  assert.equal(isSignedIn(home), false);
  writeFileSync(join(home, "github_token"), "");
  assert.equal(isSignedIn(home), false);
  writeFileSync(join(home, "github_token"), "gho_x");
  assert.equal(isSignedIn(home), true);
});

test("the start lock is exclusive and taken over when stale", async () => {
  const file = join(tmp(), "copilot-api.lock");
  const lock = await acquireLock(file);
  assert.ok(lock);
  assert.equal(await acquireLock(file), null, "held by someone else");
  assert.ok(await acquireLock(file, Date.now() + 60_000), "stale after 30s");
  await lock.release();
  assert.equal(existsSync(file), false);
});

test("ensure doesn't start copilot-api without a GitHub sign-in", async () => {
  const dataDir = tmp();
  const status = await ensure({ dataDir, pluginDir: fakePluginDir() });
  assert.equal(status.running, false);
  assert.equal(status.signedIn, false);
  assert.match(status.error, /Not signed in/);
  assert.equal(existsSync(paths(dataDir).pid), false);
});

const started = [];
after(async () => {
  for (const dataDir of started) await stop(dataDir);
});

test("ensure starts copilot-api detached, reuses it, and stop ends it", async () => {
  const dataDir = tmp();
  started.push(dataDir);
  const { home } = await prepareHome(dataDir);
  writeFileSync(join(home, "github_token"), "gho_x");
  const pluginDir = fakePluginDir();
  // two threads at once: one starts it, the other waits for it
  const [a, b] = await Promise.all([ensure({ dataDir, pluginDir }), ensure({ dataDir, pluginDir })]);
  assert.equal(a.running, true, a.error ?? "");
  assert.equal(b.running, true, b.error ?? "");
  assert.equal(a.port, b.port);
  const pid = Number(readFileSync(paths(dataDir).pid, "utf8"));
  assert.ok(pid > 0);
  assert.equal(existsSync(paths(dataDir).lock), false, "lock released");
  // a later call finds it running
  const again = await ensure({ dataDir, pluginDir });
  assert.equal(again.running, true);
  assert.equal(Number(readFileSync(paths(dataDir).pid, "utf8")), pid, "not started twice");
  assert.equal((await proxyStatus(dataDir)).running, true);
  // the gateway key is required
  assert.equal(await healthy({ port: a.port, apiKey: "wrong" }), false);

  const models = await listModels(dataDir, a, { force: true });
  assert.deepEqual(models.map((m) => m.id), ["claude-sonnet-5-5", "my-claude-gpt-5", "my-claude-gemini-3-pro[1m]"]);
  assert.ok(existsSync(paths(dataDir).models), "cached");

  assert.equal(await stop(dataDir), true);
  for (let i = 0; i < 20 && (await healthy(a)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await healthy(a), false);
  assert.equal(await stop(dataDir), false, "nothing left to stop");
});

test("toCopilotModels keeps chat models, in Claude Code's id convention", () => {
  const models = toCopilotModels({
    data: [
      { id: "claude-opus-5-5", vendor: "Anthropic", display_name: "Claude Opus 5.5", context_window: 1000000, capabilities: { type: "chat" }, supported_endpoints: ["/v1/messages"] },
      { id: "gpt-5", vendor: "OpenAI", display_name: "GPT-5 (github-copilot)", context_window: 400000, capabilities: { type: "chat" }, supported_endpoints: ["/responses"] },
      { id: "gemini-3-pro", vendor: "Google", name: "Gemini 3 Pro", context_window: 1000000, capabilities: { type: "chat" }, supported_endpoints: ["/chat/completions"] },
      { id: "hidden", capabilities: { type: "chat" }, model_picker_enabled: false, supported_endpoints: ["/chat/completions"] },
      { id: "no-endpoints", capabilities: { type: "chat" }, supported_endpoints: [] },
      { id: "openai/image", capabilities: { type: "chat" }, supported_endpoints: ["/images"] },
      { id: "embed", capabilities: { type: "embeddings" }, supported_endpoints: ["/embeddings"] },
    ],
  });
  assert.deepEqual(models, [
    { id: "claude-opus-5-5", upstreamId: "claude-opus-5-5", displayName: "Claude Opus 5.5", vendor: "Anthropic", contextWindow: 1000000 },
    { id: "my-claude-gpt-5", upstreamId: "gpt-5", displayName: "GPT-5", vendor: "OpenAI", contextWindow: 400000 },
    { id: "my-claude-gemini-3-pro[1m]", upstreamId: "gemini-3-pro", displayName: "Gemini 3 Pro", vendor: "Google", contextWindow: 1000000 },
  ]);
  assert.deepEqual(toCopilotModels(null), []);
});

test("modelConfig is an availableModels allowlist for claude-agent-acp", () => {
  const models = [
    { id: "claude-opus-5-5", upstreamId: "claude-opus-5-5", displayName: "Claude Opus 5.5", vendor: "Anthropic", contextWindow: null },
    { id: "my-claude-gpt-5", upstreamId: "gpt-5", displayName: "GPT-5", vendor: "OpenAI", contextWindow: 400000 },
  ];
  assert.deepEqual(JSON.parse(modelConfig(models)), { availableModels: ["claude-opus-5-5", "my-claude-gpt-5"] });
  assert.equal(modelConfig([]), null, "no list: leave the adapter's own picker");
  assert.equal(modelLabel(models[1]), "GPT-5 (OpenAI, 400K)");
  assert.equal(modelLabel({ ...models[1], contextWindow: 1000000 }), "GPT-5 (OpenAI, 1M)");
  assert.equal(modelLabel({ ...models[1], contextWindow: 1048576 }), "GPT-5 (OpenAI, 1M)", "a binary 1M is 1M too");
  assert.equal(modelLabel({ ...models[0], vendor: null }), "Claude Opus 5.5");
});

test("modelLabels names Claude models plainly and marks a 1M version next to a shorter one", () => {
  const claude = (id, displayName, contextWindow) => ({ id, upstreamId: id, displayName, vendor: "Anthropic", contextWindow });
  const labels = modelLabels([
    claude("claude-opus-5-5", "Claude Opus 5.5", 1000000),
    claude("claude-sonnet-5", "Claude Sonnet 5", 200000),
    claude("claude-sonnet-5-1m", "Claude Sonnet 5 (1M context)", 1000000),
    claude("claude-haiku-5", "Claude Haiku 5", 200000),
    claude("claude-haiku-5-1m", "Claude Haiku 5 1M", 1048576),
    { id: "my-claude-gpt-5[1m]", upstreamId: "gpt-5", displayName: "GPT-5", vendor: "OpenAI", contextWindow: 1000000 },
  ]);
  assert.deepEqual(labels.get("claude-opus-5-5"), {
    name: "Claude Opus 5.5",
    description: "Claude Opus 5.5 · Anthropic · 1M context · via GitHub Copilot",
  });
  assert.equal(labels.get("claude-sonnet-5").name, "Claude Sonnet 5");
  assert.equal(labels.get("claude-sonnet-5").description, "Claude Sonnet 5 · Anthropic · 200K context · via GitHub Copilot");
  assert.equal(labels.get("claude-sonnet-5-1m").name, "Claude Sonnet 5 1M");
  assert.equal(labels.get("claude-haiku-5").name, "Claude Haiku 5");
  assert.equal(labels.get("claude-haiku-5-1m").name, "Claude Haiku 5 1M");
  assert.deepEqual(labels.get("my-claude-gpt-5[1m]"), { name: "GPT-5 (OpenAI, 1M)" });
});
