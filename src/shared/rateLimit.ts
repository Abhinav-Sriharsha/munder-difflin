/**
 * RATE / USAGE LIMIT DETECTION — reading "you're cut off until 3pm" out of a
 * terminal, so the floor can park work instead of dropping it.
 *
 * Every supported CLI eventually says some version of "you have hit your limit,
 * come back later". When that happens the harness must stop typing at that agent
 * (each ignored message is a lost instruction the human has to remember and
 * resend), hold the backlog, and start again by itself once the window reopens.
 * This module is the part that decides *whether* a chunk of terminal output is
 * such a message and *when* the window reopens. The parking, the timer and the
 * one-at-a-time replay live in `main/limitGate.ts`.
 *
 * ── Why the patterns are mostly generic rather than per-provider ──────────────
 * The obvious design is a table of per-CLI strings, the way
 * `providerAutomation.ts` maps per-CLI slash commands. It does not work here,
 * and that is a finding rather than a shortcut: the limit text is written by the
 * *API*, not by the CLI. Reading the shipped artefacts of the installed fleet:
 *
 *   - `claude`   DOES own its wording ("You've hit your session limit · resets
 *                3pm", "Session limit reached"), because the subscription limit
 *                is a Claude Code concept. Its labels are a fixed set:
 *                five_hour → "session limit", seven_day → "weekly limit",
 *                seven_day_opus → "Opus limit", seven_day_sonnet → "Sonnet limit".
 *   - `codex`    keeps a `rate limit: ` / `resetsAt` shape from its own client.
 *   - `pi`       ships two classifier regexes of its own, and they draw exactly
 *                the line this module draws: `GoUsageLimitError|
 *                FreeUsageLimitError|Monthly usage limit reached|available
 *                balance|insufficient_quota|out of budget|quota exceeded|billing`
 *                is treated as terminal, while `overloaded|rate.?limit|too many
 *                requests|429|500|502|503|504|…` is treated as retryable.
 *   - `grok`, `agy`, `opencode`, `qwen`, `crush` contain no user-facing limit
 *                copy at all — they surface whatever the provider returned, so
 *                what actually reaches the terminal is the API's own phrasing
 *                ("rate_limit_error", "Too Many Requests", "RESOURCE_EXHAUSTED").
 *
 * So the generic set carries the weight and `PROVIDER_QUOTA_HINTS` adds the few
 * strings a CLI genuinely owns. A provider missing from that table is not
 * unhandled — it is handled by the generic set, which is where its text comes
 * from anyway.
 *
 * ── Two tiers, because they want opposite responses ───────────────────────────
 * Conflating them would be the worst bug this feature could ship: a single
 * transient 503 would park the whole floor for hours.
 *
 *   throttle — momentary. Burst 429s, "overloaded", "temporarily limiting
 *              requests". The CLI itself usually retries these. We back off for
 *              seconds-to-minutes and say little.
 *   quota    — the plan's allowance is spent. Retrying cannot help until the
 *              stated reset. This is the one that parks the queue.
 *
 * Pure and dependency-free: imported by main, preload and renderer, and unit
 * tested directly.
 */
import type { AgentProvider } from './agentProvider';

/** How serious a limit is, and therefore how long to stand down. */
export type LimitTier = 'throttle' | 'quota';

/** Where `resetAt` came from — the UI phrases the countdown differently for a
 *  time the CLI actually told us versus one we picked. */
export type ResetSource = 'stated' | 'estimated';

export interface LimitSignal {
  tier: LimitTier;
  /** Epoch ms we believe access returns. Always set: an unparsed reset falls
   *  back to a backoff estimate so the caller never has to invent one. */
  resetAt: number;
  resetSource: ResetSource;
  /** The matched line, trimmed and capped. Shown to the operator and used to
   *  suppress re-arming from a TUI repainting the same stale banner. */
  evidence: string;
}

/**
 * A limit currently being served — the signal plus who it applies to and for how
 * long. Lives here rather than in `main/limitGate.ts` because all three layers
 * handle it: main owns it, preload passes it, and the renderer renders the
 * countdown from it.
 */
export interface LimitHold {
  /** `provider:claude` or `agent:<id>` — see `scopeFor` in main/limitGate.ts. */
  scope: string;
  provider: AgentProvider;
  tier: LimitTier;
  /** Epoch ms the hold lifts. */
  resetAt: number;
  armedAt: number;
  resetSource: ResetSource;
  /** The line that triggered it. Shown to the operator so a stopped floor is
   *  never a mystery — "why is nothing moving" must be answerable at a glance. */
  evidence: string;
  /** The agent whose terminal produced the signal. */
  agentId: string;
  /** How many times this scope has been re-held in quick succession; drives the
   *  escalating backoff when the CLI never states a reset time. */
  attempts: number;
}

