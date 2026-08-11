'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { LimitGate, scopeFor } = loadTs('src/main/limitGate.ts');
const {
  QUOTA_BACKOFF_MS, MAX_HOLD_MS, createLimitDetector, scopeFor: sharedScopeFor
} = loadTs('src/shared/rateLimit.ts');

const NOW = Date.parse('2026-08-10T20:00:00Z');
const MIN = 60_000;

const quota = (over = {}) => ({
  tier: 'quota',
  resetAt: NOW + 60 * MIN,
  resetSource: 'stated',
  evidence: "You've hit your session limit · resets 3pm",
  ...over
});

/* ───────────────────────────────── scoping ───────────────────────────────── */

test('a limit holds every agent on the same provider, not just the one that saw it', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'worker-1', provider: 'claude', signal: quota(), now: NOW });

  // The account is spent, so a sibling that has not spoken yet is already behind
  // the same wall — holding only worker-1 would lose worker-2's next message.
  assert.ok(gate.holdFor('claude', 'worker-2'));
  // A different CLI is a different account and keeps working.
  assert.equal(gate.holdFor('codex', 'worker-3'), null);
});

test('custom binaries hold per agent, since they share no account', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'custom', signal: quota(), now: NOW });
  assert.ok(gate.holdFor('custom', 'a'));
  assert.equal(gate.holdFor('custom', 'b'), null);
  assert.equal(scopeFor('custom', 'a'), 'agent:a');
  assert.equal(scopeFor('claude', 'a'), 'provider:claude');
});

/* ─────────────────────────── arming and re-arming ────────────────────────── */

test('re-arming keeps the later reset — a repaint cannot shorten a hold', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'claude', signal: quota({ resetAt: NOW + 60 * MIN }), now: NOW });
  const merged = gate.arm({
    agentId: 'a', provider: 'claude',
    signal: quota({ resetAt: NOW + 10 * MIN, evidence: 'stale frame' }),
    now: NOW + 1000
  });
  assert.equal(merged.resetAt, NOW + 60 * MIN);
});

test('a throttle hold upgrades to quota but never back down', () => {
  const gate = new LimitGate();
  gate.arm({
    agentId: 'a', provider: 'grok',
    signal: { tier: 'throttle', resetAt: NOW + MIN, resetSource: 'estimated', evidence: '429' },
    now: NOW
  });
  const up = gate.arm({ agentId: 'a', provider: 'grok', signal: quota(), now: NOW + 100 });
  assert.equal(up.tier, 'quota');

  const down = gate.arm({
    agentId: 'a', provider: 'grok',
    signal: { tier: 'throttle', resetAt: NOW + 5 * MIN, resetSource: 'estimated', evidence: '429' },
    now: NOW + 200
  });
  assert.equal(down.tier, 'quota');
});

test('an estimated reset escalates each time the wall is still there', () => {
  const gate = new LimitGate();
  const est = { tier: 'quota', resetAt: 0, resetSource: 'estimated', evidence: 'Session limit reached' };

  let t = NOW;
  const first = gate.arm({ agentId: 'a', provider: 'claude', signal: est, now: t });
  assert.equal(first.resetAt - t, QUOTA_BACKOFF_MS[0]);

  // Timer lifts, we try again, and the CLI says the same thing — but only after
  // a message really went out, so this is a genuine second rejection.
  t = first.resetAt;
  gate.sweep(t);
  gate.noteDelivery('claude', 'a', t);
  const second = gate.arm({ agentId: 'a', provider: 'claude', signal: est, now: t });
  assert.equal(second.resetAt - t, QUOTA_BACKOFF_MS[1]);
  assert.equal(second.attempts, 2);
});

test('a stated reset is trusted verbatim and never escalated', () => {
  const gate = new LimitGate();
  const hold = gate.arm({
    agentId: 'a', provider: 'claude',
    signal: quota({ resetAt: NOW + 17 * MIN }), now: NOW
  });
  assert.equal(hold.resetAt, NOW + 17 * MIN);
  assert.equal(hold.resetSource, 'stated');
});

