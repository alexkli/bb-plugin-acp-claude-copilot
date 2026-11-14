// Type declarations for copilot-api.mjs (plain Node, shared by the proxy and server.ts).

export type ProxyState = { port: number; apiKey: string; adminKey: string };

export type ProxyStatus = {
  running: boolean;
  signedIn: boolean;
  port: number;
  apiKey: string;
  home: string;
  error: string | null;
};

export type CopilotModel = {
  /** Model id Claude Code sends (copilot-api convention: my-claude- prefix, [1m] suffix). */
  id: string;
  /** Copilot's own model id. */
  upstreamId: string;
  displayName: string;
  vendor: string | null;
  contextWindow: number | null;
};

export function paths(dataDir: string): {
  home: string;
  state: string;
  pid: string;
  lock: string;
  log: string;
  models: string;
};
export function copilotApiMain(pluginDir: string): string;
export function copilotEnv(home: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function freePort(): Promise<number>;
export function prepareHome(dataDir: string): Promise<{ home: string; state: ProxyState }>;
export function isSignedIn(home: string): boolean;
export function healthy(state: Pick<ProxyState, "port" | "apiKey">, timeoutMs?: number): Promise<boolean>;
export function acquireLock(file: string, now?: number): Promise<{ release: () => Promise<void> } | null>;
export function ensure(options: { dataDir: string; pluginDir: string; node?: string; env?: NodeJS.ProcessEnv }): Promise<ProxyStatus>;
export function proxyStatus(dataDir: string): Promise<ProxyStatus>;
export function stop(dataDir: string): Promise<boolean>;
export function apiGet(state: Pick<ProxyState, "port" | "apiKey">, path: string, timeoutMs?: number): Promise<unknown>;
export function toCopilotModels(body: unknown): CopilotModel[];
export function listModels(
  dataDir: string,
  state: Pick<ProxyState, "port" | "apiKey">,
  options?: { force?: boolean },
): Promise<CopilotModel[]>;
export function modelConfig(models: CopilotModel[]): string | null;
export function modelLabel(model: CopilotModel): string;
