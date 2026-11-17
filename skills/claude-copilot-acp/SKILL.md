---
name: claude-copilot-acp
description: "Configure or troubleshoot the Claude Code (Copilot ACP) provider (acp-claude-copilot): GitHub Copilot sign-in, the plugin's copilot-api, Copilot models in the picker, extra agent variables, permission modes and the Bash sandbox, plan approval, /compact and forks, the handover from the old ACP custom agent, session credits and the premium-request usage entry."
---

# Claude Code (Copilot ACP)

The plugin `acp-claude-copilot` runs Claude Code on a GitHub Copilot
subscription as an ACP agent, through the plugin's own copilot-api (an
Anthropic Messages API in front of Copilot). It registers the provider
`acp-claude-copilot` itself, run by bb's ACP bridge; threads on it support
forks and side chats. Its models are Copilot's chat models, Claude and others
(`bb provider models acp-claude-copilot`).

Versions before 0.2 added a custom agent `claude-copilot` to the ACP agents
plugin's (`provider-acp`) `customAgents` setting instead. The plugin removes
that entry on load and registers the same provider id, so older threads keep
working. Don't add the entry back: two plugins can't hold one provider id.

## Settings

The plugin keeps its settings itself and edits them in its own section:
Settings → Plugins → Claude Copilot ACP provider (not `bb plugin config`). The
plugin writes them to `~/.bb/plugins/acp-claude-copilot/host-data/agent.env`
(mode 0600), which the launcher reads on every start, so a change applies when
a thread's agent next starts.

| Setting | Env for the agent |
| --- | --- |
| Default model, default `claude-opus-5-5` | `ANTHROPIC_MODEL` |
| Opus / Sonnet / Haiku model: the Copilot models behind Claude Code's aliases | `ANTHROPIC_DEFAULT_OPUS_MODEL`, `..._SONNET_MODEL`, `..._HAIKU_MODEL` |
| All Copilot models in the picker, default on | `CLAUDE_COPILOT_ALL_MODELS=0` when off |
| Bash sandbox in Accept Edits, default on | `CLAUDE_COPILOT_SANDBOX=0` when off |
| ACP adapter command. Default: the adapter bundled with the plugin | `CLAUDE_AGENT_ACP` |
| Stop copilot-api when idle (minutes), default 30; 0 keeps it running | none |
| Extra environment variables: `NAME=value` pairs separated by spaces; the settings above win | as given |
| (the plugin's data folder) | `CLAUDE_COPILOT_DATA_DIR` |

Never print copilot-api's keys (`proxy.json`, `config.json` auth) or the GitHub
token (`copilot-api/github_token`) from the data folder.

## copilot-api and sign-in

- GitHub sign-in: the settings section, or `bb acp-claude-copilot login`
  (device code; the user enters it on github.com). `logout` signs out.
- The proxy starts copilot-api when a thread starts and before each message if
  it stopped; the plugin stops it after the idle minutes. `start` and `stop`
  do it by hand. A stopped copilot-api is normal.
- A message that comes back with "Not signed in to GitHub Copilot" or
  "copilot-api is not running" never reached Claude: sign in, or check
  copilot-api's log, then send it again.
- Log: `~/.bb/plugins/acp-claude-copilot/host-data/copilot-api.log`.

## Permission modes and the sandbox

bb's ACP permission modes are Accept Edits and Full Access. bb starts the
launcher with `--bb-permission-mode=accept-edits` or `--bb-permission-mode=full`
and restarts the agent when a thread's mode changes.

- Accept Edits: Bash runs in Claude Code's OS sandbox, as with bb's Claude Code
  provider. Writes are limited to the workspace and the thread's extra folders.
  "Operation not permitted" on a write elsewhere is the sandbox: edit inside
  the workspace, or ask the user; a command run outside the sandbox needs their
  approval in bb.
- Full Access: no sandbox, and bb approves every permission request.

Claude Code's own permission mode (Auto, Default, Plan, ...) is the separate
`mode` session option: `bb thread options <thread-id>`.

## Plan approval and compaction

In plan mode the proxy holds Claude's "Ready to code?" request, opens the plan
from the thread's storage folder (`plans/`), and asks the user in bb, even in
Full Access. `CLAUDE_COPILOT_ASK_PLAN_APPROVAL=0` in Extra environment variables turns this
off. `/compact` and `bb thread compact <thread-id>` run Claude Code's
compaction.

## Usage and troubleshooting

- Threads show no cost (Claude Code's estimate is at Anthropic list prices);
  the thread's context row shows the session's Copilot AI credits instead
  (1 credit = $0.01). The Provider usage panel shows the premium-request quota.
- Each launch appends one line (data folder, model, adapter; no keys) to
  `${XDG_STATE_HOME:-~/.local/state}/claude-copilot-acp/launcher.log`.
  `adapter=node` means the bundled adapter.
- `bb acp-claude-copilot status` checks the launcher, the adapter, who
  registered the provider, a leftover old entry, the agent settings file, the
  GitHub sign-in and copilot-api; it exits non-zero when something needs
  attention. `bb acp-claude-copilot repair` rewrites the settings file and
  registers the provider again. If the plugin shows as needing configuration
  in `bb plugin list`, fix the reason it gives, then run `repair`.
- "registered by another plugin": another plugin holds `acp-claude-copilot`,
  e.g. a `claude-copilot` agent in `customAgents` that this plugin didn't add.
  Rename or remove it, then run `repair`.
- Before `bb plugin remove acp-claude-copilot`, run `bb acp-claude-copilot
  logout` (stops copilot-api, deletes the GitHub token); bb keeps the data
  folder, which the user can delete afterwards.
- Plugin errors: `~/.bb/plugins/acp-claude-copilot/logs/plugin.log`. Reload
  with `bb plugin reload acp-claude-copilot`.
