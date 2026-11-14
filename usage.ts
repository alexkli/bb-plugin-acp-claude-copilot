// Server side of the Copilot usage page and the copilot-api config.json editor.
// Same behavior as the Claude Copilot provider plugin's host entry; this
// plugin has no host entry, so the bb server (on the machine copilot-api runs
// on) does it directly.
//
// - apiRequest: read-only GETs on the plugin's own copilot-api (dashboard page,
//   its data, usage);
// - listInstances / instanceUsage: other local copilot-api instances with a
//   usage database, shown as tabs on the usage page. Their token usage is read
//   from a read-only snapshot (VACUUM INTO) with copilot-api's own query code
//   (usage-reader.mjs);
// - getConfig / setConfig: copilot-api's config.json without the plugin-managed
//   gateway keys;
// - sessionUsage: what copilot-api recorded for one Claude Code session (the
//   credits indicator under the prompt).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { copilotEnv, healthy, paths, prepareHome } from "./bin/copilot-api.mjs";
import type { ApiResponse, Instance, SessionUsage } from "./contract";

export const OWN_INSTANCE_ID = "plugin";
const DB_FILE = "copilot-api.sqlite";

const json = (status: number, value: unknown): ApiResponse => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
});

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// -- The plugin's own copilot-api --------------------------------------------------

/** Read-only copilot-api paths the dashboard and usage entry may GET. */
const API_PATHS = /^\/(usage-viewer|(usage|token-usage|models|v1\/models)(\/[A-Za-z0-9_.-]+)*)(\?[^#\s]*)?$/;

/** GET a path on the plugin's copilot-api with the gateway key. */
export async function apiRequest(dataDir: string, path: string): Promise<ApiResponse> {
  const segments = (path.split("?")[0] ?? "").split("/");
  if (!API_PATHS.test(path) || segments.some((s) => s === "." || s === "..")) {
    return { status: 400, contentType: "text/plain", body: "Path not allowed" };
  }
  const { state } = await prepareHome(dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      headers: { authorization: `Bearer ${state.apiKey}`, accept: "application/json, text/html" },
      signal: AbortSignal.timeout(25_000),
    });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      body: body.length > 7_000_000 ? body.slice(0, 7_000_000) : body,
    };
  } catch (error) {
    return json(502, { error: `copilot-api is not reachable: ${String(error)}` });
  }
}

// -- config.json ---------------------------------------------------------------------

const MANAGED_AUTH_KEYS = ["apiKeys", "adminApiKey"];

/** config.json for editing: the plugin-managed auth keys are left out. */
export async function getConfig(dataDir: string): Promise<string> {
  const { home } = await prepareHome(dataDir);
  const config = (await readJson<Record<string, unknown>>(join(home, "config.json"))) ?? {};
  const auth = { ...((config.auth ?? {}) as Record<string, unknown>) };
  for (const key of MANAGED_AUTH_KEYS) delete auth[key];
  if (Object.keys(auth).length === 0) delete config.auth;
  else config.auth = auth;
  return JSON.stringify(config, null, 2);
}

