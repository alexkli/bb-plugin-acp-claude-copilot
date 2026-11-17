import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSION_ARG, SESSION_OPTIONS, sandboxFor, takePermissionMode, withSandbox, withSessionOptions } from "../bin/acp-session.mjs";
import { PERMISSION_CLI } from "../agent-entry.ts";

const SANDBOX = sandboxFor({ permissionMode: "accept-edits", enabled: true });

test("the agent entry's permissionCli arguments are the ones the proxy reads", () => {
  for (const [mode, [arg]] of [["full", PERMISSION_CLI.full], ["accept-edits", PERMISSION_CLI.workspaceWrite]]) {
    assert.ok(arg.startsWith(`${PERMISSION_ARG}=`));
    assert.equal(takePermissionMode(["node", "adapter.js", arg]).permissionMode, mode);
  }
});

test("takePermissionMode takes bb's argument off the command line wherever it is", () => {
  assert.deepEqual(takePermissionMode(["--bb-permission-mode=accept-edits", "node", "a.js", "--x"]), {
    permissionMode: "accept-edits",
    rest: ["node", "a.js", "--x"],
  });
  assert.deepEqual(takePermissionMode(["node", "a.js"]), { permissionMode: null, rest: ["node", "a.js"] });
  // an unknown mode is dropped and treated as unknown
  assert.deepEqual(takePermissionMode(["node", "--bb-permission-mode=yolo"]), { permissionMode: null, rest: ["node"] });
});

test("sandboxFor: Accept Edits only, like bb's Claude Code provider; the setting turns it off", () => {
  assert.deepEqual(SANDBOX, {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    network: { allowLocalBinding: true },
  });
  assert.equal(sandboxFor({ permissionMode: "full", enabled: true }), null);
  assert.equal(sandboxFor({ permissionMode: null, enabled: true }), null);
  assert.equal(sandboxFor({ permissionMode: "accept-edits", enabled: false }), null);
});

test("withSandbox adds the sandbox to every session start and keeps extra workspace roots writable", () => {
  for (const method of ["session/new", "session/load", "session/resume", "session/fork"]) {
    const msg = { jsonrpc: "2.0", id: 1, method, params: { sessionId: "s1", cwd: "/w", mcpServers: [], additionalDirectories: ["/storage"] } };
    const out = withSandbox(msg, SANDBOX);
    assert.deepEqual(out.params._meta.claudeCode.options.sandbox, { ...SANDBOX, filesystem: { allowWrite: ["/storage"] } }, method);
    assert.equal(out.params.cwd, "/w");
    assert.equal(msg.params._meta, undefined, "the input is not changed");
  }
  const plain = withSandbox({ method: "session/new", params: { cwd: "/w" } }, SANDBOX);
  assert.deepEqual(plain.params._meta.claudeCode.options.sandbox, SANDBOX, "no filesystem key without extra roots");
});

test("withSandbox keeps the client's own _meta and a sandbox it set", () => {
  const meta = { systemPrompt: "x", claudeCode: { options: { maxTurns: 3 } } };
  const out = withSandbox({ method: "session/new", params: { cwd: "/w", _meta: meta } }, SANDBOX);
  assert.equal(out.params._meta.systemPrompt, "x");
  assert.equal(out.params._meta.claudeCode.options.maxTurns, 3);
  assert.deepEqual(out.params._meta.claudeCode.options.sandbox, SANDBOX);
  const own = { method: "session/new", params: { _meta: { claudeCode: { options: { sandbox: { enabled: false } } } } } };
  assert.equal(withSandbox(own, SANDBOX), own);
});

test("withSandbox leaves other messages, and everything without a sandbox, alone", () => {
  const prompt = { method: "session/prompt", params: { sessionId: "s1", prompt: [] } };
  assert.equal(withSandbox(prompt, SANDBOX), prompt);
  const answer = { jsonrpc: "2.0", id: 4, result: {} };
  assert.equal(withSandbox(answer, SANDBOX), answer);
  const start = { method: "session/new", params: { cwd: "/w" } };
  assert.equal(withSandbox(start, null), start);
});

const newSession = (options) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "session/new",
  params: { cwd: "/w", mcpServers: [], ...(options ? { _meta: { other: 1, claudeCode: { options } } } : {}) },
});
const optionsOf = (msg) => msg.params._meta.claudeCode.options;

test("withSessionOptions turns prompt suggestions off on every session start, with or without the sandbox", () => {
  assert.deepEqual(SESSION_OPTIONS, { promptSuggestions: false });
  for (const method of ["session/new", "session/load", "session/resume", "session/fork"]) {
    assert.deepEqual(optionsOf(withSessionOptions({ ...newSession(), method })), { promptSuggestions: false }, method);
  }
  assert.deepEqual(optionsOf(withSessionOptions(newSession(), { sandbox: SANDBOX })), { promptSuggestions: false, sandbox: SANDBOX });
});

test("withSessionOptions: an option the client set wins, and its other _meta stays", () => {
  const msg = withSessionOptions(newSession({ promptSuggestions: true, model: "x" }));
  assert.deepEqual(optionsOf(msg), { promptSuggestions: true, model: "x" });
  assert.equal(msg.params._meta.other, 1);
  const set = newSession({ promptSuggestions: true });
  assert.equal(withSessionOptions(set), set, "nothing to add: the same message");
});

test("withSessionOptions leaves other messages alone", () => {
  const prompt = { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [] } };
  assert.equal(withSessionOptions(prompt, { sandbox: SANDBOX }), prompt);
  const result = { jsonrpc: "2.0", id: 1, result: {} };
  assert.equal(withSessionOptions(result), result);
});
