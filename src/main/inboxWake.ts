/**
 * Worker inbox-wake watchdog — the main-process half of issue #151.
 *
 * Worker wake used to live ONLY in the renderer: one 4s interval enqueues an
 * inbox nudge (deduped on the newest message id), another drains it into the
 * terminal once the agent idles. One wedged store status, one stale dedup key,
 * or one renderer reload losing its in-memory queue, and a durable inbox file
 * sat unread until a full app restart. God never had this problem: the
 * heartbeat re-delivers HIS digest from main on a cadence. This gives workers
 * the same second engine.
 *
 * DECISION ONLY — no I/O, no timers. The index.ts beat feeds it the live
 * registry + pty idle times and broadcasts one `hive:inboxWake` per firing; the
 * RENDERER stays the only terminal writer, re-driving its normal guarded
 * delivery (idle-only, boot grace, pause, draft/picker safety), so this can
 * never bypass the HITL protections hooks.ts deliberately preserves at Stop
 * (never force a continuation from unread mail).
 */

/** An agent must be THIS long idle before it counts as stalled-with-mail —
 *  long enough that a turn wrapping up doesn't get a redundant wake. Idle is
 *  measured from hook boundaries when the provider has them (Stop = idle; any
 *  other real event = busy): raw pty quiet CANNOT tell "mid-turn" from
 *  "sitting at the prompt" for claude's TUI, whose idle prompt repaints
 *  constantly. Hookless providers fall back to pty output recency. */
export const WAKE_QUIET_MS = 30_000;
/** While the same mail stays undrained, re-fire on this cadence — the retry
 *  the renderer's single-shot nudge never had. */
export const WAKE_RETRY_MS = 5 * 60_000;

export interface InboxWakeDeps {
  /** Live registry entries (archived included — they are skipped here). */
  agents: Record<string, { archived?: boolean }>;
  godId: string | null | undefined;
  /** Live pty id for an agent, or undefined when it has none. */
  ptyFor(agentId: string): string | undefined;
  /** ms the agent has been hook-idle (0 = mid-turn / HITL prompt pending), or
   *  null when it has emitted no hook events (hookless provider / booting). */
  hookIdleFor(agentId: string): number | null;
  /** Fallback for hookless agents: ms since the pty last produced output. */
  idleFor(ptyId: string): number | null | undefined;
  /** Ids of the messages currently in the agent's inbox. */
  inboxIds(agentId: string): string[];
}

export interface InboxWakeFire {
  agentId: string;
  /** Same key the renderer's nudge dedup uses (lexically-largest inbox id). */
  newestId: string;
  idleMs: number;
  count: number;
}

/** Per-agent memory of the last firing — owned by the caller so a re-bootstrap
 *  (changeHome) or a test can reset it. */
export type InboxWakeState = Map<string, { newestId: string; at: number }>;

export function inboxWakeTick(
  deps: InboxWakeDeps,
  state: InboxWakeState,
  now: number
): InboxWakeFire[] {
  const fires: InboxWakeFire[] = [];
  for (const [id, a] of Object.entries(deps.agents)) {
    if (a.archived || id === deps.godId) continue; // god has the heartbeat
    const ptyId = deps.ptyFor(id);
    if (!ptyId) continue; // no live terminal to wake
    const ids = deps.inboxIds(id);
    if (ids.length === 0) { state.delete(id); continue; } // drained — forget it
    const idleMs = deps.hookIdleFor(id) ?? deps.idleFor(ptyId) ?? 0;
    if (idleMs < WAKE_QUIET_MS) continue; // mid-turn; it reads mail on its own
    const newestId = [...ids].sort().slice(-1)[0] ?? '';
    const prev = state.get(id);
    // New mail re-fires immediately; the SAME undrained mail re-fires only on
    // the retry cadence (the renderer dedupes by queue content either way).
    if (prev && prev.newestId === newestId && now - prev.at < WAKE_RETRY_MS) continue;
    state.set(id, { newestId, at: now });
    fires.push({ agentId: id, newestId, idleMs, count: ids.length });
  }
  return fires;
}
