import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PERMISSION_CLI, PROVIDER_ID, envFileContent, isTakenError, parseExtraEnv, providerDeclaration } from "../provider.ts";
import { registerWithHandover } from "../server.ts";

test("the provider keeps the id provider-acp derived from the old entry, and adds forks", () => {
  const d = providerDeclaration("/p/bin/claude-copilot-acp", "/data/agent.env");
  assert.equal(d.id, PROVIDER_ID);
  assert.equal(PROVIDER_ID, "acp-claude-copilot");
  assert.equal(d.family, "acp");
  assert.equal(d.capabilities.fork, "tip");
  assert.equal(d.capabilities.supportsManualCompaction, true);
  assert.deepEqual(d.capabilities.permissionModes, ["accept-edits", "full"]);
  assert.deepEqual(d.experimental_bridgeOptions, {
    acpLaunchSpec: {
      displayName: "Claude Code (Copilot ACP)",
      command: "/p/bin/claude-copilot-acp",
      args: [],
      env: { CLAUDE_COPILOT_ENV_FILE: "/data/agent.env" },
      permissionCli: PERMISSION_CLI,
      nativeSkillRoots: { user: [".claude/skills"], project: [".claude/skills"] },
    },
  });
});

test("the launch spec is one the SDK's ACP bridge accepts", async () => {
  const { experimental_acpLaunchSpecSchema } = await import("@get-bb/plugin-sdk/provider-bridge/acp");
  const spec = providerDeclaration("/p/bin/claude-copilot-acp", "/data/agent.env").experimental_bridgeOptions.acpLaunchSpec;
  assert.equal(experimental_acpLaunchSpecSchema.safeParse(spec).success, true);
});

test("envFileContent: a shell file the launcher can source, values quoted, unset ones left out", () => {
  const text = envFileContent({ AWS_REGION: "us-west-2", AWS_PROFILE: undefined, CLAUDE_AGENT_ACP: "node '/a b/x.js'", EMPTY: "" });
  assert.doesNotMatch(text, /AWS_PROFILE|EMPTY/);
  const dir = mkdtempSync(join(tmpdir(), "copilot-env-"));
  writeFileSync(join(dir, "agent.env"), text);
  const out = execFileSync("bash", ["-c", `source "${join(dir, "agent.env")}"; printf '%s|%s' "$AWS_REGION" "$CLAUDE_AGENT_ACP"`], { encoding: "utf8" });
  assert.equal(out, "us-west-2|node '/a b/x.js'");
  assert.throws(() => envFileContent({ "BAD NAME": "x" }), /invalid environment variable name/);
});

test("parseExtraEnv reads NAME=value pairs and refuses anything else", () => {
  assert.deepEqual(parseExtraEnv(" A=1  B_2=x=y\nC= "), { A: "1", B_2: "x=y", C: "" });
  assert.deepEqual(parseExtraEnv(undefined), {});
  assert.throws(() => parseExtraEnv("nope"), /not NAME=value/);
});

const taken = () => {
  throw new Error('Provider "acp-claude-copilot" is already registered; a plugin cannot shadow an existing provider.');
};

test("handover: registers at once when the id is free", async () => {
  let removed = 0;
  const r = await registerWithHandover({ register: () => ({ dispose() {} }), removeLegacyEntry: async () => (removed++, false), sleep: async () => {} });
  assert.equal(r.handedOver, false);
  assert.equal(removed, 0);
});

test("handover: removes the old entry once, then retries until provider-acp has dropped the id", async () => {
  let held = true;
  let calls = 0;
  let removed = 0;
  const r = await registerWithHandover({
    register: () => {
      calls++;
      if (held) taken();
      return { dispose() {} };
    },
    removeLegacyEntry: async () => {
      removed++;
      setTimeout(() => (held = false), 0);
      return true;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.equal(r.handedOver, true);
  assert.equal(removed, 1);
  assert.ok(calls >= 2);
});

test("handover: gives up with a reason when the id stays taken", async () => {
  await assert.rejects(
    registerWithHandover({ register: taken, removeLegacyEntry: async () => true, sleep: async () => {}, attempts: 3 }),
    /provider-acp still holds the provider acp-claude-copilot/,
  );
  await assert.rejects(
    registerWithHandover({ register: taken, removeLegacyEntry: async () => false, sleep: async () => {}, attempts: 3 }),
    /registered by another plugin/,
  );
  await assert.rejects(
    registerWithHandover({ register: () => { throw new Error("invalid provider id"); }, removeLegacyEntry: async () => true, sleep: async () => {} }),
    /invalid provider id/,
  );
  assert.equal(isTakenError(new Error("x")), false);
});
