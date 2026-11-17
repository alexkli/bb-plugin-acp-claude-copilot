import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { cleanEnv } from "./fixtures/env.mjs";
import {
  isPlanApprovalRequest,
  planApprovalQuestion,
  planApprovalResult,
  planFileFromUpdate,
  planLinkUpdate,
  shownOptions,
} from "../bin/plan-approval.mjs";

const OPTIONS = [
  { optionId: "exit-plan-clear-auto", name: "Yes, clear context and use auto mode", kind: "allow_always" },
  { optionId: "exit-plan-auto", name: "Yes, and use auto mode", kind: "allow_always" },
  { optionId: "exit-plan-bypass", name: "Yes, and bypass permissions", kind: "allow_always" },
  { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
  { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
];
const REQUEST = {
  jsonrpc: "2.0",
  id: 5,
  method: "session/request_permission",
  params: { sessionId: "s1", toolCall: { toolCallId: "t1", rawInput: { plan: "# Plan\n\n1. Do it" } }, options: OPTIONS },
};

test("recognizes only the plan approval request", () => {
  assert.equal(isPlanApprovalRequest(REQUEST), true);
  const other = { ...REQUEST, params: { ...REQUEST.params, options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }] } };
  assert.equal(isPlanApprovalRequest(other), false);
  assert.equal(isPlanApprovalRequest({ method: "session/update", params: {} }), false);
});

test("shows at most 4 options, dropping bypass first and keeping keep-planning", () => {
  assert.deepEqual(shownOptions(OPTIONS).map((o) => o.optionId), ["exit-plan-clear-auto", "exit-plan-auto", "exit-plan-default", "reject"]);
});

test("asks a short single-choice question that explains how to give feedback", () => {
  const q = planApprovalQuestion(REQUEST, "q1", "/home/u/.claude/plans/whimsical-marshmallow.md");
  assert.equal(q.method, "elicitation/create");
  assert.equal(q.id, "q1");
  assert.equal(q.params.mode, "form");
  assert.match(q.params.message, /^Claude has finished planning\. The plan is in the side panel \(and above\)\. /);
  assert.match(q.params.message, /pick "No, keep planning" and send your feedback as a message\.$/);
  assert.doesNotMatch(q.params.message, /Ready to code/, "bb adds the field title; don't repeat it");
  const field = q.params.requestedSchema.properties.decision;
  assert.equal(field.title, "Ready to code?");
  assert.deepEqual(q.params.requestedSchema.required, ["decision"]);
  assert.deepEqual(field.oneOf.at(-1), { const: "reject", title: "No, keep planning (then send your feedback)" });
  assert.equal(field.oneOf[0].title, "Yes, clear context and use auto mode");
  assert.match(planApprovalQuestion(REQUEST, "q2").params.message, /ExitPlanMode step/);
});

test("adds the plan card directive for a thread-storage plan", () => {
  assert.deepEqual(planLinkUpdate("s1", "/st/plans/p.md", "plans/p.md").params.update.content, {
    type: "text",
    text: '\n\n::claude-copilot-plan{file="plans/p.md"}\n',
  });
});

test("links the plan file in Claude's message", () => {
  assert.deepEqual(planLinkUpdate("s1", "/h/.claude/plans/my plan.md").params, {
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\n\n**Plan ready for review:** [my plan.md](</h/.claude/plans/my plan.md>)\n" },
    },
  });
});

test("finds the plan file Claude writes", () => {
  const update = (u) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: u } });
  assert.deepEqual(
    planFileFromUpdate(update({ sessionUpdate: "tool_call", locations: [{ path: "/h/.claude/plans/a-b-c.md" }] })),
    ["s1", "/h/.claude/plans/a-b-c.md"],
  );
  assert.deepEqual(
    planFileFromUpdate(update({ sessionUpdate: "tool_call_update", rawInput: { file_path: "/h/.claude/plans/x.md" } })),
    ["s1", "/h/.claude/plans/x.md"],
  );
  assert.equal(planFileFromUpdate(update({ sessionUpdate: "tool_call", locations: [{ path: "/repo/README.md" }] })), null);
  assert.equal(planFileFromUpdate(update({ sessionUpdate: "agent_message_chunk" })), null);
});