/**
 * The key a hold is filed under.
 *
 * A usage limit belongs to an ACCOUNT, so six workers running `claude` are all
 * behind the same wall the moment one of them hits it — holding only the agent
 * that printed the banner would let the other five walk into it one at a time,
 * losing a message each. `custom` is the exception: an arbitrary user-supplied
 * binary has no reason to share an account with another one, so those hold per
 * agent.
 *
 * Lives here, in the shared module, because main arms holds and the renderer
 * checks them on every drain tick — if the two derived the key separately they
 * could disagree, and a hold nobody matches is a hold that does nothing.
 */
export function scopeFor(provider: AgentProvider, agentId: string): string {
  return provider === 'custom' ? `agent:${agentId}` : `provider:${provider}`;
}

/* ────────────────────────────── negative filters ─────────────────────────── */

/**
 * Lines that mention a limit but are NOT one being hit right now. Checked first,
 * so a warning can never park the floor.
 *
 * `Approaching …` matters most: Claude renders "Approaching session limit ·
 * resets 3pm" from the same component that renders "You've hit your session
 * limit · resets 3pm". Matching the reset clause alone would stand the fleet
 * down at ~80% usage, hours early, every single session.
 */
const NOT_A_LIMIT: RegExp[] = [
  /\bapproaching\b/i,
  /\byou'?ve used\s+\d+%/i,
  /\bclose to your\b/i,
  // Non-LLM limits from runtimes bundled inside these CLIs (V8, liblzma, SRTP…).
  /\b(memory|allocation|marking|heap|nodes|key usage|packet index|turn|element)\s+limit\b/i,
  /\bout of bounds\b/i,
  // Somebody else's rate limit, mentioned in passing.
  /\brate limits?\s+(?:for|on|from)\s+(?:github|npm|homebrew|docker|pypi)\b/i,
  /\bhigher rate limit\b/i,
  // Documentation, flags and source code that merely talk about limits — this
  // repo's own files included, since an agent reading them echoes them to screen.
  /\brate.?limit\w*\s*[:=]\s*(?:[\d{[]|true|false|null|new\b)/i,
  /--[a-z-]*rate.?limit/i,
  /\b(?:function|const|let|var|import|export|class|def)\b.*\brate.?limit/i
];

/* ─────────────────────────────── quota patterns ──────────────────────────── */

/**
 * The allowance is spent. Natural-language shaped on purpose: a bare token like
 * `rate_limit` appears in config, logs and source, whereas "you've hit your
 * session limit" only ever appears when it happened.
 */
const QUOTA_PATTERNS: RegExp[] = [
  /\byou'?ve\s+(?:hit|reached)\s+your\s+[^.\n]{0,48}\blimit\b/i,
  /\b(?:session|weekly|hourly|daily|monthly|opus|sonnet|usage|usage credit|spend|plan|account)\s+limits?\s+(?:reached|exceeded)\b/i,
  /\busage\s+limits?\s+(?:reached|exceeded)\b/i,
  /\bclaude\s+ai\s+usage\s+limit\s+reached\b/i,
  /\bquota\s+(?:exceeded|reached|exhausted)\b/i,
  /\binsufficient[_ ]quota\b/i,
  /\bresource[_ ]exhausted\b/i,
  /\b(?:go|free)usagelimiterror\b/i,
  /\bout\s+of\s+(?:usage\s+)?credits?\b/i,
  /\bcredit\s+balance\s+(?:is\s+)?too\s+low\b/i,
  /\bout\s+of\s+budget\b/i,
  /\bavailable\s+balance\b/i,
  /\bbilling[_ ](?:hard[_ ])?limit\b/i,
  /\bupgrade\s+to\s+(?:increase|raise)\s+your\s+usage\s+limit\b/i
];

/**
 * The handful of strings a CLI genuinely owns, rather than relaying from its
 * API. Everything else reaches the terminal in the provider's own words and is
 * caught by the generic set above.
 */
const PROVIDER_QUOTA_HINTS: Partial<Record<AgentProvider, RegExp[]>> = {
  // Claude Code renders these itself; the label set is fixed (see header).
  claude: [
    /\b(?:session|weekly|opus|sonnet)\s+limit\b[^\n]{0,40}\bresets?\b/i,
    /\/upgrade\s+to\s+keep\s+using\s+claude\s+code\b/i
  ],
  // Codex's client prints its own `rate limit: …` line carrying a `resetsAt`.
  codex: [/\brate limit:\s*[^\n]*\bresets?[_ ]?at\b/i],
  // pi's own terminal-error classifier, verbatim from its bundle.
  pi: [/\bmonthly\s+usage\s+limit\s+reached\b/i]
};

/* ───────────────────────────── throttle patterns ─────────────────────────── */

/** Momentary pushback. The CLI usually retries by itself; we only avoid piling
 *  more work on while it does. */
const THROTTLE_PATTERNS: RegExp[] = [
  /\btoo\s+many\s+requests\b/i,
  /\brate[_ -]?limit(?:ed|_error|error)?\b(?![_ ]?(?:ms|s|window|mutation|prompt|read))/i,
  /\bhttp\s*(?:status\s*)?429\b/i,
  /\b429\b[^\n]{0,24}\b(?:too many|rate)\b/i,
  /\boverloaded(?:_error)?\b/i,
  /\bserver\s+is\s+temporarily\s+limiting\s+requests\b/i,
  /\bslow\s+down\b.*\brequests?\b/i
];

/* ────────────────────────────────── backoff ──────────────────────────────── */

/**
 * How long to stand down when the output says a limit was hit but never says
 * when it lifts — which is the common case outside Claude Code.
 *
 * Escalating rather than fixed, because a wrong guess repeats: if we resume
 * after 15 minutes and the wall is still there, resuming again 15 minutes later
 * burns another message against a closed window. Each rebuff roughly doubles the
 * wait, capped so an unattended floor still recovers the same day.
 */
export const QUOTA_BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000] as const;
export const THROTTLE_BACKOFF_MS = [30_000, 90_000, 300_000, 600_000] as const;

/** Never hold longer than this, whatever the output claimed — a misparsed year
 *  must not park an agent until 2027. */
export const MAX_HOLD_MS = 14 * 24 * 60 * 60_000;

export function backoffFor(tier: LimitTier, attempt: number): number {
  const ladder = tier === 'quota' ? QUOTA_BACKOFF_MS : THROTTLE_BACKOFF_MS;
  const i = Math.min(Math.max(attempt, 0), ladder.length - 1);
  return ladder[i];
}

/* ───────────────────────────── the detector ──────────────────────────────── */

const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
/** Terminal output arrives in arbitrary chunks, so a banner routinely lands
 *  split across two writes. Keep this much of the previous chunk so a message
 *  cut in half is still seen whole exactly once. */
export const DETECTOR_TAIL_CHARS = 2048;
/** A line longer than this is a data dump or a minified bundle scrolling past,
 *  not a status banner — real limit notices are short. */
const MAX_EVIDENCE_LINE = 400;

/** Strip ANSI, box-drawing and cursor noise so patterns see plain prose. */
export function cleanTerminalText(raw: string): string {
  return raw
    .replace(ANSI_RE, '')
    .replace(/[─-╿▀-▟]/g, ' ') // box-drawing / block glyphs
    .replace(/\r/g, '\n');
}

/**
 * Classify one already-cleaned line. Exported for tests and for callers holding
 * a single known line (a hook payload, an API error body) rather than a stream.
 */
export function classifyLine(line: string, provider?: AgentProvider): LimitTier | null {
  const t = line.trim();
  if (!t || t.length > MAX_EVIDENCE_LINE) return null;
  if (NOT_A_LIMIT.some((re) => re.test(t))) return null;
  const hints = provider ? PROVIDER_QUOTA_HINTS[provider] ?? [] : [];
  if (hints.some((re) => re.test(t))) return 'quota';
  if (QUOTA_PATTERNS.some((re) => re.test(t))) return 'quota';
  if (THROTTLE_PATTERNS.some((re) => re.test(t))) return 'throttle';
  return null;
}

/**
 * Find a limit notice in a block of terminal output.
 *
 * Scans every line and keeps the most severe hit, so a screen showing both a
 * transient retry notice and the quota banner underneath is read as quota.
 * `resetAt` prefers a time the output actually stated; failing that it is an
 * estimate from `backoffFor(tier, attempt)`, so the caller always gets a usable
 * timestamp and never has to decide "how long is a while".
 */
export function detectLimit(
  text: string,
  opts: { provider?: AgentProvider; now: number; attempt?: number } = { now: Date.now() }
): LimitSignal | null {
  const now = opts.now;
  const cleaned = cleanTerminalText(text);
  let best: { tier: LimitTier; line: string } | null = null;

  for (const line of cleaned.split('\n')) {
    const tier = classifyLine(line, opts.provider);
    if (!tier) continue;
    if (!best || (tier === 'quota' && best.tier === 'throttle')) best = { tier, line: line.trim() };
    if (best.tier === 'quota') break;
  }
  if (!best) return null;

  // The reset time is frequently on a neighbouring line ("You've hit your
  // weekly limit." / "Try again in 3 hours."), so read it from the whole block
  // rather than from the matched line alone.
  const stated = parseResetAt(cleaned, now);
  const resetAt = stated ?? now + backoffFor(best.tier, opts.attempt ?? 0);
  return {
    tier: best.tier,
    resetAt: Math.min(resetAt, now + MAX_HOLD_MS),
    resetSource: stated ? 'stated' : 'estimated',
    evidence: best.line.slice(0, MAX_EVIDENCE_LINE)
  };
}

/**
 * Stateful wrapper for a live PTY stream. Holds a short tail so a banner split
 * across two writes is still matched, and suppresses the repeat that a TUI
 * repaint would otherwise produce.
 */
export function createLimitDetector(provider?: AgentProvider) {
  let tail = '';
  let lastEvidence = '';
  let lastAt = 0;
  /** A repaint of the same banner within this window is the same event. */
  const REPEAT_WINDOW_MS = 30_000;

  return {
    push(chunk: string, now: number, attempt = 0): LimitSignal | null {
      const hay = tail + chunk;
      tail = hay.slice(-DETECTOR_TAIL_CHARS);
      const hit = detectLimit(hay, { provider, now, attempt });
      if (!hit) return null;
      if (hit.evidence === lastEvidence && now - lastAt < REPEAT_WINDOW_MS) return null;
      lastEvidence = hit.evidence;
      lastAt = now;
      return hit;
    },
    reset(): void { tail = ''; lastEvidence = ''; lastAt = 0; }
  };
}

/* ──────────────────────────── reset-time parsing ─────────────────────────── */

const DUR_UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Pull "when does this lift" out of terminal text, in epoch ms.
 *
 * Tried most-explicit first, so an ISO timestamp is never reinterpreted as a
 * wall clock. Returns undefined rather than guessing — the caller's backoff is a
 * better answer than a bad parse, because a bad parse looks authoritative in the
 * UI while being wrong.
 */
export function parseResetAt(text: string, now: number): number | undefined {
  const t = cleanTerminalText(text);
  for (const attempt of [isoReset, epochReset, relativeReset, dateClockReset, clockReset]) {
    const at = attempt(t, now);
    if (at !== undefined && at > now && at <= now + MAX_HOLD_MS) return at;
  }
  return undefined;
}

/** `2026-08-10T15:04:05Z`, `…+05:30`, or with a space instead of the T. */
function isoReset(t: string, _now: number): number | undefined {
  const m = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/i.exec(t);
  if (!m) return undefined;
  const zone = m[3] ? m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z';
  const parsed = Date.parse(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}${zone}`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * A bare epoch, which Claude's non-interactive mode emits as
 * `Claude AI usage limit reached|1786000000`.
 *
 * Only read next to a limit/reset word: a ten-digit number on its own is far
 * more likely to be a file size, a pid or a hash fragment than a deadline.
 */
function epochReset(t: string, _now: number): number | undefined {
  const m = /(?:limit\s*reached|resets?[_ ]?at|reset|retry|until|expires?)\D{0,12}(1[0-9]{9})(\d{3})?\b/i.exec(t);
  if (!m) return undefined;
  return m[2] ? Number(`${m[1]}${m[2]}`) : Number(m[1]) * 1000;
}

/**
 * `try again in 4h 32m`, `retry after 90 seconds`, `resets in 2 hours`,
 * and the bare header form `retry-after: 3600` (seconds, per RFC 9110).
 */
function relativeReset(t: string, now: number): number | undefined {
  const header = /\bretry[- ]?after\s*[:=]\s*(\d{1,6})\b/i.exec(t);
  if (header) return now + Number(header[1]) * 1000;

  const m = /\b(?:try again|retry|resets?|available|back|wait|again)\b[^.\n]{0,20}?\bin\s+((?:\d+\s*[a-z]+[\s,]*)+)/i.exec(t)
    ?? /\bin\s+(\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?))\b/i.exec(t);
  if (!m) return undefined;

  let total = 0;
  const part = /(\d+)\s*([a-z]+)/gi;
  for (let p: RegExpExecArray | null; (p = part.exec(m[1])) !== null; ) {
    const unit = DUR_UNIT_MS[p[2].toLowerCase()];
    if (!unit) continue;
    total += Number(p[1]) * unit;
  }
  return total > 0 ? now + total : undefined;
}

/** `Nov 12, 3pm` / `Nov 12 at 15:00` — Claude's format past 24 hours out. */
function dateClockReset(t: string, now: number): number | undefined {
  const m = new RegExp(
    `\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s*(?:at\\s+)?` +
    `(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?\\b(?:[^\\n(]{0,20}\\(([A-Za-z_]+/[A-Za-z_+-]+)\\))?`,
    'i'
  ).exec(t);
  if (!m) return undefined;
  const hour = normaliseHour(Number(m[3]), m[5]);
  if (hour === undefined) return undefined;
  const zone = m[6];
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  const year = wallClockParts(now, zone).year;
  const at = fromWallClock({ year, month, day: Number(m[2]), hour, minute: Number(m[4] ?? 0) }, zone);
  // A date without a year that reads as past is next year's (a late-December
  // weekly limit resetting in January).
  return at > now ? at : fromWallClock(
    { year: year + 1, month, day: Number(m[2]), hour, minute: Number(m[4] ?? 0) },
    zone
  );
}

/**
 * A bare wall clock — `resets 3pm`, `resets at 3:30pm (America/Los_Angeles)`,
 * `resets 15:30`. Claude's most common shape, and the fiddliest: it is the only
 * form whose meaning depends on a timezone we are told about but do not live in.
 */
function clockReset(t: string, now: number): number | undefined {
  const m = /\b(?:resets?|renews?|available|again|until|try again)\b[^.\n]{0,16}?\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([A-Za-z_]+\/[A-Za-z_+-]+)\))?/i
    .exec(t);
  if (!m) return undefined;
  // Reject a bare hour with no meridiem and no colon: "resets in 3" is a
  // duration we already failed to parse, not 3 o'clock.
  if (!m[2] && !m[3]) return undefined;
  const hour = normaliseHour(Number(m[1]), m[3]);
  if (hour === undefined) return undefined;

  const zone = m[4];
  const today = wallClockParts(now, zone);
  const at = fromWallClock({ ...today, hour, minute: Number(m[2] ?? 0) }, zone);
  return at > now ? at : at + 86_400_000;
}

function normaliseHour(raw: number, meridiem?: string): number | undefined {
  if (!Number.isFinite(raw)) return undefined;
  if (meridiem) {
    if (raw < 1 || raw > 12) return undefined;
    const pm = meridiem.toLowerCase() === 'pm';
    return raw === 12 ? (pm ? 12 : 0) : raw + (pm ? 12 : 0);
  }
  return raw >= 0 && raw <= 23 ? raw : undefined;
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number }

/**
 * How far ahead of UTC `zone` is at instant `at`, in ms. Falls back to the
 * host's own offset for a zone Intl doesn't know, which is the right default:
 * Claude prints the *operator's* resolved timezone, so "unknown zone" almost
 * always means a bare abbreviation for the zone we are already in.
 */
function zoneOffsetMs(zone: string | undefined, at: number): number {
  if (!zone) return -new Date(at).getTimezoneOffset() * 60_000;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(at));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    // hour12:false yields 24 for midnight in some ICU versions.
    const hour = get('hour') % 24;
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return asUtc - Math.floor(at / 1000) * 1000;
  } catch {
    return -new Date(at).getTimezoneOffset() * 60_000;
  }
}

/** The wall-clock date `at` falls on, as seen from `zone`. */
function wallClockParts(at: number, zone: string | undefined): WallClock {
  const shifted = new Date(at + zoneOffsetMs(zone, at));
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes()
  };
}

/**
 * Turn a wall clock in `zone` back into an instant.
 *
 * Solved twice because the offset depends on the answer: a 3pm reset the day a
 * zone leaves DST sits on a different offset from the one in force right now,
 * and a single-pass conversion lands an hour out. The second pass uses the
 * offset in force at the first pass's guess, which converges everywhere except
 * inside the one ambiguous hour of a fall-back — where either answer is a legal
 * reading of the printed time.
 */
function fromWallClock(w: WallClock, zone: string | undefined): number {
  const naive = Date.UTC(w.year, w.month, w.day, w.hour, w.minute);
  const first = naive - zoneOffsetMs(zone, naive);
  return naive - zoneOffsetMs(zone, first);
}
