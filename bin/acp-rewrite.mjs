// Agent -> bb message rewrites for claude-copilot-acp-proxy.mjs. Pure
// functions, so they can be tested without a running agent.

/** Model option ids claude-agent-acp uses for the model picker. */
const MODEL_OPTION = "model";

/**
 * Rewrites one agent -> bb message in place and returns it:
 * - drops the session config options in `hidden` (e.g. the subagent picker);
 * - gives Copilot models in the model option their Copilot names
 *   (`labels`: model id -> { name, description? }; a description replaces the
 *   adapter's); the values the adapter takes stay as they are;
 * - removes the cost from usage_update: Claude Code estimates it at Anthropic
 *   list prices, which says nothing about Copilot (premium requests / AI
 *   credits). Token counts and the context window stay.
 *
 * @param {any} msg
 * @param {{ hidden: Set<string>, labels: Map<string, { name: string, description?: string }> }} options
 */
export function rewriteMessage(msg, { hidden, labels }) {
  rewriteOptions(msg?.result, hidden, labels);
  rewriteModels(msg?.result?.models, labels);
  const update = msg?.method === "session/update" ? msg.params?.update : undefined;
  if (update) {
    rewriteOptions(update, hidden, labels);
    if (update.sessionUpdate === "usage_update" && "cost" in update) delete update.cost;
  }
  return msg;
}

function rewriteOptions(obj, hidden, labels) {
  if (!obj || !Array.isArray(obj.configOptions)) return;
  obj.configOptions = obj.configOptions.filter((o) => !hidden.has(o?.id));
  if (labels.size === 0) return;
  for (const option of obj.configOptions) {
    if (option?.id !== MODEL_OPTION || !Array.isArray(option.options)) continue;
    for (const entry of option.options) {
      // a select's options, or groups of them
      for (const value of Array.isArray(entry?.options) ? entry.options : [entry]) relabel(value, "value", labels);
    }
  }
}

/** The older `models` field of session/new and session/load results. */
function rewriteModels(models, labels) {
  if (!models || labels.size === 0 || !Array.isArray(models.availableModels)) return;
  for (const model of models.availableModels) relabel(model, "modelId", labels);
}

function relabel(entry, key, labels) {
  if (!entry || typeof entry[key] !== "string") return;
  const label = labels.get(entry[key]);
  if (label === undefined) return;
  entry.name = label.name;
  if (label.description !== undefined) {
    entry.description = label.description;
    return;
  }
  // the adapter describes an allowlisted model it doesn't know with nothing useful
  if (typeof entry.description !== "string" || entry.description === "" || entry.description === entry[key]) {
    entry.description = `GitHub Copilot model ${entry[key]}`;
  }
}
