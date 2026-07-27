'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  createTerminalRecoveryState,
  requestInitialPtyRedraw,
  scheduleWebglRecovery
} = loadTs('src/renderer/src/components/terminalRecovery.ts');

test('initial attach requests exactly one PTY redraw', () => {
  const state = createTerminalRecoveryState();
  let redraws = 0;
  assert.equal(requestInitialPtyRedraw(state, () => { redraws++; }), true);
  assert.equal(requestInitialPtyRedraw(state, () => { redraws++; }), false);
  assert.equal(redraws, 1);
});

test('WebGL recovery is deduped and repaints after two frames', () => {
  const state = createTerminalRecoveryState();
  const frames = [];
  let repaints = 0;
  const requestFrame = (cb) => frames.push(cb);

  assert.equal(scheduleWebglRecovery(state, requestFrame, () => { repaints++; }), true);
  assert.equal(scheduleWebglRecovery(state, requestFrame, () => { repaints++; }), false);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(repaints, 0);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(repaints, 1);
  assert.equal(state.webglRecoveryPending, false);
});
