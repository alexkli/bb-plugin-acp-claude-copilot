// bb -> agent session rewrites for claude-bedrock-acp-proxy.mjs: bb's
// permission mode and the Bash sandbox. Pure functions, so they can be tested
// without a running agent.

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
 * Adds the sandbox to a session request's `_meta.claudeCode.options`, which
 * claude-agent-acp passes to the Agent SDK. The session's extra workspace
 * roots (bb's `additionalDirectories`, e.g. thread storage) stay writable.
 * Options the client already set win. Other messages are returned unchanged.
 *
 * @param {any} msg a bb -> agent JSON-RPC message
 * @param {object | null} sandbox from sandboxFor
 */
export function withSandbox(msg, sandbox) {
  if (sandbox === null || !SESSION_STARTS.has(msg?.method) || !isObject(msg.params)) return msg;
  const meta = isObject(msg.params._meta) ? msg.params._meta : {};
  const claudeCode = isObject(meta.claudeCode) ? meta.claudeCode : {};
  const options = isObject(claudeCode.options) ? claudeCode.options : {};
  if (options.sandbox !== undefined) return msg;
  const roots = Array.isArray(msg.params.additionalDirectories)
    ? msg.params.additionalDirectories.filter((root) => typeof root === "string" && root !== "")
    : [];
  const configured = roots.length > 0 ? { ...sandbox, filesystem: { allowWrite: roots } } : sandbox;
  return {
    ...msg,
    params: {
      ...msg.params,
      _meta: { ...meta, claudeCode: { ...claudeCode, options: { ...options, sandbox: configured } } },
    },
  };
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
