'use strict';

/**
 * god authors a spawn request's `command` as a full command LINE, but the PTY
 * layer takes one executable plus argv. The unsplit line made node-pty exec a
 * binary literally named `claude --model … --permission-mode …` → ENOENT → the
 * worker died in under a second WHILE its request archived as `.done`. A
 * failure that presents as success is exactly what a unit test is for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildWorkerLaunch } = loadTs('src/main/workerLaunch.ts');
const { tokenizeCommand } = loadTs('src/shared/commandLine.ts');

const launch = (over = {}) => buildWorkerLaunch({ autoMode: false, ...over });

test('a bare command spawns as itself, no argv', () => {
  const l = launch({ requestCommand: 'claude' });
  assert.equal(l.bin, 'claude');
  assert.deepEqual(l.args, []);
});

test('a flag-carrying command line splits into executable + argv', () => {
  const l = launch({ requestCommand: 'claude --permission-mode plan --verbose' });
  assert.equal(l.bin, 'claude');
  assert.deepEqual(l.args, ['--permission-mode', 'plan', '--verbose']);
});

test('a quoted model value with spaces stays one token', () => {
  const l = launch({ requestCommand: 'agy --model "Gemini 3.1 Pro (High)"' });
  assert.equal(l.bin, 'agy');
  assert.deepEqual(l.args, ['--model', 'Gemini 3.1 Pro (High)']);
});

test('the separate model field applies only when the line did not pick a model', () => {
  const applied = launch({ requestCommand: 'claude', requestModel: 'opus' });
  assert.deepEqual(applied.args, ['--model', 'opus']);
  const deduped = launch({ requestCommand: 'claude --model sonnet', requestModel: 'opus' });
  assert.deepEqual(deduped.args, ['--model', 'sonnet'], 'the command line wins over raw.model');
});

test('auto-mode ON appends bypassPermissions for a claude worker with no stance', () => {
  const l = launch({ requestCommand: 'claude', autoMode: true });
  assert.deepEqual(l.args, ['--permission-mode', 'bypassPermissions']);
  assert.ok(l.command.includes('--permission-mode bypassPermissions'));
});

test('an explicit --permission-mode in the request always wins over auto-mode', () => {
  const l = launch({ requestCommand: 'claude --permission-mode plan', autoMode: true });
  assert.deepEqual(l.args, ['--permission-mode', 'plan']);
});

test('auto-mode leaves non-claude commands untouched, and OFF appends nothing', () => {
  const codex = launch({ requestCommand: 'codex', autoMode: true });
  assert.deepEqual(codex.args, []);
  const off = launch({ requestCommand: 'claude', autoMode: false });
  assert.deepEqual(off.args, []);
});

test('a missing command falls back to the default, then to claude', () => {
  assert.equal(launch({ defaultCommand: 'codex --full-auto' }).bin, 'codex');
  assert.equal(launch({}).bin, 'claude');
});

test('main and renderer split with the SAME tokenizer (shared module)', () => {
  // The old inline copy was byte-identical to the renderer's; now it IS the
  // renderer's. One example locks the routing through the shared function.
  assert.deepEqual(tokenizeCommand(`a "b c" 'd e' f`), ['a', 'b c', 'd e', 'f']);
});