test('a hold is clamped to the ceiling however far out the signal claimed', () => {
  const gate = new LimitGate();
  const hold = gate.arm({
    agentId: 'a', provider: 'claude',
    signal: quota({ resetAt: NOW + MAX_HOLD_MS * 4 }), now: NOW
  });
  assert.equal(hold.resetAt, NOW + MAX_HOLD_MS);
});

/* ───────────────────── release, repaint, and genuine re-hits ─────────────── */

test('the same banner repainted just after a release does not re-arm', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'claude', signal: quota(), now: NOW });
  gate.release(scopeFor('claude', 'a'), NOW + MIN);

  // Nothing has been delivered yet, and the words are identical: this is the
  // notice still sitting in the scrollback, not a fresh rejection.
  assert.equal(gate.arm({ agentId: 'a', provider: 'claude', signal: quota(), now: NOW + MIN + 500 }), null);
  assert.equal(gate.holdFor('claude', 'a'), null);
});

test('the same banner after a real delivery IS a fresh rejection', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'claude', signal: quota(), now: NOW });
  gate.release(scopeFor('claude', 'a'), NOW + MIN);
  gate.noteDelivery('claude', 'a', NOW + MIN + 100);

  const again = gate.arm({ agentId: 'a', provider: 'claude', signal: quota(), now: NOW + MIN + 200 });
  assert.ok(again, 'a limit seen after a message actually went out must hold again');
});

test('different wording after a release re-arms even with nothing delivered', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'claude', signal: quota(), now: NOW });
  gate.release(scopeFor('claude', 'a'), NOW + MIN);
  const again = gate.arm({
    agentId: 'a', provider: 'claude',
    signal: quota({ evidence: "You've hit your weekly limit · resets Nov 12" }),
    now: NOW + MIN + 500
  });
  assert.ok(again);
});

/* ────────────────────────────── sweep and expiry ─────────────────────────── */

test('sweep lifts holds whose time has come and reports them', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'claude', signal: quota({ resetAt: NOW + 10 * MIN }), now: NOW });
  gate.arm({ agentId: 'b', provider: 'codex', signal: quota({ resetAt: NOW + 90 * MIN }), now: NOW });

  assert.deepEqual(gate.sweep(NOW + 5 * MIN), []);
  const lifted = gate.sweep(NOW + 11 * MIN);
  assert.equal(lifted.length, 1);
  assert.equal(lifted[0].provider, 'claude');
  assert.equal(gate.holdFor('claude', 'a'), null);
  assert.ok(gate.holdFor('codex', 'b'));
});

test('list is soonest-first, and keeps an expired hold until it is swept', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'codex', signal: quota({ resetAt: NOW + 90 * MIN }), now: NOW });
  gate.arm({ agentId: 'b', provider: 'claude', signal: quota({ resetAt: NOW + 10 * MIN }), now: NOW });
  assert.deepEqual(gate.list().map((h) => h.provider), ['claude', 'codex']);

  // Past claude's reset but with no sweep — this is exactly the "resume
  // automatically: off" steady state, and the hold must still be listed so the
  // UI can offer a resume button instead of showing a stopped floor with no
  // explanation.
  assert.deepEqual(gate.list().map((h) => h.provider), ['claude', 'codex']);
  assert.ok(gate.holdFor('claude', 'b'));

  gate.sweep(NOW + 30 * MIN);
  assert.deepEqual(gate.list().map((h) => h.provider), ['codex']);
});

test('releaseAll drops everything (the operator turned the guard off)', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'claude', signal: quota(), now: NOW });
  gate.arm({ agentId: 'b', provider: 'codex', signal: quota(), now: NOW });
  assert.equal(gate.releaseAll(NOW).length, 2);
  assert.deepEqual(gate.list(), []);
});

