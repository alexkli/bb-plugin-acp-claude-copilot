// This plugin's own copilot-api (https://github.com/caozhiyuan/copilot-api):
// state, start, stop and model list. Plain Node, no bb SDK: the ACP proxy
// (bin/claude-copilot-acp-proxy.mjs) calls ensure() before it starts the
// adapter, and the plugin server (server.ts) uses the same functions for its
// settings section, CLI and usage entry.
//
// Everything lives in the plugin's data folder (`dataDir`, by default
// ~/.bb/plugins/acp-claude-copilot/host-data):
//   copilot-api/          COPILOT_API_HOME: GitHub token, config.json, usage db
//   proxy.json            port, gateway key and admin key (0600)
//   copilot-api.pid       pid of the running copilot-api
//   copilot-api.lock      held while one process starts copilot-api
//   copilot-api.log       copilot-api's output
//   copilot-models.json   cached Copilot model list
//
// copilot-api runs detached, so it is shared by all threads and outlives the
// thread that started it. It runs until `bb acp-claude-copilot stop` (or a
// reboot); the next thread starts it again.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

const LOCK_STALE_MS = 30_000;
const START_TIMEOUT_MS = 15_000;
const MODELS_MAX_AGE_MS = 10 * 60_000;

/** The files in `dataDir`. */
export function paths(dataDir) {
  return {
    home: join(dataDir, "copilot-api"),
    state: join(dataDir, "proxy.json"),
    pid: join(dataDir, "copilot-api.pid"),
    lock: join(dataDir, "copilot-api.lock"),
    log: join(dataDir, "copilot-api.log"),
    models: join(dataDir, "copilot-models.json"),
  };
}

/** copilot-api's entry point in the plugin's node_modules. */
export function copilotApiMain(pluginDir) {
  const main = join(pluginDir, "node_modules", "@jeffreycao", "copilot-api", "dist", "main.js");
  if (!existsSync(main)) throw new Error(`copilot-api is not installed in the plugin (${main}). Run npm install in the plugin folder.`);
  return main;
}

/** Environment for copilot-api: ours minus copilot-api and bb overrides, with our home. */
export function copilotEnv(home, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("COPILOT_API_") || key.startsWith("BB_")) continue;
    env[key] = value;
  }
  env.COPILOT_API_HOME = home;
  // the plugin server may run in bb's Electron binary
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

const validState = (s) =>
  s !== null && typeof s === "object" && Number.isInteger(s.port) && s.port > 0 &&
  typeof s.apiKey === "string" && s.apiKey !== "" && typeof s.adminKey === "string" && s.adminKey !== "";

/**
 * The copilot-api home and its state (port, gateway key, admin key), created
 * on first use and then kept, so a restarted copilot-api has the same address.
 * config.json's auth is locked to our keys; anything else in it is kept.
 */
