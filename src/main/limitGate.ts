/**
 * LIMIT GATE — the floor's response to "you're cut off until 3pm".
 *
 * `shared/rateLimit.ts` decides whether a chunk of terminal output is a limit
 * notice. This decides what the harness does about it: hold a scope, keep the
 * backlog intact, and lift by itself when the window reopens. Nothing is
 * dropped and nothing needs the operator to remember to resend — which is the
 * whole point, because the failure this replaces is silent. A message typed at a
 * rate-limited CLI is swallowed by its TUI, and the human only finds out later
 * that an hour of instructions went nowhere.
 *
 * ── Why holds are per PROVIDER, not per agent ─────────────────────────────────
 * A usage limit belongs to an ACCOUNT. Six workers running `claude` share one
 * subscription, so the moment one of them hits the wall the other five are
 * already behind it — they just haven't spoken yet. Holding only the agent that
 * happened to print the banner would let the next five walk into the same wall
 * one at a time, losing a message each. So the scope key is the provider.
 *
 * The exception is `custom`, where the command is an arbitrary binary the user
 * supplied: two custom agents have no reason to share an account, so those hold
 * per agent. `scopeFor` is the single place that decision lives.
 *
 * This trades a little precision for safety: an operator who deliberately runs
 * two Claude accounts across different agents will see both held when one hits a
 * limit. `release()` is one click, and over-holding costs a wait while
 * under-holding costs lost instructions.
 *
 * Runs in the Electron main process and imports no electron API, so it is
 * unit-testable and so the authority survives a renderer reload — a floor that
 * forgot it was rate limited every time the window refreshed would be worse than
 * no gate at all.
 */
import type { AgentProvider } from '../shared/agentProvider';
import { backoffFor, MAX_HOLD_MS, scopeFor, type LimitHold, type LimitSignal } from '../shared/rateLimit';

// Re-exported so main-process callers have one import for the gate's surface.
export { scopeFor };
export type { LimitHold };

/** Serialisable form persisted across restarts. */
export interface LimitGateState {
  holds: LimitHold[];
}

/**
 * A repaint of the same banner shortly after a release is the same event, not a
 * fresh rejection — TUIs redraw their scrollback constantly. Only an identical
 * evidence line inside this window is suppressed, and only while nothing has
 * actually been delivered since; once a real message goes out, a limit notice
 * is genuinely new information.
 */
const REARM_GUARD_MS = 90_000;

/**
 * How long a scope's rebuff count survives. Past this, a fresh limit is treated
 * as the first one and gets the short end of the backoff ladder again —
 * otherwise an agent that hit its weekly cap once would still be serving
 * two-hour waits a month later.
 */
const ESCALATION_WINDOW_MS = 6 * 60 * 60_000;

export class LimitGate {
  private readonly holds = new Map<string, LimitHold>();
  /** Rebuff memory that outlives the hold itself, so backoff can escalate. */
  private readonly attempts = new Map<string, { count: number; at: number }>();
  /** When a scope was last released, and whether anything has been delivered
   *  through it since — together these are what tell a real re-hit apart from a
   *  repaint of the banner still sitting in the scrollback. */
  private readonly released = new Map<string, { at: number; evidence: string; delivered: boolean }>();

  /**
   * Record a limit notice. Returns the hold in force afterwards, or null when
   * the signal was judged to be a repaint of one already handled.
   *
   * Idempotent on purpose: a TUI may emit the same banner on every frame, and
   * arming must not ratchet the wait upward each time.
   */
  arm(input: {
    agentId: string;
    provider: AgentProvider;
    signal: LimitSignal;
    now: number;
  }): LimitHold | null {
    const { agentId, provider, signal, now } = input;
    const scope = scopeFor(provider, agentId);

    const existing = this.holds.get(scope);
    if (existing && existing.resetAt > now) {
      // Already held. Take the LATER reset and the MORE severe tier: a repaint
      // showing an older, nearer time must never shorten a hold, or a screen
      // redraw could release the floor early into a closed window.
      const merged: LimitHold = {
        ...existing,
        tier: signal.tier === 'quota' ? 'quota' : existing.tier,
        resetAt: Math.max(existing.resetAt, signal.resetAt),
        resetSource: signal.resetAt > existing.resetAt ? signal.resetSource : existing.resetSource,
        evidence: signal.evidence || existing.evidence
      };
      this.holds.set(scope, merged);
      return merged;
    }

    const priorRelease = this.released.get(scope);
    if (
      priorRelease
      && now - priorRelease.at < REARM_GUARD_MS
      && !priorRelease.delivered
      && priorRelease.evidence === signal.evidence
    ) {
      // Same words, no message actually sent since we let go: the terminal is
      // redrawing the notice we already served, not reporting a new one.
      return null;
    }

    const memory = this.attempts.get(scope);
    const attempt = memory && now - memory.at < ESCALATION_WINDOW_MS ? memory.count : 0;
    this.attempts.set(scope, { count: attempt + 1, at: now });

    // An estimated reset is re-derived here rather than trusted from the signal,
    // because only the gate knows how many times this scope has been rebuffed.
    const resetAt = signal.resetSource === 'stated'
      ? signal.resetAt
      : now + backoffFor(signal.tier, attempt);

    const hold: LimitHold = {
      scope,
      provider,
      agentId,
      tier: signal.tier,
      resetAt: Math.min(Math.max(resetAt, now + 1000), now + MAX_HOLD_MS),
      armedAt: now,
      resetSource: signal.resetSource,
      evidence: signal.evidence,
      attempts: attempt + 1
    };
    this.holds.set(scope, hold);
    this.released.delete(scope);
    return hold;
  }