export async function setConfig(dataDir: string, text: string): Promise<{ reloaded: boolean; message: string | null }> {
  let next: unknown;
  try {
    next = JSON.parse(text);
  } catch (error) {
    throw new Error(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("config.json must be a JSON object.");
  const config = next as Record<string, unknown>;
  const auth = { ...((config.auth ?? {}) as Record<string, unknown>) };
  for (const key of MANAGED_AUTH_KEYS) delete auth[key]; // re-added by prepareHome
  config.auth = auth;
  const { home, state } = await prepareHome(dataDir);
  await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  await prepareHome(dataDir); // restore the managed keys
  if (!(await healthy(state))) return { reloaded: false, message: "Saved. copilot-api is not running; it reads the file when it starts." };
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/admin/config/reload`, {
      method: "POST",
      headers: { "x-api-key": state.adminKey },
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok
      ? { reloaded: true, message: "Saved and reloaded." }
      : { reloaded: false, message: `Saved, but reload failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}` };
  } catch (error) {
    return { reloaded: false, message: `Saved, but reload failed: ${String(error)}` };
  }
}

// -- Other local copilot-api instances (usage page tabs) ---------------------------

function defaultHome(): string {
  return join(homedir(), ".local", "share", "copilot-api");
}

function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function instanceId(home: string): string {
  return createHash("sha256").update(home).digest("hex").slice(0, 12);
}

/** Running `copilot-api start` processes: their home and port. */
async function runningCopilotApis(): Promise<{ home: string; port: number | null }[]> {
  const found: { home: string; port: number | null }[] = [];
  const parse = (args: string, env: string) => {
    if (!/copilot-api/.test(args) || !/\sstart(\s|$)/.test(args)) return;
    const apiHome = /--api-home[= ](\S+)/.exec(args)?.[1] ?? /(?:^|\s)COPILOT_API_HOME=(\S+)/.exec(env)?.[1] ?? defaultHome();
    const port = Number(/(?:--port|-p)[= ](\d+)/.exec(args)?.[1] ?? "4141");
    found.push({ home: apiHome, port: Number.isFinite(port) ? port : null });
  };
  try {
    if (process.platform === "linux") {
      for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
        try {
          const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
          if (!args.includes("copilot-api")) continue;
          parse(args, readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", " "));
        } catch {
          // process gone or not ours
        }
      }
    } else if (process.platform !== "win32") {
      const out = await new Promise<string>((resolve) => {
        const ps = spawn("ps", ["-axwwE", "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] });
        let text = "";
        ps.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
        ps.on("close", () => resolve(text));
        ps.on("error", () => resolve(""));
      });
      for (const line of out.split("\n")) if (line.includes("copilot-api")) parse(line, line);
    }
  } catch {
    // discovery is best effort
  }
  return found;
}

export async function listInstances(dataDir: string): Promise<Instance[]> {
  const ownHome = paths(dataDir).home;
  const running = await runningCopilotApis();
  const portOf = (home: string) => running.find((r) => r.home === home)?.port ?? null;
  const instances: Instance[] = [{ id: OWN_INSTANCE_ID, label: "bb plugin", home: ownHome, own: true, port: portOf(ownHome) }];
  const homes = new Set<string>([defaultHome(), ...running.map((r) => r.home)]);
  homes.delete(ownHome);
  // Other bb plugins' own copilot-api (e.g. the Claude Copilot / Claude Copilot
  // ACP sibling) belongs to that plugin's usage page, not this one.
  const pluginsRoot = dirname(dirname(dataDir)) + sep;
  for (const home of homes) {
    if (home.startsWith(pluginsRoot)) continue;
    if (!existsSync(join(home, DB_FILE))) continue;
    const port = portOf(home);
    const label = home === defaultHome() ? "copilot-api (default home)" : `copilot-api ${tildify(home)}`;
    instances.push({ id: instanceId(home), label, home, own: false, port });
  }
  return instances;
}

const TOKEN_USAGE_PATH = /^\/token-usage(\/(daily|events|sessions))?(\?[A-Za-z0-9_=&%.-]*)?$/;
const SNAPSHOT_MAX_AGE_MS = 30_000;
const snapshotJobs = new Map<string, Promise<string>>();

/** A consistent, read-only copy of another instance's usage database. */
async function snapshot(dataDir: string, id: string, home: string): Promise<string> {
  const dir = join(dataDir, "snapshots");
  const target = join(dir, `${id}.sqlite`);
  if (existsSync(target) && Date.now() - statSync(target).mtimeMs < SNAPSHOT_MAX_AGE_MS) return target;
  const running = snapshotJobs.get(id);
  if (running) return await running;
  const job = (async () => {
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `${id}.${process.pid}.${Date.now()}.tmp`);
    const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
    const db = new DatabaseSync(join(home, DB_FILE), { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    await rename(temp, target);
    return target;
  })();
  snapshotJobs.set(id, job);
  try {
    return await job;
  } finally {
    snapshotJobs.delete(id);
  }
}

const readerQueues = new Map<string, Promise<void>>();

/** /token-usage for another instance, answered by copilot-api's own code over a snapshot. */
export async function instanceUsage(options: {
  dataDir: string;
  pluginDir: string;
  node: string;
  instanceId: string;
  path: string;
}): Promise<ApiResponse> {
  const { dataDir, pluginDir, node, path } = options;
  if (!TOKEN_USAGE_PATH.test(path)) return json(400, { error: "Path not allowed" });
  const instance = (await listInstances(dataDir)).find((i) => i.id === options.instanceId && !i.own);
  if (!instance) return json(404, { error: "Unknown copilot-api instance" });
  let db: string;
  try {
    db = await snapshot(dataDir, instance.id, instance.home);
  } catch (error) {
    return json(502, { error: `Could not read ${instance.home}: ${String(error)}` });
  }
  const readerHome = join(dataDir, "reader-home");
  await mkdir(readerHome, { recursive: true });
  // copilot-api's store opens the database read-write (migrations, pragmas),
  // so concurrent readers on one snapshot fail with "database is locked".
  const previous = readerQueues.get(instance.id) ?? Promise.resolve();
  const result = previous.then(() => runReader(node, pluginDir, path, readerHome, db));
  const tail = result.then(() => undefined);
  readerQueues.set(instance.id, tail);
  void tail.then(() => {
    if (readerQueues.get(instance.id) === tail) readerQueues.delete(instance.id);
  });
  return await result;
}

function runReader(node: string, pluginDir: string, path: string, readerHome: string, db: string): Promise<ApiResponse> {
  return new Promise<ApiResponse>((resolve) => {
    const proc = spawn(node, [join(pluginDir, "usage-reader.mjs"), pluginDir, path], {
      env: { ...copilotEnv(readerHome), COPILOT_API_SQLITE_DB_PATH: db },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { status: 200, contentType: "application/json", body: out } : json(502, { error: err.trim().slice(-500) || `reader exited ${code}` }));
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve(json(502, { error: String(error) }));
    });
  });
}

// -- Per-session usage (composer credits indicator) -------------------------------

const EMPTY_SESSION_USAGE: SessionUsage = {
  requests: 0,
  credits: 0,
  unpriced: 0,
  inputTokens: 0,
  outputTokens: 0,
  models: [],
  firstAt: null,
  lastAt: null,
};

type SqliteDb = import("node:sqlite").DatabaseSync;
let sessionDb: { file: string; db: SqliteDb } | null = null;

/** The plugin's copilot-api usage database, opened read-only once (WAL lets it read while copilot-api writes). */
async function ownUsageDb(dataDir: string): Promise<SqliteDb | null> {
  const file = join(paths(dataDir).home, DB_FILE);
  if (sessionDb?.file === file && sessionDb.db.isOpen) return sessionDb.db;
  if (!existsSync(file)) return null;
  const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
  sessionDb = { file, db: new DatabaseSync(file, { readOnly: true }) };
  return sessionDb.db;
}

export function closeUsageDb(): void {
  sessionDb?.db.close();
  sessionDb = null;
}

/**
 * Sum of what copilot-api recorded for one Claude Code session. copilot-api
 * keys rows by the x-claude-code-session-id header (the root session, so
 * subagent requests count too), which is the thread's ACP session id.
 */
export async function sessionUsage(dataDir: string, sessionId: string): Promise<SessionUsage> {
  let db: SqliteDb | null;
  try {
    db = await ownUsageDb(dataDir);
  } catch {
    return EMPTY_SESSION_USAGE;
  }
  if (!db) return EMPTY_SESSION_USAGE;
  const num = (value: unknown) => (typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0);
  const rows = db
    .prepare(
      `SELECT model,
              COUNT(*) AS requests,
              COALESCE(SUM(total_nano_aiu), 0) AS nano,
              SUM(CASE WHEN total_nano_aiu IS NULL THEN 1 ELSE 0 END) AS unpriced,
              COALESCE(SUM(input_tokens + cache_read_input_tokens + cache_creation_input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              MIN(created_at_ms) AS first,
              MAX(created_at_ms) AS last
         FROM token_usage_events
        WHERE session_id = ?
        GROUP BY model
        ORDER BY nano DESC`,
    )
    .all(sessionId) as Record<string, unknown>[];
  if (rows.length === 0) return EMPTY_SESSION_USAGE;
  const credits = (nano: unknown) => num(nano) / 1e9;
  const first = Math.min(...rows.map((r) => num(r.first)));
  const last = Math.max(...rows.map((r) => num(r.last)));
  return {
    requests: rows.reduce((sum, r) => sum + num(r.requests), 0),
    credits: credits(rows.reduce((sum, r) => sum + num(r.nano), 0)),
    unpriced: rows.reduce((sum, r) => sum + num(r.unpriced), 0),
    inputTokens: rows.reduce((sum, r) => sum + num(r.input), 0),
    outputTokens: rows.reduce((sum, r) => sum + num(r.output), 0),
    models: rows.map((r) => ({ model: String(r.model ?? ""), requests: num(r.requests), credits: credits(r.nano) })),
    firstAt: first > 0 ? new Date(first).toISOString() : null,
    lastAt: last > 0 ? new Date(last).toISOString() : null,
  };
}