export async function prepareHome(dataDir) {
  const p = paths(dataDir);
  await mkdir(p.home, { recursive: true, mode: 0o700 });
  let state = await readJson(p.state);
  if (!validState(state)) {
    state = {
      port: await freePort(),
      apiKey: `bbacc-${randomBytes(24).toString("hex")}`,
      adminKey: `bbacc-admin-${randomBytes(24).toString("hex")}`,
    };
    await writeFile(p.state, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  const configFile = join(p.home, "config.json");
  const config = (await readJson(configFile)) ?? {};
  const auth = config.auth && typeof config.auth === "object" ? config.auth : {};
  if (JSON.stringify(auth.apiKeys) !== JSON.stringify([state.apiKey]) || auth.adminApiKey !== state.adminKey) {
    config.auth = { ...auth, apiKeys: [state.apiKey], adminApiKey: state.adminKey };
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  return { home: p.home, state };
}

export function isSignedIn(home) {
  const token = join(home, "github_token");
  return existsSync(token) && statSync(token).size > 0;
}

export async function healthy(state, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/v1/models`, {
      headers: { authorization: `Bearer ${state.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(file) {
  const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Take the start lock (an exclusively created file), or null when another
 * process holds it. A lock older than LOCK_STALE_MS is left over from a
 * crashed start and is taken over.
 */
export async function acquireLock(file, now = Date.now()) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      closeSync(fd);
      return { release: () => rm(file, { force: true }) };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs < LOCK_STALE_MS) return null;
      await rm(file, { force: true });
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Make sure copilot-api runs, starting it detached when it doesn't. Returns
 * its status. Without a GitHub sign-in it is not started.
 *
 * @param {{ dataDir: string, pluginDir: string, node?: string, env?: NodeJS.ProcessEnv }} options
 */
export async function ensure({ dataDir, pluginDir, node = process.execPath, env = process.env }) {
  const p = paths(dataDir);
  const { home, state } = await prepareHome(dataDir);
  const status = (running, error = null) => ({ running, signedIn: isSignedIn(home), port: state.port, apiKey: state.apiKey, home, error });
  if (await healthy(state)) return status(true);
  if (!isSignedIn(home)) return status(false, "Not signed in to GitHub Copilot.");

  const lock = await acquireLock(p.lock);
  if (lock === null) {
    // another thread is starting it: wait for that
    for (let waited = 0; waited < START_TIMEOUT_MS; waited += 250) {
      if (await healthy(state)) return status(true);
      await sleep(250);
    }
    return status(false, `copilot-api did not start; see ${p.log}`);
  }
  try {
    if (await healthy(state)) return status(true);
    // a copilot-api of ours that runs but doesn't answer (e.g. hung): replace it
    const old = await readPid(p.pid);
    if (old !== null && pidAlive(old)) {
      try {
        process.kill(old, "SIGTERM");
      } catch {
        // gone meanwhile
      }
      await sleep(500);
    }
    const out = openSync(p.log, "a");
    let proc;
    try {
      proc = spawn(node, [copilotApiMain(pluginDir), "start", "--host", "127.0.0.1", "--port", String(state.port)], {
        env: copilotEnv(home, env),
        detached: true,
        stdio: ["ignore", out, out],
      });
    } finally {
      closeSync(out);
    }
    let exited = null;
    proc.on("exit", (code) => (exited = code ?? 1));
    proc.on("error", () => (exited = 1));
    proc.unref();
    if (proc.pid) await writeFile(p.pid, String(proc.pid));
    for (let waited = 0; waited < START_TIMEOUT_MS; waited += 250) {
      if (await healthy(state)) return status(true);
      if (exited !== null) break;
      await sleep(250);
    }
    return (await healthy(state)) ? status(true) : status(false, `copilot-api did not start; see ${p.log}`);
  } finally {
    await lock.release();
  }
}

/** Status without starting anything. */
export async function proxyStatus(dataDir) {
  const { home, state } = await prepareHome(dataDir);
  return { running: await healthy(state), signedIn: isSignedIn(home), port: state.port, apiKey: state.apiKey, home, error: null };
}

/** Stop our copilot-api. True when one was running. */
export async function stop(dataDir) {
  const p = paths(dataDir);
  const pid = await readPid(p.pid);
  await rm(p.pid, { force: true });
  if (pid === null || !pidAlive(pid)) return false;
  process.kill(pid, "SIGTERM");
  return true;
}

/** GET a path on our copilot-api with the gateway key, as parsed JSON. */
export async function apiGet(state, path, timeoutMs = 25_000) {
  const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    headers: { authorization: `Bearer ${state.apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`copilot-api ${path} returned HTTP ${res.status}`);
  return await res.json();
}

// -- Models ----------------------------------------------------------------------

/**
 * Copilot chat models from copilot-api's /v1/models, with the model id Claude
 * Code sends. copilot-api's Claude Code convention: non-Claude models get a
 * my-claude- prefix (copilot-api strips it again) and [1m] for a 1M window;
 * Claude models keep their plain ids.
 */
export function toCopilotModels(body) {
  const data = body?.data;
  if (!Array.isArray(data)) return [];
  const models = [];
  for (const m of data) {
    if (!m || typeof m !== "object") continue;
    const caps = m.capabilities ?? {};
    const upstreamId = typeof m.id === "string" ? m.id : null;
    if (!upstreamId || upstreamId.includes("/")) continue; // provider-prefixed (image) models
    if ((caps.type ?? m.type) !== "chat" && caps.type !== "chat") continue;
    if (m.model_picker_enabled === false) continue;
    if (!Array.isArray(m.supported_endpoints) || m.supported_endpoints.length === 0) continue;
    const contextWindow = typeof m.context_window === "number" ? m.context_window : null;
    const vendor = typeof m.vendor === "string" ? m.vendor : null;
    const anthropic = vendor === "Anthropic" || upstreamId.startsWith("claude-");
    const id = anthropic
      ? upstreamId
      : `my-claude-${upstreamId}${contextWindow !== null && contextWindow >= 1_000_000 ? "[1m]" : ""}`;
    const name = typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : upstreamId;
    models.push({ id, upstreamId, displayName: name.replace(/\s*\(github-copilot\)$/i, ""), vendor, contextWindow });
  }
  return models;
}

/** The Copilot model list: cached for 10 minutes, refreshed from a running copilot-api. */
export async function listModels(dataDir, state, { force = false } = {}) {
  const file = paths(dataDir).models;
  const cached = await readJson(file);
  const cachedModels = Array.isArray(cached?.models) ? cached.models : [];
  if (!force && cached && Date.now() - cached.fetchedAt < MODELS_MAX_AGE_MS && cachedModels.length > 0) return cachedModels;
  try {
    const models = toCopilotModels(await apiGet(state, "/v1/models", 10_000));
    if (models.length === 0) return cachedModels;
    await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), models }));
    return models;
  } catch {
    return cachedModels;
  }
}

/**
 * CLAUDE_MODEL_CONFIG for claude-agent-acp: an availableModels allowlist of
 * every Copilot model. The adapter lists an allowlisted id that Claude Code
 * doesn't know as its own picker row (applyAvailableModelsAllowlist), and
 * accepts it on session/set_config_option, so GPT, Gemini and other Copilot
 * models can be picked per thread. "default" stays on its own.
 */
export function modelConfig(models) {
  const ids = [...new Set(models.map((m) => m.id))];
  return ids.length === 0 ? null : JSON.stringify({ availableModels: ids });
}

function formatTokens(tokens) {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}K`;
}

/** The picker label of a non-Claude Copilot model: its name, plus vendor and context window. */
export function modelLabel(model) {
  const window = model.contextWindow ? formatTokens(model.contextWindow) : null;
  const extras = [model.vendor, window].filter(Boolean);
  return extras.length > 0 ? `${model.displayName} (${extras.join(", ")})` : model.displayName;
}

const isAnthropic = (model) => model.vendor === "Anthropic" || String(model.upstreamId ?? model.id).startsWith("claude-");
const isOneM = (model) => model.contextWindow !== null && model.contextWindow >= 1_000_000;
/** A Claude model's name without a 1M marker Copilot may add ("(1M context)", "1M"). */
const baseName = (name) => name.replace(/\s*(\(1M(\s+context)?\)|-?\b1M(\s+context)?)$/i, "").trim() || name;

/**
 * Picker rows for the Copilot models, by model id: { name, description? }.
 * Claude models by their plain name without "Claude" ("Opus 5.5"), with the
 * full name, vendor and context window in the description, in the Claude Code
 * (Copilot) provider's format.
 * When Copilot lists a Claude model in a 1M and a shorter version, both stay
 * and the 1M one gets a "1M" suffix. Other models keep modelLabel.
 */
export function modelLabels(models) {
  const labels = new Map();
  const claude = models.filter(isAnthropic);
  const versionsByName = new Map();
  for (const model of claude) {
    const name = baseName(model.displayName);
    versionsByName.set(name, [...(versionsByName.get(name) ?? []), model]);
  }
  for (const model of models) {
    if (!isAnthropic(model)) {
      labels.set(model.id, { name: modelLabel(model) });
      continue;
    }
    const name = baseName(model.displayName);
    const versions = versionsByName.get(name);
    const both = versions.some(isOneM) && versions.some((m) => !isOneM(m));
    const description = [
      name,
      model.vendor,
      model.contextWindow ? `${formatTokens(model.contextWindow)} context` : null,
      "via GitHub Copilot",
    ]
      .filter(Boolean)
      .join(" · ");
    const short = name.replace(/^Claude\s+/i, "") || name;
    labels.set(model.id, { name: both && isOneM(model) ? `${short} 1M` : short, description });
  }
  return labels;
}
