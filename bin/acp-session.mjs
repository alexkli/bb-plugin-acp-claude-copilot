// bb -> agent session rewrites for the ACP proxy: bb's permission mode, the
// Bash sandbox and the Claude Code options the proxy sets for bb. Pure
// functions, so they can be tested without a running agent. The same file is
// in the Claude Bedrock ACP and Claude Copilot ACP plugins.

/**
 * The argument bb adds to the launch through the agent entry's `permissionCli`
 * (see agent-entry.ts). bb's ACP agents have two permission modes and bb
 * restarts the agent with the new argument when the thread's mode changes.
 */
export const PERMISSION_ARG = "--bb-permission-mode";
export const PERMISSION_MODES = /** @type {const} */ (["full", "accept-edits"]);

/** Session requests that start a Claude query, and so take its options. */
const SESSION_STARTS = new Set(["session/new", "session/load", "session/resume", "session/fork"]);

/**
 * Splits bb's permission argument off the adapter command line.
 *
 * @param {string[]} argv
 * @returns {{ permissionMode: "full" | "accept-edits" | null, rest: string[] }}
 */
export function takePermissionMode(argv) {
  let permissionMode = null;
  const rest = [];
  for (const arg of argv) {
    if (arg.startsWith(`${PERMISSION_ARG}=`)) {
      const value = arg.slice(PERMISSION_ARG.length + 1);
      if (PERMISSION_MODES.includes(value)) permissionMode = value;
      continue;
    }
    rest.push(arg);
  }
  return { permissionMode, rest };
}

/**
 * The Bash sandbox bb's own Claude Code provider uses for a workspace-write
 * session (Accept Edits): Bash runs in Claude Code's OS sandbox, sandboxed
 * commands run without a prompt, the agent may still ask to run one outside
 * it, and local servers can listen. Full Access gets no sandbox, as in bb's
 * Claude Code provider.
 *
 * @param {{ permissionMode: string | null, enabled: boolean }} args
 */
export function sandboxFor({ permissionMode, enabled }) {
  if (!enabled || permissionMode !== "accept-edits") return null;
  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    network: { allowLocalBinding: true },
  };
}

/**
 * Claude Code options the proxy sets on every session start, in every
 * permission mode:
 * - `promptSuggestions: false`: claude-agent-acp's ACP v1 core turns Claude
 *   Code's prompt suggestions on for every client, so each turn ends with one
 *   more model request, with the whole conversation as input, that predicts
 *   the user's next prompt. bb never shows it (only the AIR client reads it),
 *   so it only costs a request per turn.
 */
export const SESSION_OPTIONS = Object.freeze({ promptSuggestions: false });

/**
 * Adds `options` and the sandbox to a session request's
 * `_meta.claudeCode.options`, which claude-agent-acp passes to the Agent SDK
 * after its own defaults. The sandbox keeps the session's extra workspace roots
 * (bb's `additionalDirectories`, e.g. thread storage) writable. An option the
 * client already set wins. Other messages are returned unchanged.
 *
 * @param {any} msg a bb -> agent JSON-RPC message
 * @param {{ sandbox?: object | null, options?: Record<string, unknown> }} [add]
 */
export function withSessionOptions(msg, { sandbox = null, options: defaults = SESSION_OPTIONS } = {}) {
  if (!SESSION_STARTS.has(msg?.method) || !isObject(msg.params)) return msg;
  const meta = isObject(msg.params._meta) ? msg.params._meta : {};
  const claudeCode = isObject(meta.claudeCode) ? meta.claudeCode : {};
  const options = isObject(claudeCode.options) ? claudeCode.options : {};
  const added = {};
  for (const [key, value] of Object.entries(defaults)) if (options[key] === undefined) added[key] = value;
  if (sandbox !== null && options.sandbox === undefined) {
    const roots = Array.isArray(msg.params.additionalDirectories)
      ? msg.params.additionalDirectories.filter((root) => typeof root === "string" && root !== "")
      : [];
    added.sandbox = roots.length > 0 ? { ...sandbox, filesystem: { allowWrite: roots } } : sandbox;
  }
  if (Object.keys(added).length === 0) return msg;
  return {
    ...msg,
    params: {
      ...msg.params,
      _meta: { ...meta, claudeCode: { ...claudeCode, options: { ...options, ...added } } },
    },
  };
}

/** The sandbox alone (no other options), for a session request; see withSessionOptions. */
export function withSandbox(msg, sandbox) {
  return sandbox === null ? msg : withSessionOptions(msg, { sandbox, options: {} });
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
