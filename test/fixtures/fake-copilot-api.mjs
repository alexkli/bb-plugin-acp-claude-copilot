// Stands in for copilot-api's dist/main.js in tests: `start --host H --port P`
// serves /v1/models and /usage for the gateway key in $COPILOT_API_HOME/config.json.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] !== "start") process.exit(3);
const port = Number(args[args.indexOf("--port") + 1]);
const host = args[args.indexOf("--host") + 1];
const config = JSON.parse(readFileSync(join(process.env.COPILOT_API_HOME, "config.json"), "utf8"));
const keys = new Set(config.auth.apiKeys);

export const MODELS = {
  data: [
    { id: "claude-sonnet-5-5", vendor: "Anthropic", display_name: "Claude Sonnet 5.5", context_window: 200000, capabilities: { type: "chat" }, supported_endpoints: ["/v1/messages"] },
    { id: "gpt-5", vendor: "OpenAI", display_name: "GPT-5", context_window: 400000, capabilities: { type: "chat" }, supported_endpoints: ["/chat/completions"] },
    { id: "gemini-3-pro", vendor: "Google", display_name: "Gemini 3 Pro (github-copilot)", context_window: 1000000, capabilities: { type: "chat" }, supported_endpoints: ["/chat/completions"] },
    { id: "text-embedding-3", vendor: "OpenAI", capabilities: { type: "embeddings" }, supported_endpoints: ["/embeddings"] },
  ],
};

createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${[...keys][0]}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.url === "/v1/models") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(MODELS));
  else if (req.url === "/usage") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ login: "octo", copilot_plan: "pro" }));
  else res.writeHead(404).end();
}).listen(port, host);
