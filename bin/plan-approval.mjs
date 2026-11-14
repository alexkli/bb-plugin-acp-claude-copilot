// Plan approval for claude-copilot-acp-proxy.mjs.
//
// When Claude finishes planning in plan mode, it calls ExitPlanMode and the
// ACP adapter asks the client for permission ("Ready to code?") with options
// such as "Yes, and use auto mode", "Yes, manually approve edits" and "No,
// keep planning". bb's ACP bridge answers every permission request itself in
// Full Access (it picks the first allow option), so the plan would never wait
// for the user. The proxy holds that request and asks bb an elicitation
// question instead, which bb always shows, then answers the adapter with the
// option the user picked. A question shows its text as one plain paragraph, so
// the plan is not in it: the proxy opens it in the side panel and adds a link
// to it to Claude's message.

/** The adapter's option ids for this request all start with this (claude-agent-acp). */
const EXIT_PLAN_OPTION_PREFIX = "exit-plan-";
/** bb shows at most this many options per question. */
const MAX_OPTIONS = 4;
/** Options to leave out first when there are more than bb can show. */
const DROP_ORDER = ["exit-plan-bypass", "exit-plan-clear-bypass", "exit-plan-clear-accept-edits", "exit-plan-clear-auto"];
/** Claude Code writes plans to <plansDirectory>/<slug>.md (default ~/.claude/plans). */
const PLAN_FILE = /[\\/]plans[\\/][^\\/]+\.md$/;

/** Whether an agent -> client message is the permission request that ends plan mode. */
export function isPlanApprovalRequest(msg) {
  return (
    msg !== null &&
    typeof msg === "object" &&
    msg.method === "session/request_permission" &&
    msg.id !== undefined &&
    Array.isArray(msg.params?.options) &&
    msg.params.options.some((o) => typeof o?.optionId === "string" && o.optionId.startsWith(EXIT_PLAN_OPTION_PREFIX))
  );
}

/** The request's options, cut to what bb can show; the reject option always stays. */
export function shownOptions(options) {
  const shown = options.filter((o) => typeof o?.optionId === "string" && typeof o?.name === "string");
  for (const id of DROP_ORDER) {
    if (shown.length <= MAX_OPTIONS) break;
    const index = shown.findIndex((o) => o.optionId === id);
    if (index >= 0) shown.splice(index, 1);
  }
  while (shown.length > MAX_OPTIONS) {
    const index = shown.findIndex((o) => !String(o.kind).startsWith("reject"));
    shown.splice(index, 1);
  }
  return shown;
}

/**
 * The plan file a session/update reports Claude writing, as [sessionId, path],
 * or null: a tool call whose location or file_path is a .md file in a plans
 * directory.
 */
export function planFileFromUpdate(msg) {
  if (msg?.method !== "session/update") return null;
  const update = msg.params?.update;
  if (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update") return null;
  const paths = [
    ...(Array.isArray(update.locations) ? update.locations.map((l) => l?.path) : []),
    update.rawInput?.file_path,
  ];
  const path = paths.find((p) => typeof p === "string" && PLAN_FILE.test(p));
  return path && typeof msg.params.sessionId === "string" ? [msg.params.sessionId, path] : null;
}

/** The plan text of a plan approval request, or null. */
export function planText(msg) {
  const plan = msg.params?.toolCall?.rawInput?.plan;
  return typeof plan === "string" && plan.trim() !== "" ? plan.trim() : null;
}

/**
 * The session/update that adds the plan to Claude's message: for a plan in the
 * thread's storage folder (`storagePath`, relative to it), the
 * `::claude-copilot-plan` directive, which the plugin's app renders as a card
 * that opens the plan in the side panel; otherwise a Markdown link to it.
 */
export function planLinkUpdate(sessionId, planFile, storagePath = null) {
  if (storagePath !== null) {
    return {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `\n\n::claude-copilot-plan{file="${storagePath.replace(/"/g, "")}"}\n` },
        },
      },
    };
  }
  const name = planFile.split(/[\\/]/).pop();
  // a plain path, like other agents' file links; <...> only where a space needs it
  const target = /\s/.test(planFile) ? `<${planFile}>` : planFile;
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n\n**Plan ready for review:** [${name}](${target})\n` },
      },
    },
  };
}

const KEEP_PLANNING_HINT = " (then send your feedback)";

/**
 * The elicitation/create request that asks the user about a plan approval
 * request. bb adds the field title "Ready to code?" after the message. The
 * adapter takes no text with the answer, so feedback on the plan is a normal
 * message after "No, keep planning", which keeps Claude in plan mode.
 */
export function planApprovalQuestion(msg, questionId, planFile = null) {
  const message = `Claude has finished planning. ${planFile ? "The plan is in the side panel (and above)." : "The plan is in the ExitPlanMode step above."} To change it, pick "No, keep planning" and send your feedback as a message.`;
  return {
    jsonrpc: "2.0",
    id: questionId,
    method: "elicitation/create",
    params: {
      ...(msg.params?.sessionId ? { sessionId: msg.params.sessionId } : {}),
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Ready to code?",
            oneOf: shownOptions(msg.params.options).map((o) => ({
              const: o.optionId,
              title: String(o.kind).startsWith("reject") ? `${o.name}${KEEP_PLANNING_HINT}` : o.name,
            })),
          },
        },
        required: ["decision"],
      },
    },
  };
}

/**
 * The result for the held permission request, from bb's answer to the
 * question: the picked option; "No, keep planning" when the user declined;
 * cancelled when the question was dismissed or failed (the turn stops, and
 * Claude stays in plan mode).
 */
export function planApprovalResult(answer, options) {
  const ids = new Set(options.map((o) => o?.optionId));
  const reject = options.find((o) => String(o?.kind).startsWith("reject"))?.optionId;
  const result = answer?.result;
  if (result?.action === "accept" && ids.has(result.content?.decision)) {
    return { outcome: { outcome: "selected", optionId: result.content.decision } };
  }
  if (result?.action === "decline" && reject !== undefined) {
    return { outcome: { outcome: "selected", optionId: reject } };
  }
  return { outcome: { outcome: "cancelled" } };
}
