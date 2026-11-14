import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DISPLAY_NAME, PROVIDER_ID, provisionAgent } from "./agent-entry";
import {
  apiGet,
  copilotApiMain,
  copilotEnv,
  ensure,
  isSignedIn,
  listModels,
  paths,
  prepareHome,
  proxyStatus,
  stop,
  type ProxyStatus,
} from "./bin/copilot-api.mjs";
import { appContract, type AppStatus, type LoginStatus } from "./contract";

// Claude Code on GitHub Copilot as a bb ACP agent:
// - registers the agent (id "claude-copilot", provider "acp-claude-copilot") in
//   bb's ACP agents plugin, pointing at this plugin's own bin/claude-copilot-acp,
//   on every load (the install folder changes with each plugin update);
// - passes the plugin settings (models, adapter) and the data folder to that
//   agent through the entry's env;
// - runs GitHub sign-in (copilot-api's device flow) and start/stop of the
//   plugin's own copilot-api for the settings section and `bb acp-claude-copilot`;
//   the agent starts copilot-api itself when a thread needs it;
// - publishes the Copilot premium-request quota for bb's Provider usage panel.
const PLUGIN_ID = "acp-claude-copilot";
const PACKAGE_NAME = "bb-plugin-acp-claude-copilot";
const LIST_RESOURCES = "provider-usage.v1.listResources";
const GET_RESOURCE = "provider-usage.v1.getResource";
const USAGE_CACHE_KEY = "lastUsage";

// -- Provider usage contract (bb's provider-usage plugin discovers it) -------------

const usageWindow = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() }).nullable(),
});
const usageCommon = { plan: z.null(), accountEmail: z.string().nullable(), planLabel: z.string().nullable() };
const usageState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), ...usageCommon, windows: z.array(usageWindow) }),
  z.object({ status: z.literal("error"), ...usageCommon, message: z.string() }),
]);
type UsageResult = { accountKey: string | null; observedAt: number | null; usage: z.infer<typeof usageState> };

export const usageRpcContract = defineRpcContract({
  [LIST_RESOURCES]: {
    input: z.object({}),
    output: z.object({
      resources: z.array(
        z.object({
          accountKey: z.string().min(1).nullable(),
          id: z.string().min(1),
          providerId: z.string().min(1),
          label: z.string().min(1),
          scope: z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
        }),
      ),
    }),
  },
  [GET_RESOURCE]: {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: z.object({
      accountKey: z.string().min(1).nullable(),
      observedAt: z.number().int().nonnegative().nullable(),
      usage: usageState,
    }),
  },
});

const copilotUsageSchema = z.object({
  login: z.string().optional(),
  copilot_plan: z.string().optional(),
  quota_reset_date_utc: z.string().optional(),
  quota_snapshots: z
    .record(
      z.string(),
      z.object({
        unlimited: z.boolean().optional(),
        percent_remaining: z.number().optional(),
        entitlement: z.number().optional(),
        remaining: z.number().optional(),
        credits_used: z.number().optional(),
        token_based_billing: z.boolean().optional(),
      }),
    )
    .optional(),
});
type CopilotUsage = z.infer<typeof copilotUsageSchema>;
type CachedUsage = { observedAt: number; usage: CopilotUsage };

function capitalized(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

/**
 * USD cents per unit of the premium quota. With token-based billing the quota
 * is in AI credits of $0.01; request-based quotas use the list price of a
 * premium request ($0.04).
 */
function centsPerUnit(tokenBased: boolean | undefined): number {
  return tokenBased ? 1 : 4;
}

export function usageWindows(usage: CopilotUsage): z.infer<typeof usageWindow>[] {
  const premium = usage.quota_snapshots?.premium_interactions;
  if (!premium || premium.unlimited || premium.percent_remaining === undefined) return [];
  const used = Math.max(0, 100 - premium.percent_remaining);
  const { entitlement, remaining } = premium;
  // bb's usage card shows amounts only as USD, so the quota is shown in dollars
  const usedUnits = premium.credits_used ?? (entitlement !== undefined && remaining !== undefined ? entitlement - remaining : undefined);
  const cents = centsPerUnit(premium.token_based_billing);
  const cost =
    entitlement !== undefined && entitlement > 0 && usedUnits !== undefined
      ? { usedUsdCents: Math.max(0, usedUnits) * cents, limitUsdCents: entitlement * cents }
      : null;
  return [
    {
      kind: "custom",
      id: "premium",
      label: "Premium",
      usedPercent: Math.round(used * 10) / 10,
      resetsAt: usage.quota_reset_date_utc ?? null,
      model: null,
      cost,
    },
  ];
}

// -- Local paths -------------------------------------------------------------------

/** This plugin's root: the nearest folder up from the bundle with our package.json. */
function findPluginDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && readFileSync(manifest, "utf8").includes(`"${PACKAGE_NAME}"`)) return dir;
    dir = dirname(dir);
  }
  throw new Error(`${PACKAGE_NAME}: could not find the plugin folder from ${fileURLToPath(import.meta.url)}`);
}

