'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  opensInteractiveTerminalUi,
  shouldFollowTerminalOutput
} = loadTs('src/renderer/src/components/terminalAutomation.ts');

test('interactive provider commands pause queue automation', () => {
  assert.equal(opensInteractiveTerminalUi('/model'), true);
  assert.equal(opensInteractiveTerminalUi(' /provider '), true);
  assert.equal(opensInteractiveTerminalUi('/permissions allow'), true);
  assert.equal(opensInteractiveTerminalUi('/compact'), false);
  assert.equal(opensInteractiveTerminalUi('implement this'), false);
});

test('terminal output follows only when already at the bottom', () => {
  assert.equal(shouldFollowTerminalOutput(100, 100), true);
  assert.equal(shouldFollowTerminalOutput(99, 100), true);
  assert.equal(shouldFollowTerminalOutput(80, 100), false);
});
