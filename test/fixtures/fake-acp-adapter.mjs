// A minimal ACP agent standing in for claude-agent-acp in the bridge
// conformance test: sessions with load, resume and fork, prompts that echo
// their text ("/compact" does no work, "hang" waits for session/cancel).
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

let serial = 0;
const newSessionId = () => `fake-${process.pid}-${++serial}`;
/** Pending "hang" prompts by session id, settled by session/cancel. */
const hanging = new Map();

function prompt({ id, params }) {
  const text = (params.prompt ?? []).map((block) => block.text ?? "").join("");
  if (text === "hang") {
    hanging.set(params.sessionId, id);
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
    return;
  }
  if (text !== "/compact") update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo:${text}` } });
  reply(id, { stopReason: "end_turn" });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = message;
  if (method === undefined) return; // a response to a request of ours
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, sessionCapabilities: { fork: {}, resume: {} } },
      });
    case "session/new":
      return reply(id, { sessionId: newSessionId() });
    case "session/load":
    case "session/resume":
      return reply(id, {});
    case "session/fork":
      return reply(id, { sessionId: newSessionId() });
    case "session/prompt":
      return prompt(message);
    case "session/cancel": {
      const pending = hanging.get(params.sessionId);
      if (pending !== undefined) {
        hanging.delete(params.sessionId);
        reply(pending, { stopReason: "cancelled" });
      }
      return;
    }
    default:
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not supported` } });
  }
});