test("maps the answer back to the permission result", () => {
  const accept = { result: { action: "accept", content: { decision: "exit-plan-auto" } } };
  assert.deepEqual(planApprovalResult(accept, OPTIONS), { outcome: { outcome: "selected", optionId: "exit-plan-auto" } });
  assert.deepEqual(planApprovalResult({ result: { action: "decline" } }, OPTIONS), { outcome: { outcome: "selected", optionId: "reject" } });
  assert.deepEqual(planApprovalResult({ result: { action: "cancel" } }, OPTIONS), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(planApprovalResult({ error: { code: -32602 } }, OPTIONS), { outcome: { outcome: "cancelled" } });
  const unknown = { result: { action: "accept", content: { decision: "nope" } } };
  assert.deepEqual(planApprovalResult(unknown, OPTIONS), { outcome: { outcome: "cancelled" } });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the proxy around a fake agent that sends `lines`, answers the question,
 * then waits `holdMs` before letting the agent exit (so a test can change files
 * meanwhile). A fake bb CLI records its calls and serves an empty tab list.
 */
async function runProxy(lines, { dir = mkdtempSync(join(tmpdir(), "plan-approval-")), storage = true, whileOpen } = {}) {
  const agent = join(dir, "agent.mjs");
  const release = join(dir, "release");
  writeFileSync(
    agent,
    `import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
for (const line of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) process.stdout.write(line + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test/received", params: JSON.parse(line) }) + "\\n");
  const wait = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(wait); process.exit(0); } }, 50);
});
`,
  );
  const calls = join(dir, "bb-calls.txt");
  const fakeBb = join(dir, "bb");
  writeFileSync(
    fakeBb,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$3" in show) echo '{"revision":7,"tabs":[{"id":"plugin-fixed:core:info","kind":"plugin-fixed","pluginId":"core","tabId":"info"}]}';; *) echo '{}';; esac\n`,
  );
  chmodSync(fakeBb, 0o755);
  const storageDir = join(dir, "thread-storage");
  const proxy = spawn(process.execPath, [join(import.meta.dirname, "..", "bin", "claude-copilot-acp-proxy.mjs"), process.execPath, agent], {
    env: cleanEnv(dir, {
      XDG_STATE_HOME: dir,
      BB_CLI: fakeBb,
      BB_THREAD_ID: "thr_test",
      BB_ENVIRONMENT_ID: "env_test",
      BB_THREAD_STORAGE: storage ? storageDir : "",
    }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const received = [];
  let answered;
  const done = new Promise((resolve) => (answered = resolve));
  createInterface({ input: proxy.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    received.push(msg);
    if (msg.method === "elicitation/create") {
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: { decision: "exit-plan-default" } } }) + "\n");
    }
    if (msg.method === "test/received") answered();
  });
  await done;
  // the tab is added in the background: wait for the fake bb's set call
  if (whileOpen) await whileOpen(storageDir);
  writeFileSync(release, "");
  await new Promise((r) => proxy.on("exit", r));
  return { dir, storageDir, received, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
}

test("proxy: copies Claude's plan to thread storage, keeps it current, adds the plan card, asks bb, answers the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-approval-"));
  const source = join(dir, "home", ".claude", "plans", "p.md");
  mkdirSync(join(dir, "home", ".claude", "plans"), { recursive: true });
  writeFileSync(source, "# Plan v1\n");
  const write = {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "w1", locations: [{ path: source }] } },
  };
  const { storageDir, received, calls } = await runProxy([write, REQUEST], {
    dir,
    whileOpen: async (storage) => {
      const copy = join(storage, "plans", "p.md");
      assert.equal(readFileSync(copy, "utf8"), "# Plan v1\n");
      writeFileSync(source, "# Plan v2\n"); // Claude revises the plan
      for (let i = 0; i < 40 && readFileSync(copy, "utf8") !== "# Plan v2\n"; i++) await sleep(100);
      assert.equal(readFileSync(copy, "utf8"), "# Plan v2\n", "copy follows the plan file");
    },
  });
  const copy = join(storageDir, "plans", "p.md");
  assert.equal(received.some((m) => m.method === "session/request_permission"), false, "permission request must not reach bb");
  assert.deepEqual(received.map((m) => m.method), ["session/update", "session/update", "elicitation/create", "test/received"], "order kept");
  assert.ok(existsSync(copy));
  assert.equal(received[1].params.update.content.text, '\n\n::claude-copilot-plan{file="plans/p.md"}\n');
  assert.match(received[2].params.message, /side panel/);
  assert.deepEqual(calls, [], "no bb CLI calls: nothing switches anyone's view");
  assert.deepEqual(received.at(-1).params, { jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "selected", optionId: "exit-plan-default" } } });
});

test("proxy: without a plan file, writes the plan text to thread storage", async () => {
  const { storageDir, received } = await runProxy([REQUEST]);
  const plans = readdirSync(join(storageDir, "plans"));
  assert.equal(plans.length, 1);
  const path = join(storageDir, "plans", plans[0]);
  assert.equal(readFileSync(path, "utf8"), "# Plan\n\n1. Do it\n");
  assert.equal(received[0].params.update.content.text, `\n\n::claude-copilot-plan{file="plans/${plans[0]}"}\n`);
  assert.equal(received[1].method, "elicitation/create");
});

test("proxy: without thread storage, links Claude's own plan file and adds no tab", async () => {
  const write = {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "w1", locations: [{ path: "/h/.claude/plans/p.md" }] } },
  };
  const { received, calls } = await runProxy([write, REQUEST], { storage: false });
  assert.equal(received[1].params.update.content.text, "\n\n**Plan ready for review:** [p.md](/h/.claude/plans/p.md)\n");
  assert.deepEqual(calls, []);
});
