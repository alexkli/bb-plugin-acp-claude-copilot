#!/usr/bin/env node
// ACP stdio proxy between bb and @agentclientprotocol/claude-agent-acp, used by
// claude-copilot-acp. Before it starts the adapter, it makes sure this
// plugin's copilot-api runs (bin/copilot-api.mjs) and points Claude Code at it.
// Before each prompt it checks again and starts copilot-api if it stopped
// (the plugin stops it when idle); when it can't, bb gets the prompt back as
// an error that says why (not signed in, start failed and where the log is).
// In agent -> bb messages it (bin/acp-rewrite.mjs, plan-approval.mjs):
//
// 1. Drops the session config options listed in CLAUDE_COPILOT_ACP_HIDE_OPTIONS
//    (comma-separated ids, default "agent"): with many subagents, the subagent
//    option squeezes bb's model picker list on narrow screens.
// 2. Names the Copilot models in the model picker: Claude models by their
//    plain name without "Claude" ("Opus 5.5"), a 1M version next to a
//    shorter one with a "1M" suffix; GPT, Gemini, ...
//    with vendor and context window. They are there because the adapter gets every Copilot model as its
//    availableModels allowlist (CLAUDE_MODEL_CONFIG), unless
//    CLAUDE_COPILOT_ALL_MODELS=0.
// 3. Removes the cost from usage_update: Claude Code's estimate is at
//    Anthropic list prices and says nothing about Copilot billing.
// 4. Holds the permission request that ends plan mode ("Ready to code?") and
//    asks bb an elicitation question instead, which bb shows even in Full
//    Access, where it would answer the permission request itself (see
//    plan-approval.mjs). Before asking, it opens the plan in the thread's side
//    panel: a copy in the thread's storage folder (BB_THREAD_STORAGE), kept in
//    sync with Claude's plan file so the panel follows later edits. Claude's
//    message gets a ::claude-copilot-plan directive, which the plugin's app
//    renders as a card that opens the copy in the side panel of a window
//    showing the thread (never switching anyone's view).
//    CLAUDE_COPILOT_ASK_PLAN_APPROVAL=0 turns this off.
//
// In bb -> agent messages it applies bb's permission mode (bin/acp-session.mjs):
// bb starts the launcher with --bb-permission-mode=accept-edits or =full (the
// agent entry's permissionCli); the proxy takes that argument off the
// adapter's command line, and in Accept Edits adds Claude Code's Bash sandbox
// to every session start, with the settings bb's Claude Code provider uses.
// CLAUDE_COPILOT_SANDBOX=0 turns this off.
// Every session start also gets the Claude Code options in SESSION_OPTIONS
// (acp-session.mjs): prompt suggestions off, since bb never shows them and
// each one costs a full-context model request per turn.
//
// CLAUDE_COPILOT_DATA_DIR is the plugin's data folder (copilot-api state);
// without it the proxy starts no copilot-api and leaves the environment alone.
//
// Usage: claude-copilot-acp-proxy.mjs <command> [args...] [--bb-permission-mode=<mode>]
import { spawn } from "node:child_process";
import { watchFile } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { rewriteMessage } from "./acp-rewrite.mjs";
import { sandboxFor, takePermissionMode, withSessionOptions } from "./acp-session.mjs";
import { ensure, listModels, modelConfig, modelLabels } from "./copilot-api.mjs";
import {
  isPlanApprovalRequest,
  planApprovalQuestion,
  planApprovalResult,
  planFileFromUpdate,
  planLinkUpdate,
  planText,
} from "./plan-approval.mjs";

const ASK_PLAN_APPROVAL = process.env.CLAUDE_COPILOT_ASK_PLAN_APPROVAL !== "0";
const ALL_MODELS = process.env.CLAUDE_COPILOT_ALL_MODELS !== "0";
const HIDDEN_OPTIONS = new Set(
  (process.env.CLAUDE_COPILOT_ACP_HIDE_OPTIONS ?? "agent").split(",").filter(Boolean),
);
const DATA_DIR = process.env.CLAUDE_COPILOT_DATA_DIR || null;
const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "claude-copilot-acp");
const RUN = `${process.pid}-${Date.now()}`;

const warn = (text) => process.stderr.write(`claude-copilot-acp: ${text}\n`);

