---
name: claude-copilot-acp
description: "Configure or troubleshoot the Claude Code (Copilot ACP) provider (acp-claude-copilot): GitHub Copilot sign-in, the plugin's copilot-api, Copilot models in the picker, permission modes and the Bash sandbox, plan approval, /compact, session credits and the premium-request usage entry."
---

# Claude Code (Copilot ACP)

The plugin `acp-claude-copilot` runs Claude Code on a GitHub Copilot
subscription as an ACP agent, through the plugin's own copilot-api (an
Anthropic Messages API in front of Copilot). Threads use provider
`acp-claude-copilot`; its models are Copilot's chat models, Claude and others
(`bb provider models acp-claude-copilot`).

The plugin keeps one entry, id `claude-copilot`, in the ACP agents plugin's
`customAgents` setting and rewrites it on every load and settings change. It
owns `command`, `args`, `displayName`, `permissionCli`,
`supportsManualCompaction` and the env variables in the table below; edits to
those are overwritten. Other env variables and fields in the entry are kept.
Change the plugin's settings instead of the entry.

## Settings

The plugin keeps its settings itself and edits them in its own section:
Settings → Plugins → Claude Copilot ACP provider (not `bb plugin config`). A
change applies when a thread's agent next starts.

| Setting | Env in the entry |
| --- | --- |
| Default model, default `claude-opus-5-5` | `ANTHROPIC_MODEL` |
| Opus / Sonnet / Haiku model: the Copilot models behind Claude Code's aliases | `ANTHROPIC_DEFAULT_OPUS_MODEL`, `..._SONNET_MODEL`, `..._HAIKU_MODEL` |
| All Copilot models in the picker, default on | `CLAUDE_COPILOT_ALL_MODELS=0` when off |
| Bash sandbox in Accept Edits, default on | `CLAUDE_COPILOT_SANDBOX=0` when off |
| ACP adapter command. Default: the adapter bundled with the plugin | `CLAUDE_AGENT_ACP` |
| Stop copilot-api when idle (minutes), default 30; 0 keeps it running | none |
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
Full Access. `CLAUDE_COPILOT_ASK_PLAN_APPROVAL=0` in the entry's env turns this
off. `/compact` and `bb thread compact <thread-id>` run Claude Code's
compaction.

## Usage and troubleshooting

- Threads show no cost (Claude Code's estimate is at Anthropic list prices);
  the thread's context row shows the session's Copilot AI credits instead
  (1 credit = $0.01). The Provider usage panel shows the premium-request quota.
- Each launch appends one line (data folder, model, adapter; no keys) to
  `${XDG_STATE_HOME:-~/.local/state}/claude-copilot-acp/launcher.log`.
  `adapter=node` means the bundled adapter.
- `bb acp-claude-copilot status` checks the launcher, the adapter, the agent
  entry, bb's provider registration, the GitHub sign-in and copilot-api; it
  exits non-zero when something needs attention. `bb acp-claude-copilot repair`
  rewrites the entry. If the plugin shows as needing configuration in
  `bb plugin list`, fix the reason it gives, then run `repair`.
- `bb acp-claude-copilot unregister` removes the entry; run it before
  `bb plugin remove acp-claude-copilot` (bb has no uninstall hook).
- Plugin errors: `~/.bb/plugins/acp-claude-copilot/logs/plugin.log`. Reload
  with `bb plugin reload acp-claude-copilot`.
