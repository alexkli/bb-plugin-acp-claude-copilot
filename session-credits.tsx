// Thread context segment: Copilot AI credits the thread's Claude Code session
// has used so far, as copilot-api recorded them. Shown in the context row above
// the composer of Claude Code (Copilot ACP) threads; the summary toggles a
// breakdown by model below the row.
//
// The value comes from bb's shared RPC query cache. While a window shows the
// segment, the server watches the thread's usage and invalidates the read
// when it changes (server.ts, sessionCredits), so the client doesn't poll.
import {
  experimental_useRpcQuery,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { appContract, type SessionCredits, type SessionUsage } from "./contract";

const DOLLARS_PER_CREDIT = 0.01;

function useSessionCredits(threadId: string): SessionCredits | null {
  return experimental_useRpcQuery({ contract: appContract, method: "sessionCredits", input: { threadId } }).data ?? null;
}

/** Only Claude Code (Copilot ACP) threads show the segment. */
export function useSessionCreditsVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const credits = useSessionCredits(threadId);
  return credits !== null && credits.status !== "unsupported";
}

function formatCredits(credits: number): string {
  if (credits === 0) return "0";
  if (credits < 10) return credits.toFixed(2);
  if (credits < 100) return credits.toFixed(1);
  return Math.round(credits).toLocaleString();
}

function formatDollars(credits: number): string {
  return `$${(credits * DOLLARS_PER_CREDIT).toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

function CoinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  );
}

function describe(credits: SessionCredits): string {
  switch (credits.status) {
    case "ok":
      return `Copilot credits this session: ${formatCredits(credits.usage.credits)} (${formatDollars(credits.usage.credits)}), ${credits.usage.requests} requests`;
    case "pending":
      return "Copilot credits: no requests yet";
    case "error":
      return `Copilot credits unavailable: ${credits.message}`;
    default:
      return "Copilot credits";
  }
}

export function SessionCreditsSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const credits = useSessionCredits(threadId);
  if (credits === null || credits.status === "unsupported") return null;
  const usage = credits.status === "ok" ? credits.usage : null;
  const title = describe(credits);
  return (
    <button
      type="button"
      title={isExpanded ? undefined : title}
      aria-label={title}
      aria-expanded={isExpanded}
      disabled={!usage}
      onClick={onToggle}
      className="flex min-h-6 shrink-0 items-center gap-1 rounded px-2 py-1 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:hover:bg-transparent"
      data-testid="acp-claude-copilot-session-credits"
    >
      <CoinIcon />
      <span>{usage ? formatCredits(usage.credits) : "–"}</span>
    </button>
  );
}

export function SessionCreditsDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const credits = useSessionCredits(threadId);
  if (!isExpanded || credits?.status !== "ok") return null;
  return (
    <div className="px-3 pb-2 pt-1">
      <Details usage={credits.usage} sessionId={credits.sessionId} />
    </div>
  );
}

function Details({ usage, sessionId }: { usage: SessionUsage; sessionId: string }) {
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">{formatCredits(usage.credits)} AI credits</span>
        <span className="text-muted-foreground">{formatDollars(usage.credits)}</span>
      </div>
      <div className="text-muted-foreground">
        {usage.requests} requests · {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
        {usage.unpriced > 0 && <> · {usage.unpriced} without a credit amount</>}
      </div>
      {usage.models.length > 0 && (
        <table className="w-full max-w-md">
          <tbody>
            {usage.models.map((m) => (
              <tr key={m.model}>
                <td className="truncate pr-3 font-mono">{m.model}</td>
                <td className="pr-3 text-right text-muted-foreground">{m.requests}×</td>
                <td className="text-right tabular-nums">{formatCredits(m.credits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="text-muted-foreground">
        This thread's Claude Code session, subagents included, as the plugin's copilot-api recorded it. Not an invoice.
      </div>
      <code className="truncate text-[10px] text-muted-foreground">{sessionId}</code>
    </div>
  );
}
