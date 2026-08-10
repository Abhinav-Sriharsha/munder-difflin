import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { inferAgentProvider } from '@/store/config';
import { scopeFor, type LimitHold } from '@shared/rateLimit';
import { PixelButton } from './PixelButton';

/**
 * "This agent is capped until 3pm — 4 messages are waiting."
 *
 * Renders nothing unless the agent's provider is actually held, so it costs a
 * hidden div in the common case. When it does appear it has to answer three
 * questions without the operator opening a terminal: WHY we stopped (the CLI's
 * own words), WHEN we start again, and WHAT is waiting. A silent pause with no
 * explanation would be a worse bug than the one this feature fixes.
 */
export function LimitBanner({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const holds = useStore((s) => s.limitHolds);
  const queued = useStore((s) => s.messageQueues[agentId]?.length ?? 0);
  const releaseQueued = useStore((s) => s.releaseQueuedMessage);
  const [, tick] = useState(0);

  const provider = agent ? inferAgentProvider(agent.command, agent.provider) : null;
  const scope = provider ? scopeFor(provider, agentId) : null;
  const hold = scope ? holds.find((h) => h.scope === scope) : undefined;

  // Re-render once a second so the countdown counts. Only while held — an idle
  // floor must not wake React every second for a banner nobody is showing.
  useEffect(() => {
    if (!hold) return;
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [hold?.scope, hold?.resetAt]);

  if (!hold) return null;

  const resumeNow = async (): Promise<void> => {
    await window.cth.limitRelease(hold.scope).catch(() => { /* already lifted */ });
  };

  // "Send anyway" marks the head of the queue manual, which is the same escape
  // hatch the floor-wide delivery pause already uses — one override, one meaning.
  const sendAnyway = (): void => {
    const head = useStore.getState().messageQueues[agentId]?.[0];
    if (head) releaseQueued(agentId, head.id);
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '6px 8px', background: 'var(--cth-paper-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-coral)', flexShrink: 0
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 9,
          color: 'var(--cth-coral)', letterSpacing: '0.04em'
        }}>
          {hold.tier === 'quota' ? 'LIMIT REACHED' : 'THROTTLED'}
        </span>
        <span style={{ fontSize: 11, color: 'var(--cth-ink-900)' }}>
          {hold.provider} paused · {countdown(hold.resetAt)}
        </span>
        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
          {queued === 0
            ? 'nothing queued yet'
            : `${queued} message${queued === 1 ? '' : 's'} held — ${queued === 1 ? 'it goes' : 'they go'} out one at a time`}
        </span>
        <div style={{ flex: 1 }} />
        {queued > 0 && (
          <PixelButton variant="secondary" size="sm" onClick={sendAnyway}>send anyway</PixelButton>
        )}
        <PixelButton variant="primary" size="sm" onClick={resumeNow}>resume now</PixelButton>
      </div>
      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }} title={hold.evidence}>
        {hold.resetSource === 'stated' ? 'Reset time from the CLI' : 'Estimated — the CLI gave no reset time'}
        {' · '}
        {truncate(hold.evidence, 96)}
      </span>
    </div>
  );
}

/**
 * "resumes in 2h 14m" — minutes below an hour, never a bare "0m".
 *
 * Past the reset it says "reset time reached" rather than "resuming…", because
 * the hold may be waiting on the operator: with auto-resume off it sits here
 * until the button is pressed, and promising a resume that never comes would be
 * the worst thing this banner could say.
 */
function countdown(resetAt: number): string {
  const ms = resetAt - Date.now();
  if (ms <= 0) return 'reset time reached';
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `resumes in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `resumes in ${h}h ${m}m` : `resumes in ${h}h`;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Floor-wide summary for the god's Command Center header — one line per hold,
 *  so a limit on an agent nobody has selected is still visible. */
export function LimitSummary() {
  const holds = useStore((s) => s.limitHolds);
  if (!holds.length) return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {holds.map((h: LimitHold) => (
        <span key={h.scope} style={{
          fontSize: 11, color: 'var(--cth-coral)',
          padding: '1px 4px', boxShadow: 'inset 0 0 0 1px var(--cth-coral)'
        }}>
          {h.provider} · {countdown(h.resetAt)}
        </span>
      ))}
    </div>
  );
}