/** The adapter's environment: Claude Code against our copilot-api, plus the Copilot model labels. */
async function copilotEnvironment() {
  const env = { ...process.env };
  const labels = new Map();
  if (DATA_DIR === null) return { env, labels };
  const status = await ensure({ dataDir: DATA_DIR, pluginDir: join(import.meta.dirname, "..") }).catch((error) => ({
    running: false,
    port: null,
    apiKey: null,
    error: String(error),
  }));
  if (status.port !== null) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${status.port}`;
    env.ANTHROPIC_AUTH_TOKEN = status.apiKey;
    // an Anthropic key or claude.ai token must not go to copilot-api, nor win over it
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (!status.running) {
    warn(`${status.error ?? "copilot-api is not running"} Sign in with: bb acp-claude-copilot login`);
    return { env, labels };
  }
  const models = await listModels(DATA_DIR, status).catch(() => []);
  for (const [id, label] of modelLabels(models)) labels.set(id, label);
  const config = ALL_MODELS && !env.CLAUDE_MODEL_CONFIG ? modelConfig(models) : null;
  if (config !== null) env.CLAUDE_MODEL_CONFIG = config;
  return { env, labels };
}

const { env: childEnv, labels: MODEL_LABELS } = await copilotEnvironment();

const PLUGIN_DIR = join(import.meta.dirname, "..");
const SETTINGS_HINT = "Settings → Plugins → Claude Copilot ACP provider";

/** Why copilot-api can't serve a prompt, for bb to show in the thread. */
const notRunningMessage = (status) =>
  status.signedIn === false
    ? `Not signed in to GitHub Copilot. Sign in under ${SETTINGS_HINT} (or run: bb acp-claude-copilot login), then send the message again.`
    : `copilot-api is not running: ${status.error ?? "it did not start"}. Check ${SETTINGS_HINT}, then send the message again.`;

/** Before a prompt: copilot-api runs (started again if it stopped), or the reason it doesn't. */
const ensureForPrompt = () =>
  ensure({ dataDir: DATA_DIR, pluginDir: PLUGIN_DIR }).catch((error) => ({ running: false, signedIn: null, error: String(error) }));

const { permissionMode, rest: command } = takePermissionMode(process.argv.slice(2));
const SANDBOX = sandboxFor({ permissionMode, enabled: process.env.CLAUDE_COPILOT_SANDBOX !== "0" });
const [cmd, ...args] = command;
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], env: childEnv });

child.stdin.on("error", () => {});
child.on("error", (error) => {
  warn(`could not start ${cmd}: ${String(error)}`);
  process.exit(1);
});

// plan approval questions sent to bb, by question id: the held permission request
const pendingPlanApprovals = new Map();
let nextQuestion = 0;
// the plan file Claude last wrote, by session id
const planFiles = new Map();

// bb shows files in a thread's storage folder in its side panel and reloads
// them when they change; files elsewhere it shows only from a link, without
// reloading. So the plan is shown from a copy there.
const STORAGE = process.env.BB_THREAD_STORAGE || null;
const PLANS_DIR = STORAGE ? join(STORAGE, "plans") : join(STATE_DIR, "plans");
// Claude's plan files and their copies in PLANS_DIR, kept in sync
const planCopies = new Map();

/** The copy of a plan file, created on first use and refreshed whenever the plan changes. */
const copyOfPlan = async (source) => {
  if (!STORAGE) return source;
  const copy = join(PLANS_DIR, basename(source));
  const refresh = () => copyFile(source, copy).catch(() => {});
  if (!planCopies.has(source)) {
    planCopies.set(source, copy);
    // stat polling also survives editors that replace the file
    watchFile(source, { interval: 1000 }, (now, before) => {
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) refresh();
    });
  }
  await mkdir(PLANS_DIR, { recursive: true });
  await copyFile(source, copy);
  return copy;
};

/** The plan file to show for a plan approval request: a copy of Claude's, else the plan text written to one. */
const planFileFor = async (msg) => {
  const own = planFiles.get(msg.params?.sessionId);
  if (own) {
    try {
      return await copyOfPlan(own);
    } catch {
      // fall back to the plan text
    }
  }
  const text = planText(msg);
  if (text === null) return own ?? null;
  try {
    await mkdir(PLANS_DIR, { recursive: true });
    const path = join(PLANS_DIR, `plan-${String(msg.params?.sessionId ?? RUN).replace(/[^\w.-]/g, "_")}-${Date.now()}.md`);
    await writeFile(path, text + "\n");
    return path;
  } catch {
    return own ?? null;
  }
};

// bb -> agent: forwarded line by line, in order, except bb's answers to plan
// approval questions, and prompts while copilot-api can't be started
const fromBb = createInterface({ input: process.stdin, crlfDelay: Infinity });

/** A bb -> agent line with the sandbox added to session starts (Accept Edits only). */
const toAgentLine = (line) => {
  if (!line.includes('"session/')) return line;
  try {
    return JSON.stringify(withSessionOptions(JSON.parse(line), { sandbox: SANDBOX }));
  } catch {
    return line; // not JSON: pass through untouched
  }
};

const fromBbLine = async (line) => {
  if (pendingPlanApprovals.size > 0 && line.includes("bb-plan-approval-")) {
    try {
      const msg = JSON.parse(line);
      const held = msg.method === undefined ? pendingPlanApprovals.get(msg.id) : undefined;
      if (held) {
        pendingPlanApprovals.delete(msg.id);
        const answer = { jsonrpc: "2.0", id: held.id, result: planApprovalResult(msg, held.params.options) };
        child.stdin.write(JSON.stringify(answer) + "\n");
        return;
      }
    } catch {
      // not ours: forward
    }
  }
  if (DATA_DIR !== null && line.includes('"session/prompt"')) {
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      // not JSON: forward
    }
    if (msg?.method === "session/prompt" && msg.id !== undefined) {
      const status = await ensureForPrompt();
      if (!status.running) {
        warn(notRunningMessage(status));
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: notRunningMessage(status) } }) + "\n");
        return;
      }
    }
  }
  child.stdin.write(toAgentLine(line) + "\n");
};

let toAgent = Promise.resolve();
fromBb.on("line", (line) => {
  toAgent = toAgent.then(() => fromBbLine(line)).catch(() => child.stdin.write(toAgentLine(line) + "\n"));
});
fromBb.on("close", () => toAgent.finally(() => child.stdin.end()));

const rewrite = (msg) => rewriteMessage(msg, { hidden: HIDDEN_OPTIONS, labels: MODEL_LABELS });

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

/** Forwards one agent -> bb line, rewritten; resolves once it (or what replaces it) is written. */
const forward = async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(line + "\n"); // not JSON: pass through untouched
    return;
  }
  if (ASK_PLAN_APPROVAL && isPlanApprovalRequest(msg)) {
    const questionId = `bb-plan-approval-${RUN}-${nextQuestion++}`;
    pendingPlanApprovals.set(questionId, msg);
    const planFile = await planFileFor(msg);
    if (planFile && typeof msg.params?.sessionId === "string") {
      const inStorage = STORAGE !== null && planFile.startsWith(STORAGE + sep);
      const storagePath = inStorage ? relative(STORAGE, planFile).split(sep).join("/") : null;
      process.stdout.write(JSON.stringify(planLinkUpdate(msg.params.sessionId, planFile, storagePath)) + "\n");
    }
    process.stdout.write(JSON.stringify(planApprovalQuestion(msg, questionId, planFile)) + "\n");
    return;
  }
  const planFile = planFileFromUpdate(msg);
  if (planFile) {
    planFiles.set(planFile[0], planFile[1]);
    // keep an open copy current when Claude edits the plan after it was shown
    if (planCopies.has(planFile[1])) copyOfPlan(planFile[1]).catch(() => {});
  }
  process.stdout.write(JSON.stringify(rewrite(msg)) + "\n");
};

// lines go out in order, even while a plan file is being prepared
let forwarding = Promise.resolve();
rl.on("line", (line) => {
  forwarding = forwarding.then(() => forward(line)).catch(() => process.stdout.write(line + "\n"));
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}
// exit only once the child is gone and all of its output has been forwarded
let exitCode = null;
let drained = false;
const maybeExit = () => {
  if (exitCode !== null && drained) {
    process.stdout.write("", () => process.exit(exitCode));
  }
};
rl.on("close", () => forwarding.finally(() => { drained = true; maybeExit(); }));
child.on("exit", (code, signal) => { exitCode = code ?? (signal ? 1 : 0); maybeExit(); });
