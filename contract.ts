import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const loginStatusSchema = z.object({
  state: z.enum(["idle", "waiting", "succeeded", "failed"]),
  userCode: z.string().nullable(),
  url: z.string().nullable(),
  message: z.string().nullable(),
});
export type LoginStatus = z.infer<typeof loginStatusSchema>;

export const appStatusSchema = z.object({
  running: z.boolean(),
  signedIn: z.boolean(),
  port: z.number().int().nullable(),
  home: z.string().nullable(),
  log: z.string().nullable(),
  account: z.string().nullable(),
  plan: z.string().nullable(),
  models: z.number().int().nonnegative(),
  login: loginStatusSchema,
  error: z.string().nullable(),
});
export type AppStatus = z.infer<typeof appStatusSchema>;

/** The plugin's settings, kept by the plugin itself (bb.storage.kv) and edited in its settings section. */
export const acpSettingsSchema = z.object({
  defaultModel: z.string(),
  opusModel: z.string(),
  sonnetModel: z.string(),
  haikuModel: z.string(),
  allModels: z.boolean(),
  adapterCommand: z.string(),
});
export type AcpSettings = z.infer<typeof acpSettingsSchema>;

export const copilotModelSchema = z.object({
  id: z.string(),
  upstreamId: z.string(),
  displayName: z.string(),
  vendor: z.string().nullable(),
  contextWindow: z.number().nullable(),
});
export type CopilotModel = z.infer<typeof copilotModelSchema>;

export const settingsViewSchema = z.object({
  settings: acpSettingsSchema,
  /** Copilot's chat models (cached list while copilot-api is stopped). */
  models: z.array(copilotModelSchema),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

export const apiResponseSchema = z.object({
  status: z.number().int(),
  contentType: z.string(),
  body: z.string(),
});
export type ApiResponse = z.infer<typeof apiResponseSchema>;

export const instanceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  home: z.string().min(1),
  own: z.boolean(),
  /** Port of a running copilot-api process using this home, if known. */
  port: z.number().int().nullable(),
});
export type Instance = z.infer<typeof instanceSchema>;

export const sessionUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  /** AI credits (1 credit = $0.01); copilot-api's total_nano_aiu / 1e9. */
  credits: z.number().nonnegative(),
  /** Requests without a reported credit amount (counted, not priced). */
  unpriced: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  models: z.array(z.object({ model: z.string(), requests: z.number().int().nonnegative(), credits: z.number().nonnegative() })),
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
});
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

/** Claude Code session ids are UUIDs; the ACP adapter runs Claude Code under the ACP session id. */
export const claudeSessionIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const sessionCreditsSchema = z.discriminatedUnion("status", [
  /** Not a Claude Code (Copilot ACP) thread: show nothing. */
  z.object({ status: z.literal("unsupported") }),
  /** No session yet (thread not started). */
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("ok"), sessionId: z.string(), usage: sessionUsageSchema }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type SessionCredits = z.infer<typeof sessionCreditsSchema>;

const none = z.null();

/** App (settings section, usage page) <-> server. */
export const appContract = defineRpcContract({
  status: { input: none, output: appStatusSchema },
  startLogin: { input: none, output: appStatusSchema },
  signOut: { input: none, output: appStatusSchema },
  start: { input: none, output: appStatusSchema },
  stop: { input: none, output: appStatusSchema },
  restart: { input: none, output: appStatusSchema },
  getSettings: { input: none, output: settingsViewSchema },
  setSettings: { input: acpSettingsSchema.partial(), output: settingsViewSchema },
  getConfig: { input: none, output: z.object({ json: z.string() }) },
  setConfig: { input: z.object({ json: z.string() }), output: z.object({ reloaded: z.boolean(), message: z.string().nullable() }) },
  listInstances: { input: none, output: z.object({ instances: z.array(instanceSchema) }) },
  sessionCredits: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: sessionCreditsSchema },
});
