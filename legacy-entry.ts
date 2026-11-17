import { basename } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

// The agent entry earlier versions of this plugin kept in bb's ACP agents
// plugin (provider-acp), setting "customAgents": a JSON array of custom agents.
// provider-acp registered it as the provider "acp-" + id = acp-claude-copilot.
// This plugin now registers that provider itself (provider.ts), and bb lets
// only one plugin hold a provider id, so the handover removes the entry first;
// provider-acp then drops the provider and this plugin registers it.
export const ACP_PLUGIN_ID = "provider-acp";
export const AGENT_ID = "claude-copilot";

type JsonObject = Record<string, unknown>;
export type CustomAgent = JsonObject & { id?: unknown; command?: unknown; env?: unknown };

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

/** Env variables earlier versions set from the plugin settings; any others in the entry were the user's. */
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

/** The user's own variables in an old entry's env, to carry over to the Extra environment variables setting. */
export function userEnv(entry: CustomAgent | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (!isObject(entry?.env)) return env;
  for (const [name, value] of Object.entries(entry.env)) {
    if (!(MANAGED_ENV as readonly string[]).includes(name) && typeof value === "string") env[name] = value;
  }
  return env;
}

/** The launcher's file name; 0.1.x set the entry's command to its absolute path. */
const LAUNCHER_NAME = "claude-copilot-acp";

/** Whether an entry is the one earlier versions of this plugin added: our id, with our launcher as its command. */
export function isOurEntry(agent: CustomAgent): boolean {
  return agent.id === AGENT_ID && typeof agent.command === "string" && basename(agent.command) === LAUNCHER_NAME;
}

/** The customAgents list without our entry; null when it has none. */
export function withoutLegacyEntry(agents: CustomAgent[]): CustomAgent[] | null {
  const next = agents.filter((agent) => !isOurEntry(agent));
  return next.length === agents.length ? null : next;
}

/**
 * The customAgents text for a list, in the formatting of the text it came
 * from: the same indentation (none for a one-line list) and trailing newline.
 */
export function formatCustomAgents(agents: CustomAgent[], original: string): string {
  if (agents.length === 0) return "";
  const indent = /\n([ \t]+)\S/.exec(original)?.[1];
  const text = indent === undefined ? JSON.stringify(agents) : JSON.stringify(agents, null, indent);
  return original.endsWith("\n") ? `${text}\n` : text;
}

/**
 * Our old entry, `{ entry: undefined }` when there is none, or null when the
 * ACP agents plugin's settings can't be read (disabled or not installed:
 * then it holds no provider either).
 */
export async function readLegacyEntry(bb: BbPluginApi): Promise<{ entry: CustomAgent | undefined } | null> {
  try {
    const settings = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
    const agents = parseCustomAgents(settings.values.customAgents);
    return { entry: agents.find(isOurEntry) };
  } catch (error) {
    bb.log.warn(`Could not read ${ACP_PLUGIN_ID} customAgents: ${String(error)}`);
    return null;
  }
}

/**
 * Removes our old entry, leaving other agents and the setting's formatting
 * alone; true when there was one. An entry with our id that this plugin
 * didn't add is the user's: it is kept, and the error says what to do.
 */
export async function removeLegacyEntry(bb: BbPluginApi): Promise<boolean> {
  const settings = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
  const original = typeof settings.values.customAgents === "string" ? settings.values.customAgents : "";
  const agents = parseCustomAgents(settings.values.customAgents);
  const updated = withoutLegacyEntry(agents);
  if (updated === null) {
    if (agents.some((agent) => agent.id === AGENT_ID)) {
      throw new Error(
        `${ACP_PLUGIN_ID} has a custom agent "${AGENT_ID}" that this plugin didn't add, so it holds the provider ${"acp-" + AGENT_ID}; rename or remove that agent in the ACP agents settings`,
      );
    }
    return false;
  }
  await bb.sdk.plugins.updateSettings({ pluginId: ACP_PLUGIN_ID, values: { customAgents: formatCustomAgents(updated, original) } });
  bb.log.info(`Removed the old ${ACP_PLUGIN_ID} customAgents entry "${AGENT_ID}"`);
  return true;
}