  /**
   * The hold blocking this agent, or null if it may be spoken to.
   *
   * Deliberately does NOT check the clock. A hold ends when it is SWEPT, not
   * when its timestamp passes, because that is the only way "resume
   * automatically: off" can mean anything — under a time-based read the hold
   * would lapse on its own and the setting would be decorative. With auto-resume
   * on, the 15s sweep makes the difference invisible.
   */
  holdFor(provider: AgentProvider, agentId: string): LimitHold | null {
    return this.holds.get(scopeFor(provider, agentId)) ?? null;
  }

  /** Lift a hold — either the timer expired or the operator pressed resume. */
  release(scope: string, now: number): boolean {
    const hold = this.holds.get(scope);
    if (!hold) return false;
    this.holds.delete(scope);
    this.released.set(scope, { at: now, evidence: hold.evidence, delivered: false });
    return true;
  }

  /**
   * Note that a message really did reach a scope. This is what lets a genuine
   * second rejection re-arm inside the guard window: if we sent something and
   * the wall is still there, that is new information rather than an echo.
   */
  noteDelivery(provider: AgentProvider, agentId: string, now: number): void {
    const entry = this.released.get(scopeFor(provider, agentId));
    if (entry) entry.delivered = true;
    void now;
  }

  /**
   * Drop every hold whose time has come. Returns the scopes that just lifted so
   * the caller can tell the floor to start draining again.
   */
  sweep(now: number): LimitHold[] {
    const lifted: LimitHold[] = [];
    for (const [scope, hold] of this.holds) {
      if (hold.resetAt <= now) {
        lifted.push(hold);
        this.holds.delete(scope);
        this.released.set(scope, { at: now, evidence: hold.evidence, delivered: false });
      }
    }
    return lifted;
  }

  /** Every hold in force, soonest first. Includes holds whose time has passed
   *  but which have not been swept — with auto-resume off that is the steady
   *  state, and the UI needs them so it can say "reset time passed, press
   *  resume" rather than showing nothing while the queue stays stopped. */
  list(): LimitHold[] {
    return Array.from(this.holds.values()).sort((a, b) => a.resetAt - b.resetAt);
  }

  /** Drop every hold unconditionally (the operator turned the guard off).
   *  Returns what was lifted so the caller can report it. */
  releaseAll(now: number): LimitHold[] {
    const all = this.list();
    for (const h of all) this.release(h.scope, now);
    return all;
  }

  /** Forget a scope entirely, rebuff count included (agent deleted / provider
   *  switched). Distinct from `release`, which remembers we just let go. */
  forget(scope: string): void {
    this.holds.delete(scope);
    this.attempts.delete(scope);
    this.released.delete(scope);
  }

  /** Persisted form. Only holds with time genuinely left — an expired one is
   *  worth showing in this session's UI but not worth reinstating tomorrow. */
  serialize(now: number): LimitGateState {
    return { holds: this.list().filter((h) => h.resetAt > now) };
  }

  /**
   * Restore holds across a restart. A limit does not lapse because the app was
   * closed, so a hold with time left is reinstated; anything already expired or
   * malformed is discarded rather than trusted.
   */
  hydrate(state: LimitGateState | undefined, now: number): void {
    this.holds.clear();
    for (const h of state?.holds ?? []) {
      if (!h || typeof h.scope !== 'string' || typeof h.resetAt !== 'number') continue;
      if (h.resetAt <= now || h.resetAt > now + MAX_HOLD_MS) continue;
      this.holds.set(h.scope, { ...h, attempts: Number(h.attempts) || 1 });
    }
  }
}
