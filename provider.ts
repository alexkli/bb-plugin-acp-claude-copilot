import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";

// The provider this plugin registers itself with bb.providers.register. The id
// is the one bb's ACP agents plugin used to derive from the old customAgents
// entry ("acp-" + "claude-copilot"), so existing threads, which store only
// the provider id, keep working.
export const PROVIDER_ID = "acp-claude-copilot";
export const DISPLAY_NAME = "Claude Code (Copilot ACP)";

/**
 * bb's permission mode, passed to the launcher on every start (bb restarts the
 * agent when a thread's mode changes). The proxy turns on the Bash sandbox in
 * Accept Edits, as bb's Claude Code provider does; see bin/acp-session.mjs.
 */
export const PERMISSION_CLI = {
  full: ["--bb-permission-mode=full"],
  workspaceWrite: ["--bb-permission-mode=accept-edits"],
};

const SKILL_ROOTS = { user: [".claude/skills"], project: [".claude/skills"] };

/**
 * What the bridge launches. The settings don't go in here: the plugin writes
 * them to `envFile`, which the launcher reads on every start, so a settings
 * change applies when a thread's agent next starts and the declaration (and
 * with it bb's bridge process identity and model catalog) stays the same.
 */
export function launchSpec(launcher: string, envFile: string) {
  return {
    displayName: DISPLAY_NAME,
    command: launcher,
    args: [] as string[],
    env: { CLAUDE_COPILOT_ENV_FILE: envFile },
    permissionCli: PERMISSION_CLI,
    nativeSkillRoots: SKILL_ROOTS,
  };
}

/**
 * The provider declaration. It matches what bb's ACP agents plugin declared
 * for the old customAgents entry (family "acp", generic dialect, two
 * permission modes, service tiers, /compact), plus `fork: "tip"`: the
 * adapter supports session/fork, so bb can open side chats and forks.
 */
export function providerDeclaration(launcher: string, envFile: string): PluginProviderDeclaration {
  return {
    id: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    family: "acp",
    strings: {
      signInHint: "Sign in to GitHub Copilot under Settings → Plugins → Claude Copilot ACP provider, or run: bb acp-claude-copilot login",
      expiredHint: "Your GitHub Copilot sign-in expired or was refused. Sign in again under Settings → Plugins → Claude Copilot ACP provider, then send the message again.",
      installUrl: "https://github.com/alexkli/bb-plugin-acp-claude-copilot#setup",
    },
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    experimental_visibility: "always",
    experimental_nativeSkillRoots: SKILL_ROOTS,
    experimental_bridgeOptions: { acpLaunchSpec: launchSpec(launcher, envFile) },
    models: { scope: "host" },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "tip",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    composerActions: [],
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A shell file of `export NAME='value'` lines for the launcher to source; unset values are left out. */
export function envFileContent(env: Readonly<Record<string, string | undefined>>): string {
  const lines = ["# Written by the Claude Copilot ACP provider plugin from its settings; read by bin/claude-copilot-acp."];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    if (!ENV_NAME.test(name)) throw new Error(`invalid environment variable name ${JSON.stringify(name)}`);
    lines.push(`export ${name}='${value.replaceAll("'", `'\\''`)}'`);
  }
  return `${lines.join("\n")}\n`;
}

/** `NAME=value` pairs separated by whitespace or newlines (the Extra environment variables setting). */
export function parseExtraEnv(text: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of (text ?? "").split(/\s+/)) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const name = eq > 0 ? pair.slice(0, eq) : "";
    if (!ENV_NAME.test(name)) throw new Error(`"${pair}" is not NAME=value`);
    env[name] = pair.slice(eq + 1);
  }
  return env;
}

/** Whether an error from bb.providers.register means another plugin still holds the id. */
export function isTakenError(error: unknown): boolean {
  return /already registered/i.test(error instanceof Error ? error.message : String(error));
}
