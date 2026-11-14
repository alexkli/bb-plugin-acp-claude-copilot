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

const none = z.null();

/** App (settings section) <-> server. */
export const appContract = defineRpcContract({
  status: { input: none, output: appStatusSchema },
  startLogin: { input: none, output: appStatusSchema },
  signOut: { input: none, output: appStatusSchema },
  start: { input: none, output: appStatusSchema },
  stop: { input: none, output: appStatusSchema },
});
