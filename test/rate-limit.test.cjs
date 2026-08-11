'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  detectLimit,
  classifyLine,
  parseResetAt,
  createLimitDetector,
  backoffFor,
  QUOTA_BACKOFF_MS,
  MAX_HOLD_MS
} = loadTs('src/shared/rateLimit.ts');

/** 2026-08-10 20:00 UTC = 13:00 PDT. Fixed so clock parsing is host-independent. */
const NOW = Date.parse('2026-08-10T20:00:00Z');
const iso = (s) => Date.parse(s);

/* ─────────────────────────── quota, the real thing ───────────────────────── */

test('claude session-limit banner is a quota hit with the stated reset', () => {
  const hit = detectLimit(
    "You've hit your session limit · resets 3pm (America/Los_Angeles)",
    { provider: 'claude', now: NOW }
  );
  assert.equal(hit.tier, 'quota');
  assert.equal(hit.resetSource, 'stated');
  assert.equal(hit.resetAt, iso('2026-08-10T22:00:00Z'));
});

test('a reset clock already past today means the same time tomorrow', () => {
  // 1pm Los Angeles is exactly `NOW`, so the next one is a day out.
  const hit = detectLimit(
    "You've hit your weekly limit · resets 1pm (America/Los_Angeles)",
    { provider: 'claude', now: NOW }
  );
  assert.equal(hit.resetAt, iso('2026-08-11T20:00:00Z'));
});

test('a dated reset across a DST boundary lands on the right instant', () => {
  // Nov 12 2026 is PST (UTC-8); "now" is still PDT (UTC-7). A single-pass
  // offset conversion would put this an hour out.
  const hit = detectLimit(
    "You've hit your weekly limit · resets Nov 12, 3pm (America/Los_Angeles)",
    { provider: 'claude', now: Date.parse('2026-10-31T20:00:00Z') }
  );
  assert.equal(hit.tier, 'quota');
  assert.equal(hit.resetAt, iso('2026-11-12T23:00:00Z'));
});

test('claude non-interactive epoch form is read as seconds', () => {
  const at = Math.floor(NOW / 1000) + 3600;
  const hit = detectLimit(`Claude AI usage limit reached|${at}`, { provider: 'claude', now: NOW });
  assert.equal(hit.tier, 'quota');
  assert.equal(hit.resetSource, 'stated');
  assert.equal(hit.resetAt, at * 1000);
});

test('bare "Session limit reached" holds even with no time stated', () => {
  const hit = detectLimit('Session limit reached', { provider: 'claude', now: NOW });
  assert.equal(hit.tier, 'quota');
  assert.equal(hit.resetSource, 'estimated');
  assert.equal(hit.resetAt, NOW + QUOTA_BACKOFF_MS[0]);
});

test("pi's own terminal-error vocabulary is quota", () => {
  for (const line of [
    'Monthly usage limit reached',
    'GoUsageLimitError: plan allowance spent',
    'Error: insufficient_quota',
    'quota exceeded for this project'
  ]) {
    assert.equal(detectLimit(line, { provider: 'pi', now: NOW })?.tier, 'quota', line);
  }
});

test('gemini-lineage RESOURCE_EXHAUSTED is quota', () => {
  assert.equal(
    detectLimit('[429] RESOURCE_EXHAUSTED: Quota exceeded for quota metric', { provider: 'qwen', now: NOW })?.tier,
    'quota'
  );
});

/* ────────────────────────── throttle, the other tier ─────────────────────── */

test('transient pushback is a throttle, not a quota hold', () => {
  for (const line of [
    '429 Too Many Requests',
    'API Error: rate_limit_error',
    'Provider overloaded_error, retrying',
    'Server is temporarily limiting requests (not your usage limit)'
  ]) {
    assert.equal(detectLimit(line, { now: NOW })?.tier, 'throttle', line);
  }
});

test('throttle backs off in seconds where quota backs off in minutes', () => {
  const hit = detectLimit('429 Too Many Requests', { now: NOW });
  assert.equal(hit.resetAt - NOW, backoffFor('throttle', 0));
  assert.ok(hit.resetAt - NOW < QUOTA_BACKOFF_MS[0]);
});

test('quota outranks throttle when both are on screen', () => {
  const screen = [
    '429 Too Many Requests — retrying',
    '429 Too Many Requests — retrying',
    "You've hit your session limit · resets 3pm (America/Los_Angeles)"
  ].join('\n');
  assert.equal(detectLimit(screen, { provider: 'claude', now: NOW }).tier, 'quota');
});

/* ─────────────────────────────── false positives ─────────────────────────── */