test('serialize persists only holds with time left', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'claude', signal: quota({ resetAt: NOW + 10 * MIN }), now: NOW });
  assert.equal(gate.serialize(NOW).holds.length, 1);
  // An expired hold is worth showing in this session, not worth reinstating
  // after a restart.
  assert.equal(gate.serialize(NOW + 30 * MIN).holds.length, 0);
});

/* ─────────────────────────────── persistence ─────────────────────────────── */

test('a hold with time left survives a restart', () => {
  const gate = new LimitGate();
  gate.arm({ agentId: 'a', provider: 'claude', signal: quota({ resetAt: NOW + 40 * MIN }), now: NOW });
  const saved = gate.serialize(NOW);

  // A limit does not lapse because the app was closed.
  const revived = new LimitGate();
  revived.hydrate(saved, NOW + 5 * MIN);
  assert.ok(revived.holdFor('claude', 'zzz'));
});

test('an expired or malformed persisted hold is discarded, not trusted', () => {
  const gate = new LimitGate();
  gate.hydrate({
    holds: [
      { ...quota(), scope: 'provider:claude', provider: 'claude', agentId: 'a', armedAt: NOW, attempts: 1, resetAt: NOW - MIN },
      { scope: 'provider:codex' },
      null
    ]
  }, NOW);
  assert.deepEqual(gate.list(), []);
});

test('forget clears the rebuff count as well as the hold', () => {
  const gate = new LimitGate();
  const est = { tier: 'quota', resetAt: 0, resetSource: 'estimated', evidence: 'Session limit reached' };
  gate.arm({ agentId: 'a', provider: 'claude', signal: est, now: NOW });
  gate.forget(scopeFor('claude', 'a'));

  const fresh = gate.arm({ agentId: 'a', provider: 'claude', signal: est, now: NOW + MIN });
  assert.equal(fresh.attempts, 1, 'a forgotten scope starts back at the bottom of the ladder');
});

/* ──────────────────────── detector → gate, end to end ────────────────────── */

test('main and the renderer derive the same scope key', () => {
  // The gate files holds under this key and the renderer's drain loop looks
  // them up by it. If the two ever derived it separately and drifted, every
  // hold would be armed and then matched by nobody — a gate that silently
  // does nothing. One exported function, re-exported, is the guarantee.
  assert.equal(scopeFor, sharedScopeFor);
});

test('a real claude banner flows from pty chunk to a held provider', () => {
  const gate = new LimitGate();
  const detector = createLimitDetector('claude');
  const now = Date.parse('2026-08-10T20:00:00Z');

  const signal = detector.push(
    "\x1b[31m✗\x1b[0m You've hit your session limit · resets 3pm (America/Los_Angeles)\r\n",
    now
  );
  assert.ok(signal, 'the banner must be detected');

  const hold = gate.arm({ agentId: 'worker-1', provider: 'claude', signal, now });
  assert.equal(hold.tier, 'quota');
  assert.equal(hold.resetAt, Date.parse('2026-08-10T22:00:00Z'));

  // Held now, and still held five minutes before the reset...
  assert.ok(gate.holdFor('claude', 'worker-1'));
  assert.deepEqual(gate.sweep(hold.resetAt - 5 * MIN), []);
  // ...and clear once the sweep past its reset time lifts it.
  assert.equal(gate.sweep(hold.resetAt + 1000).length, 1);
  assert.equal(gate.holdFor('claude', 'worker-1'), null);
});

test('a screen full of repaints produces exactly one hold', () => {
  const gate = new LimitGate();
  const detector = createLimitDetector('claude');
  const frame = "You've hit your session limit · resets 3pm (America/Los_Angeles)\n";
  let armed = 0;
  let t = NOW;

  // A TUI redrawing at ~10fps for three seconds.
  for (let i = 0; i < 30; i += 1) {
    t += 100;
    const signal = detector.push(frame, t);
    if (!signal) continue;
    if (gate.arm({ agentId: 'a', provider: 'claude', signal, now: t })) armed += 1;
  }
  assert.equal(armed, 1);
  assert.equal(gate.list().length, 1);
});
