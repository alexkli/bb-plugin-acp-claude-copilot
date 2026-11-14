// Frontend of bb-plugin-acp-claude-copilot:
// - provider icon for the "Claude Code (Copilot ACP)" ACP agent (provider id
//   acp-claude-copilot): the Claude mark and the GitHub Copilot glyph at equal
//   size on a diagonal, Claude on top, monochrome in the text color, so it is
//   told apart from the colored icon of the Claude Copilot provider plugin.
//   Same layout as assets/logo.svg (the branding and marketplace icon): keep
//   in sync.
// - the plan card for the proxy's ::claude-copilot-plan directive;
// - a settings section: GitHub sign-in and the plugin's copilot-api.
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { AppStatus, appContract } from "./contract";
import { CLAUDE_MARK, COPILOT_PATHS } from "./icon-paths";

const PROVIDER_ID = "acp-claude-copilot";

// ---------------------------------------------------------------------------
// Icon

// Equal-size marks on a diagonal: Claude top-left (drawn on top), Copilot
// bottom-right. Copilot is masked by a slightly thickened Claude shape, so a
// thin gap separates the two where the spokes cross it.
const CLAUDE_SCALE = 700 / 1200;
const CLAUDE_GAP = 40;

function ClaudeCopilotAcpIcon({ className }: { className?: string }) {
  const mask = useId();
  return (
    // explicit width/height: without them WebKit (iOS app) sizes the svg at 300px
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="16" height="16" className={className} aria-hidden="true">
      <defs>
        <mask id={mask}>
          <rect width="1200" height="1200" fill="#fff" />
          <path
            fill="#000"
            stroke="#000"
            strokeWidth={CLAUDE_GAP / CLAUDE_SCALE}
            strokeLinejoin="round"
            transform={`scale(${CLAUDE_SCALE})`}
            d={CLAUDE_MARK}
          />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
        <g transform="translate(600 540) scale(12.5)" fill="currentColor">
          {COPILOT_PATHS.map((d) => (
            <path key={d.slice(0, 16)} d={d} />
          ))}
        </g>
      </g>
      <path fill="currentColor" transform={`scale(${CLAUDE_SCALE})`} d={CLAUDE_MARK} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Plan card

/** A plan file in the thread's storage folder, as the proxy names it: plans/<name>.md. */
const PLAN_PATH = /^plans\/[^/\\]+\.md$/;

/**
 * `::claude-copilot-plan{file="plans/<name>.md"}`, which the ACP proxy adds to
 * Claude's message when a plan waits for approval (bin/plan-approval.mjs). It
 * shows a card that opens the plan in the side panel, and opens it once by
 * itself the first time this window shows the message, so the panel only
 * changes for someone who is looking at the thread.
 */
function PlanCard({ attributes, message }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const file = attributes.file ?? "";
  const valid = PLAN_PATH.test(file);
  const name = file.split("/").pop() ?? file;
  const open = () =>
    navigate.experimental_openFilePreview({
      target: { kind: "thread-storage", threadId: message.threadId, path: file },
      location: null,
    });

  useEffect(() => {
    if (!valid) return;
    const key = `claude-copilot-plan:opened:${message.threadId}:${message.id}:${file}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, String(Date.now()));
    } catch {
      // no storage: open every time the message mounts
    }
    open();
    // open once per message and window
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, message.threadId, message.id, file]);

  if (!valid) return null;
  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
      <span className="font-medium">Plan ready for review</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{name}</span>
      <button
        type="button"
        onClick={open}
        className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent"
      >
        Open plan
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings section

const BUTTON =
  "rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function SettingsSection() {
  const rpc = useRpc<typeof appContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    rpc.call("status").then(
      (s) => {
        setStatus(s);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(refresh, [refresh]);

  // poll while the GitHub sign-in waits for the user
  const waiting = status?.login.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const run = (name: string, action: () => Promise<AppStatus>) => {
    setBusy(name);
    action()
      .then(
        (s) => {
          setStatus(s);
          setError(null);
        },
        (cause: unknown) => setError(errorText(cause)),
      )
      .finally(() => setBusy(null));
  };

  const login = status?.login;
  const deviceUrl = login?.url ?? "https://github.com/login/device";

  return (
    <div className="flex flex-col gap-2">
      {status === null && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {status ? (
        <div>
          <Row label="Account">
            {status.signedIn ? (status.account ?? "Signed in") : "Not signed in"}
            {status.signedIn && status.plan ? <span className="text-muted-foreground"> · {status.plan}</span> : null}
          </Row>
          <Row label="copilot-api">
            {status.running ? `Running on 127.0.0.1:${status.port}` : "Stopped (starts with the next thread)"}
            {status.running && status.models > 0 ? <span className="text-muted-foreground"> · {status.models} models</span> : null}
          </Row>
          {status.error && status.signedIn ? <Row label="Error">{status.error}</Row> : null}
          {status.home ? (
            <Row label="Data folder">
              <code className="text-xs">{status.home}</code>
            </Row>
          ) : null}
          {status.log ? (
            <Row label="Log">
              <code className="text-xs">{status.log}</code>
            </Row>
          ) : null}
        </div>
      ) : null}

      {login?.state === "waiting" && login.userCode ? (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <span>Open GitHub and enter this code, signed in with the account that has Copilot:</span>
          <span className="select-all font-mono text-2xl tracking-widest">{login.userCode}</span>
          <div>
            <button type="button" className={PRIMARY} onClick={() => navigate.openUrl(deviceUrl)}>
              Open {deviceUrl.replace(/^https:\/\//, "")}
            </button>
          </div>
          <span className="text-muted-foreground">Waiting for GitHub…</span>
        </div>
      ) : null}
      {login?.state === "failed" && login.message ? (
        <pre className="whitespace-pre-wrap rounded-md border p-3 text-xs text-destructive">{login.message}</pre>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        {status?.signedIn ? (
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => run("signOut", () => rpc.call("signOut"))}>
            Sign out
          </button>
        ) : (
          <button type="button" className={PRIMARY} disabled={busy !== null || waiting} onClick={() => run("login", () => rpc.call("startLogin"))}>
            {busy === "login" ? "Starting…" : "Sign in with GitHub"}
          </button>
        )}
        {status?.signedIn && !status.running ? (
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => run("start", () => rpc.call("start"))}>
            {busy === "start" ? "Starting…" : "Start copilot-api"}
          </button>
        ) : null}
        {status?.running ? (
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => run("stop", () => rpc.call("stop"))}>
            Stop copilot-api
          </button>
        ) : null}
        <button type="button" className={BUTTON} disabled={busy !== null} onClick={refresh}>
          Refresh
        </button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "claude-copilot-plan", component: PlanCard });
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: PROVIDER_ID, icon: ClaudeCopilotAcpIcon });
  app.slots.settingsSection({
    id: "copilot",
    title: "GitHub Copilot",
    description: "GitHub sign-in and the copilot-api that Claude Code (Copilot ACP) threads run through.",
    component: SettingsSection,
  });
});