/**
 * The node that runs copilot-api when the server starts it: the one on PATH,
 * as the agent's launcher uses, else the runtime bb runs this plugin in
 * (copilotEnv sets ELECTRON_RUN_AS_NODE for bb's Electron binary).
 */
function findNode(): string {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of new Set(dirs)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === "win32" ? "node.exe" : "node");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return process.execPath;
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultModel: {
      type: "string",
      label: "Default model",
      description:
        "Copilot model for new threads (ANTHROPIC_MODEL), e.g. claude-opus-5-5 or my-claude-gpt-5 for a non-Claude model. Empty: Claude Code's default.",
      default: "claude-opus-5-5",
    },
    opusModel: {
      type: "string",
      label: "Opus model",
      description: "Copilot model behind Claude Code's opus alias (ANTHROPIC_DEFAULT_OPUS_MODEL).",
      default: "claude-opus-5-5",
    },
    sonnetModel: {
      type: "string",
      label: "Sonnet model",
      description: "Copilot model behind Claude Code's sonnet alias (ANTHROPIC_DEFAULT_SONNET_MODEL).",
      default: "claude-sonnet-5-5",
    },
    haikuModel: {
      type: "string",
      label: "Haiku model",
      description: "Copilot model behind Claude Code's haiku alias and background tasks (ANTHROPIC_DEFAULT_HAIKU_MODEL).",
      default: "claude-haiku-5-5",
    },
    allModels: {
      type: "boolean",
      label: "All Copilot models in the picker",
      description:
        "List every Copilot chat model (GPT, Gemini, Grok, ...) in the model picker, not only Claude Code's own. Applies to new threads.",
      default: true,
    },
    adapterCommand: {
      type: "string",
      label: "ACP adapter command",
      description:
        "Optional command that runs @agentclientprotocol/claude-agent-acp, e.g. a pinned install. Default: claude-agent-acp on PATH, else npx.",
    },
  });

  const pluginDir = findPluginDir();
  const launcher = join(pluginDir, "bin", "claude-copilot-acp");
  const node = findNode();

  async function dataDir(): Promise<string> {
    let root = process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) root = config.dataDir;
    } catch {
      // keep the default
    }
    return join(root, "plugins", PLUGIN_ID, "host-data");
  }

  // -- Agent entry -------------------------------------------------------------

  let syncing = Promise.resolve();
  const sync = () => {
    syncing = syncing
      .then(async () => {
        const s = await settings.get();
        await provisionAgent(bb, launcher, {
          CLAUDE_COPILOT_DATA_DIR: await dataDir(),
          ANTHROPIC_MODEL: s.defaultModel?.trim(),
          ANTHROPIC_DEFAULT_OPUS_MODEL: s.opusModel?.trim(),
          ANTHROPIC_DEFAULT_SONNET_MODEL: s.sonnetModel?.trim(),
          ANTHROPIC_DEFAULT_HAIKU_MODEL: s.haikuModel?.trim(),
          CLAUDE_COPILOT_ALL_MODELS: s.allModels === false ? "0" : undefined,
          CLAUDE_AGENT_ACP: s.adapterCommand?.trim(),
        });
      })
      .catch((error: unknown) => {
        bb.log.error(`Could not update the ${DISPLAY_NAME} agent entry: ${String(error)}`);
      });
  };
  sync();
  settings.onChange(() => sync());

  // -- copilot-api --------------------------------------------------------------

  const start = async (): Promise<ProxyStatus> => ensure({ dataDir: await dataDir(), pluginDir, node });

  /** copilot-api's /usage, when it runs (or, with `startIt`, after starting it). */
  async function readCopilotUsage(startIt: boolean): Promise<CachedUsage | null> {
    const status = startIt ? await start() : await proxyStatus(await dataDir());
    if (!status.running) return null;
    const parsed = copilotUsageSchema.safeParse(await apiGet(status, "/usage"));
    if (!parsed.success) throw new Error("Unexpected /usage response from copilot-api.");
    const cached = { observedAt: Date.now(), usage: parsed.data };
    await bb.storage.kv.set(USAGE_CACHE_KEY, cached);
    return cached;
  }

  // GitHub sign-in: copilot-api's own device flow
  let login: LoginStatus = { state: "idle", userCode: null, url: null, message: null };
  let loginProc: ChildProcess | null = null;

  async function startLogin(): Promise<LoginStatus> {
    if (loginProc && loginProc.exitCode === null && login.userCode) return login;
    const { home } = await prepareHome(await dataDir());
    login = { state: "waiting", userCode: null, url: null, message: null };
    const proc = spawn(node, [copilotApiMain(pluginDir), "auth", "login", "--provider=copilot"], {
      env: copilotEnv(home),
      stdio: ["ignore", "pipe", "pipe"],
    });
    loginProc = proc;
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /enter the code "([^"]+)" in (\S+)/.exec(output);
      if (match && !login.userCode) login = { ...login, userCode: match[1] ?? null, url: match[2] ?? null };
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (error) => {
      login = { state: "failed", userCode: null, url: null, message: String(error) };
    });
    proc.on("exit", (code) => {
      if (loginProc === proc) loginProc = null;
      login =
        code === 0 && isSignedIn(home)
          ? { state: "succeeded", userCode: null, url: null, message: "Signed in to GitHub Copilot." }
          : { state: "failed", userCode: null, url: null, message: output.trim().split("\n").slice(-5).join("\n") || `exit ${code}` };
    });
    for (let i = 0; i < 40 && !login.userCode && proc.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return login;
  }

  async function signOut(): Promise<boolean> {
    const dir = await dataDir();
    await stop(dir);
    loginProc?.kill("SIGTERM");
    const token = join(paths(dir).home, "github_token");
    const existed = existsSync(token);
    await rm(token, { force: true });
    await bb.storage.kv.delete(USAGE_CACHE_KEY);
    login = { state: "idle", userCode: null, url: null, message: null };
    return existed;
  }

  async function appStatus(): Promise<AppStatus> {
    const dir = await dataDir();
    try {
      const status = await proxyStatus(dir);
      const cached = (await bb.storage.kv.get<CachedUsage>(USAGE_CACHE_KEY)) ?? null;
      const usage = status.running ? ((await readCopilotUsage(false).catch(() => null)) ?? cached) : cached;
      const models = status.running ? await listModels(dir, status).catch(() => []) : [];
      return {
        running: status.running,
        signedIn: status.signedIn,
        port: status.port,
        home: status.home,
        log: paths(dir).log,
        account: status.signedIn ? (usage?.usage.login ?? null) : null,
        plan: status.signedIn && usage?.usage.copilot_plan ? `Copilot ${capitalized(usage.usage.copilot_plan)}` : null,
        models: models.length,
        login,
        error: status.error,
      };
    } catch (cause) {
      return {
        running: false,
        signedIn: false,
        port: null,
        home: null,
        log: null,
        account: null,
        plan: null,
        models: 0,
        login,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  bb.rpc.register(appContract, {
    status: () => appStatus(),
    startLogin: async () => {
      await startLogin();
      return appStatus();
    },
    signOut: async () => {
      await signOut();
      return appStatus();
    },
    start: async () => {
      const status = await start();
      const result = await appStatus();
      return status.error && !status.running ? { ...result, error: status.error } : result;
    },
    stop: async () => {
      await stop(await dataDir());
      await new Promise((r) => setTimeout(r, 300));
      return appStatus();
    },
  });

  // -- Provider usage entry ----------------------------------------------------------

  bb.rpc.register(
    usageRpcContract,
    {
      [LIST_RESOURCES]: async () => {
        // copilot-api runs on this machine: publish it for the bb server's own host
        const [hosts, config] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.system.config().catch(() => null)]);
        const connected = hosts.filter((host) => host.status === "connected");
        const host = connected.find((h) => h.id === config?.primaryHostId) ?? connected[0];
        return {
          resources:
            host === undefined
              ? []
              : [
                  {
                    accountKey: null,
                    id: host.id,
                    providerId: PROVIDER_ID,
                    label: DISPLAY_NAME,
                    scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
                  },
                ],
        };
      },
      [GET_RESOURCE]: async ({ refresh }): Promise<UsageResult> => {
        const meta = { plan: null, accountEmail: null };
        let fresh: CachedUsage | null = null;
        let error: string | null = null;
        try {
          // a refresh (user action) may start copilot-api; background polls never do
          fresh = await readCopilotUsage(refresh);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        const cached = fresh ?? (await bb.storage.kv.get<CachedUsage>(USAGE_CACHE_KEY)) ?? null;
        if (!cached) {
          return {
            accountKey: null,
            observedAt: null,
            usage: { status: "error", ...meta, planLabel: null, message: error ?? "copilot-api is not running. Refresh to start it." },
          };
        }
        return {
          accountKey: cached.usage.login ?? null,
          observedAt: cached.observedAt,
          usage: {
            status: "ok",
            ...meta,
            planLabel: cached.usage.copilot_plan ? capitalized(cached.usage.copilot_plan) : null,
            windows: usageWindows(cached.usage),
          },
        };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description: `Publishes the GitHub Copilot premium-request quota for ${DISPLAY_NAME}.`,
    },
  );

  // -- CLI -----------------------------------------------------------------------------

  const usage = [
    `bb ${PLUGIN_ID} status   Show the plugin's copilot-api state`,
    `bb ${PLUGIN_ID} login    Sign in to GitHub Copilot (device code)`,
    `bb ${PLUGIN_ID} logout   Sign out of GitHub Copilot`,
    `bb ${PLUGIN_ID} start    Start copilot-api`,
    `bb ${PLUGIN_ID} stop     Stop copilot-api`,
  ].join("\n");

  const show = (s: AppStatus) =>
    [
      `copilot-api: ${s.running ? `running on 127.0.0.1:${s.port}` : "stopped"}`,
      `GitHub:      ${s.signedIn ? `signed in${s.account ? ` as ${s.account}` : ""}${s.plan ? ` (${s.plan})` : ""}` : `not signed in (run: bb ${PLUGIN_ID} login)`}`,
      ...(s.running ? [`models:      ${s.models}`] : []),
      `home:        ${s.home ?? "unknown"}`,
      `log:         ${s.log ?? "unknown"}`,
      ...(s.error ? [`error:       ${s.error}`] : []),
    ].join("\n");

  bb.cli.register({
    name: PLUGIN_ID,
    summary: `Manage the ${DISPLAY_NAME} agent's copilot-api`,
    commands: [
      { name: "status", summary: "Show copilot-api state", usage: `bb ${PLUGIN_ID} status` },
      { name: "login", summary: "Sign in to GitHub Copilot", usage: `bb ${PLUGIN_ID} login` },
      { name: "logout", summary: "Sign out of GitHub Copilot", usage: `bb ${PLUGIN_ID} logout` },
      { name: "start", summary: "Start copilot-api", usage: `bb ${PLUGIN_ID} start` },
      { name: "stop", summary: "Stop copilot-api", usage: `bb ${PLUGIN_ID} stop` },
    ],
    async run(argv) {
      const [command] = argv;
      switch (command) {
        case "status":
          return { exitCode: 0, stdout: show(await appStatus()) };
        case "start": {
          const status = await start();
          return { exitCode: status.running ? 0 : 1, stdout: show({ ...(await appStatus()), error: status.error }) };
        }
        case "stop":
          return { exitCode: 0, stdout: (await stop(await dataDir())) ? "Stopped." : "Not running." };
        case "logout":
          return { exitCode: 0, stdout: (await signOut()) ? "Signed out." : "Was not signed in." };
        case "login": {
          const state = await startLogin();
          if (state.userCode && state.url) {
            return { exitCode: 0, stdout: `Open ${state.url} and enter the code ${state.userCode}\nThen run: bb ${PLUGIN_ID} status` };
          }
          return { exitCode: 1, stderr: state.message ?? "Could not start the GitHub sign-in." };
        }
        default:
          return { exitCode: command ? 1 : 0, stdout: usage };
      }
    },
  });
}
