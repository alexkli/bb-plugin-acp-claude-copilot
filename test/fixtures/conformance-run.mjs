// Runs bb's provider bridge conformance suite against this plugin's provider
// as bb runs it (the SDK's ACP bridge with the declaration's launch spec,
// starting bin/claude-copilot-acp and its proxy), with a fake adapter in place
// of claude-agent-acp. Its own process, because the suite captures stdout.
// Usage: node conformance-run.mjs <scratch dir> <report.json>
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_acpProviderBridge as bridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { PROVIDER_ID, launchSpec } from "../../provider.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [dir, reportFile] = process.argv.slice(2);
const state = join(dir, "state");
const envFile = join(dir, "agent.env");
writeFileSync(
  envFile,
  [
    `export CLAUDE_AGENT_ACP='${process.execPath} ${join(root, "test", "fixtures", "fake-acp-adapter.mjs")}'`,
    // no CLAUDE_COPILOT_DATA_DIR: the proxy then uses no copilot-api
    `export XDG_STATE_HOME='${state}'`,
    "",
  ].join("\n"),
);
const workspace = mkdtempSync(join(dir, "workspace-"));

const output = captureBridgeJsonRpcOutput();
const report = await runBridgeConformance({
  transport: { send: bridge.handleLine, takeMessages: output.takeMessages },
  providerId: PROVIDER_ID,
  session: {
    cwd: workspace,
    promptInput: [{ type: "text", text: "say hello", mentions: [] }],
    zeroWorkPromptInput: [{ type: "text", text: "/compact", mentions: [] }],
    interruptiblePromptInput: [{ type: "text", text: "hang", mentions: [] }],
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
      providerOptions: { acpLaunchSpec: launchSpec(join(root, "bin", "claude-copilot-acp"), envFile) },
    },
  },
  timeoutMs: 15_000,
});
output.restore();
writeFileSync(reportFile, JSON.stringify({ report, text: formatConformanceReport(report) }));
bridge.onClose?.();
process.exit(0);
