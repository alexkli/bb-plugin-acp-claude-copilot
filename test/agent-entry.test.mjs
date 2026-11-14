import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_ID, DISPLAY_NAME, PROVIDER_ID, managedAgent, parseCustomAgents, withManagedAgent } from "../agent-entry.ts";

const LAUNCHER = "/plugins/acp-claude-copilot/bin/claude-copilot-acp";

test("the agent is acp-claude-copilot, apart from the Claude Copilot provider plugin's claude-copilot", () => {
  assert.equal(AGENT_ID, "claude-copilot");
  assert.equal(PROVIDER_ID, "acp-claude-copilot");
  assert.equal(DISPLAY_NAME, "Claude Code (Copilot ACP)");
});

test("a new entry runs the launcher with the managed env", () => {
  const entry = managedAgent(LAUNCHER, { CLAUDE_COPILOT_DATA_DIR: "/data", ANTHROPIC_MODEL: "my-claude-gpt-5", CLAUDE_AGENT_ACP: "" });
  assert.deepEqual(entry, {
    nativeSkillRoots: { user: [".claude/skills"], project: [".claude/skills"] },
    id: "claude-copilot",
    displayName: "Claude Code (Copilot ACP)",
    command: LAUNCHER,
    args: [],
    env: { CLAUDE_COPILOT_DATA_DIR: "/data", ANTHROPIC_MODEL: "my-claude-gpt-5" },
  });
});

test("an update keeps the user's env and fields, and drops managed variables that are now unset", () => {
  const existing = {
    id: "claude-copilot",
    displayName: "old",
    command: "/old/path",
    args: ["--x"],
    providerUsage: true,
    env: { MY_VAR: "1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "old-haiku", CLAUDE_COPILOT_ALL_MODELS: "0" },
  };
  const entry = managedAgent(LAUNCHER, { ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5" }, existing);
  assert.equal(entry.command, LAUNCHER);
  assert.deepEqual(entry.args, []);
  assert.equal(entry.providerUsage, true);
  assert.deepEqual(entry.env, { MY_VAR: "1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5" });
});

test("withManagedAgent leaves other agents alone and writes nothing when current", () => {
  const other = { id: "claude-bedrock", command: "/b" };
  const added = withManagedAgent([other], LAUNCHER, { CLAUDE_COPILOT_DATA_DIR: "/data" });
  assert.equal(added.length, 2);
  assert.deepEqual(added[0], other);
  assert.equal(withManagedAgent(added, LAUNCHER, { CLAUDE_COPILOT_DATA_DIR: "/data" }), null);
  const moved = withManagedAgent(added, "/new/launcher", { CLAUDE_COPILOT_DATA_DIR: "/data" });
  assert.equal(moved.length, 2);
  assert.equal(moved[1].command, "/new/launcher");
});

test("parseCustomAgents refuses to overwrite a setting that is not a list", () => {
  assert.deepEqual(parseCustomAgents(undefined), []);
  assert.deepEqual(parseCustomAgents("  "), []);
  assert.deepEqual(parseCustomAgents('[{"id":"a"}]'), [{ id: "a" }]);
  assert.throws(() => parseCustomAgents('{"id":"a"}'), /refusing to overwrite/);
  assert.throws(() => parseCustomAgents(42), /must be a string/);
});
