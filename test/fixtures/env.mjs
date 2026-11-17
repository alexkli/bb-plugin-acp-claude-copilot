// The environment for a launcher or proxy under test: the developer's own
// Claude Code, Copilot, AWS and bb variables removed (a test run inside a
// Claude Code (Copilot ACP) thread inherits CLAUDE_MODEL_CONFIG, ANTHROPIC_*
// and CLAUDE_COPILOT_*), HOME and XDG_STATE_HOME in a temp folder.
import { dirname, join } from "node:path";

export function cleanEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(AWS_|CLAUDE_|ANTHROPIC_|BB_|COPILOT_API_)/.test(name)) delete env[name];
  }
  return {
    ...env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir,
    XDG_STATE_HOME: join(dir, "state"),
    ...extra,
  };
}
