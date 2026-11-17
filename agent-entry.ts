import type { BbPluginApi } from "@get-bb/plugin-sdk";

// The agent entry this plugin keeps in bb's ACP agents plugin (provider-acp),
// setting "customAgents": a JSON array of custom agents. bb derives the
// provider id "acp-<id>" from the entry id, so "claude-copilot" gives
// "acp-claude-copilot", which threads and the usage entry use.
export const ACP_PLUGIN_ID = "provider-acp";
export const AGENT_ID = "claude-copilot";
export const PROVIDER_ID = `acp-${AGENT_ID}`;
export const DISPLAY_NAME = "Claude Code (Copilot ACP)";

const SETTINGS_READY_ATTEMPTS = 10;
const SETTINGS_READY_DELAY_MS = 500;

type JsonObject = Record<string, unknown>;
export type CustomAgent = JsonObject & { id?: unknown; env?: unknown };

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseCustomAgents(value: unknown): CustomAgent[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") throw new Error(`${ACP_PLUGIN_ID} customAgents must be a string`);
  if (value.trim() === "") return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${ACP_PLUGIN_ID} customAgents must be a JSON array; refusing to overwrite it`);
  return parsed as CustomAgent[];
}

/** Env variables this plugin owns in the entry; set from the plugin settings, removed when unset. */
export const MANAGED_ENV = [
  "CLAUDE_COPILOT_DATA_DIR",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_COPILOT_ALL_MODELS",
  "CLAUDE_AGENT_ACP",
  "CLAUDE_COPILOT_SANDBOX",
] as const;
export type ManagedEnv = Partial<Record<(typeof MANAGED_ENV)[number], string>>;

/**
 * bb's permission mode, passed to the launcher on every start (bb restarts the
 * agent when a thread's mode changes). The proxy turns on the Bash sandbox in
 * Accept Edits, as bb's Claude Code provider does; see bin/acp-session.mjs.
 */
export const PERMISSION_CLI = {
  full: ["--bb-permission-mode=full"],
  workspaceWrite: ["--bb-permission-mode=accept-edits"],
};

/**
 * The managed entry: our command, name, env and capabilities; the user's other
 * env and fields are kept.
 */
export function managedAgent(launcher: string, managedEnv: ManagedEnv, existing?: CustomAgent): CustomAgent {
  const env: Record<string, unknown> = { ...(isObject(existing?.env) ? existing.env : {}) };
  for (const name of MANAGED_ENV) delete env[name];
  for (const [name, value] of Object.entries(managedEnv)) if (value) env[name] = value;
  return {
    nativeSkillRoots: { user: [".claude/skills"], project: [".claude/skills"] },
    ...(existing ?? {}),
    id: AGENT_ID,
    displayName: DISPLAY_NAME,
    command: launcher,
    args: [],
    env,
    permissionCli: PERMISSION_CLI,
    // claude-agent-acp runs Claude Code's /compact
    supportsManualCompaction: true,
  };
}

/** The customAgents list with our entry added or updated; null when it is already current. */
export function withManagedAgent(agents: CustomAgent[], launcher: string, managedEnv: ManagedEnv): CustomAgent[] | null {
  const index = agents.findIndex((agent) => agent.id === AGENT_ID);
  const next = managedAgent(launcher, managedEnv, index >= 0 ? agents[index] : undefined);
  if (index >= 0 && JSON.stringify(agents[index]) === JSON.stringify(next)) return null;
  return index >= 0 ? agents.map((agent, i) => (i === index ? next : agent)) : [...agents, next];
}

/** The customAgents list without our entry; null when it has none. */
export function withoutManagedAgent(agents: CustomAgent[]): CustomAgent[] | null {
  const next = agents.filter((agent) => agent.id !== AGENT_ID);
  return next.length === agents.length ? null : next;
}

/** Our entry in the ACP agents plugin's settings, or null when that plugin's settings can't be read. */
export async function readCurrentEntry(bb: BbPluginApi): Promise<{ entry: CustomAgent | undefined } | null> {
  const agents = await readAgents(bb);
  return agents === null ? null : { entry: agents.find((agent) => agent.id === AGENT_ID) };
}

async function writeAgents(bb: BbPluginApi, agents: CustomAgent[]): Promise<void> {
  await bb.sdk.plugins.updateSettings({
    pluginId: ACP_PLUGIN_ID,
    values: { customAgents: agents.length === 0 ? "" : `${JSON.stringify(agents, null, 2)}\n` },
  });
}

async function readAgents(bb: BbPluginApi): Promise<CustomAgent[] | null> {
  try {
    const settings = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
    return parseCustomAgents(settings.values.customAgents);
  } catch (error) {
    bb.log.warn(`Could not read ${ACP_PLUGIN_ID} customAgents: ${String(error)}`);
    return null;
  }
}

/**
 * Add or update the agent entry so it runs this plugin's launcher. Runs on every
 * load and settings change: a git or marketplace install lives in a folder named
 * after the commit, so the launcher path changes with each update. Leaves other
 * agents alone and writes nothing when the entry is already current.
 */
export async function provisionAgent(bb: BbPluginApi, launcher: string, managedEnv: ManagedEnv): Promise<boolean> {
  let agents: CustomAgent[] | null = null;
  // the ACP agents plugin may load after this one
  for (let attempt = 0; attempt < SETTINGS_READY_ATTEMPTS && agents === null; attempt += 1) {
    agents = await readAgents(bb);
    if (agents === null) await new Promise((resolve) => setTimeout(resolve, SETTINGS_READY_DELAY_MS));
  }
  if (agents === null) throw new Error(`the ${ACP_PLUGIN_ID} plugin's settings are not available`);

  const updated = withManagedAgent(agents, launcher, managedEnv);
  if (updated === null) return false;
  await writeAgents(bb, updated);
  bb.log.info(`Updated the ${DISPLAY_NAME} (${AGENT_ID}) agent entry`);
  return true;
}

/**
 * Removes our entry from the ACP agents plugin's settings, leaving other agents
 * alone. bb has no uninstall hook, so `bb acp-claude-copilot unregister` runs
 * this before the plugin is removed; the next load or settings change adds the
 * entry again.
 */
export async function unregisterAgent(bb: BbPluginApi): Promise<boolean> {
  const agents = await readAgents(bb);
  if (agents === null) throw new Error(`the ${ACP_PLUGIN_ID} plugin's settings are not available`);
  const updated = withoutManagedAgent(agents);
  if (updated === null) return false;
  await writeAgents(bb, updated);
  bb.log.info(`Removed the ${DISPLAY_NAME} (${AGENT_ID}) agent entry`);
  return true;
}