test('the approaching-limit warning does NOT park the floor', () => {
  // Claude renders this from the same component as the real banner, at ~80%
  // usage. Matching it would stand the fleet down hours early, every session.
  assert.equal(
    detectLimit('Approaching session limit · resets 3pm', { provider: 'claude', now: NOW }),
    null
  );
  assert.equal(detectLimit("You've used 82% of your session limit", { provider: 'claude', now: NOW }), null);
});

test('source code and config mentioning rate limits is not a limit', () => {
  for (const line of [
    'const rateLimitMs = options?.rateLimitMs ?? RATE_LIMIT_MS;',
    '  ...rateLimit ? { rateLimit: true } : {},',
    'export const RATE_LIMIT = 120;',
    '  enforceRateLimit(outputDir, now, rateLimitMs);',
    'Supply a token to download code from GitHub with a higher rate limit',
    '--rate-limit-window 60'
  ]) {
    assert.equal(classifyLine(line), null, line);
  }
});

test('non-LLM limits from bundled runtimes are ignored', () => {
  for (const line of [
    'old generation allocation limit reached',
    '[IncrementalMarking] 90% of the memory limit reached',
    'SRTP event: reached hard key usage limit',
    'Hard turn limit reached (consecutive-interrupt safety net).'
  ]) {
    assert.equal(classifyLine(line), null, line);
  }
});

test('a minified bundle scrolling past cannot trigger a hold', () => {
  const long = `${'x'.repeat(600)} rate_limit_error ${'y'.repeat(600)}`;
  assert.equal(classifyLine(long), null);
});

/* ──────────────────────────── reset-time parsing ─────────────────────────── */

test('relative durations', () => {
  assert.equal(parseResetAt('Try again in 4h 32m', NOW), NOW + (4 * 3600 + 32 * 60) * 1000);
  assert.equal(parseResetAt('rate limited, retry in 90 seconds', NOW), NOW + 90_000);
  assert.equal(parseResetAt('resets in 2 hours', NOW), NOW + 7_200_000);
});

test('retry-after header is seconds per RFC 9110', () => {
  assert.equal(parseResetAt('retry-after: 3600', NOW), NOW + 3_600_000);
});

test('ISO timestamps win over any clock text on the same screen', () => {
  assert.equal(
    parseResetAt('limit resets at 2026-08-10T23:30:00Z (3pm local)', NOW),
    iso('2026-08-10T23:30:00Z')
  );
});

test('24-hour clocks parse', () => {
  assert.equal(
    parseResetAt('resets at 23:30 (America/Los_Angeles)', NOW),
    iso('2026-08-11T06:30:00Z')
  );
});

test('an unparseable reset returns undefined rather than a guess', () => {
  assert.equal(parseResetAt('resets soon', NOW), undefined);
  assert.equal(parseResetAt('resets in 3', NOW), undefined);
  assert.equal(parseResetAt('no time here at all', NOW), undefined);
});

test('a reset further out than the hold ceiling is refused', () => {
  const at = new Date(NOW + MAX_HOLD_MS + 86_400_000).toISOString();
  assert.equal(parseResetAt(`limit resets at ${at}`, NOW), undefined);
});

test('detectLimit clamps a hold to the ceiling', () => {
  const hit = detectLimit('Session limit reached', { now: NOW, attempt: 99 });
  assert.ok(hit.resetAt <= NOW + MAX_HOLD_MS);
});

/* ───────────────────────────── streaming behaviour ───────────────────────── */

test('a banner split across two pty writes is still caught, once', () => {
  const d = createLimitDetector('claude');
  assert.equal(d.push("You've hit your ses", NOW), null);
  const hit = d.push('sion limit · resets 3pm (America/Los_Angeles)\n', NOW + 20);
  assert.equal(hit?.tier, 'quota');
  assert.equal(hit.resetAt, iso('2026-08-10T22:00:00Z'));
});

test('a tui repainting the same banner reports it once', () => {
  const d = createLimitDetector('claude');
  const frame = "You've hit your session limit · resets 3pm (America/Los_Angeles)\n";
  assert.ok(d.push(frame, NOW));
  assert.equal(d.push(frame, NOW + 1000), null);
  assert.equal(d.push(frame, NOW + 5000), null);
  // Past the repeat window it is treated as news again; the gate then decides
  // whether it is a genuine second rejection.
  assert.ok(d.push(frame, NOW + 60_000));
});

test('ansi colouring does not hide a banner', () => {
  const d = createLimitDetector('claude');
  const hit = d.push('[31mSession limit reached[0m\r\n', NOW);
  assert.equal(hit?.tier, 'quota');
});
