'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  compactionCommandForProvider,
  compactionPromptFallback,
  remoteControlCommandForProvider,
  terminalReadySettleMs,
  terminalReadyToReceive
} = loadTs('src/shared/providerAutomation.ts');

test('each provider receives only its supported compaction syntax', () => {
  const claude = compactionCommandForProvider('claude');
  const codex = compactionCommandForProvider('codex');
  const grok = compactionCommandForProvider('grok');
  const kimi = compactionCommandForProvider('kimi');

  assert.match(claude, /^\/compact Summarise exactly/);
  assert.equal(codex, '/compact');
  assert.match(grok, /^\/compact Summarise exactly/);
  assert.match(kimi, /^\/compact Summarise exactly/);
  assert.equal(compactionCommandForProvider('antigravity'), null);
  assert.equal(compactionCommandForProvider('custom'), null);
  assert.match(compactionPromptFallback(), /^Summarise the current task/);
});

test('Claude alone receives a remote-control slash command', () => {
  assert.equal(remoteControlCommandForProvider('claude', 'Michael'), '/remote-control Michael');
  assert.equal(remoteControlCommandForProvider('codex', 'Jim'), null);
  assert.equal(remoteControlCommandForProvider('grok', 'Grok'), null);
  assert.equal(remoteControlCommandForProvider('kimi', 'Pam'), null);
});

test('provider readiness policies allow each TUI to settle', () => {
  assert.equal(terminalReadySettleMs('claude'), 400);
  assert.equal(terminalReadySettleMs('codex'), 500);
  assert.equal(terminalReadySettleMs('grok'), 500);
  assert.equal(terminalReadySettleMs('kimi'), 650);
});

test('continuous TUI repainting cannot block terminal readiness', () => {
  assert.equal(terminalReadyToReceive(false, 10_000, 'codex'), false);
  assert.equal(terminalReadyToReceive(true, 499, 'codex'), false);
  assert.equal(terminalReadyToReceive(true, 500, 'codex'), true);
  assert.equal(terminalReadyToReceive(undefined, 500, 'codex'), true);
});
