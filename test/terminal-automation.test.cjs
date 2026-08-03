'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  canAutomateTerminal,
  isStaleTerminalDraft,
  opensInteractiveTerminalUi,
  shouldFollowTerminalOutput,
  terminalAutomationBlock,
  STALE_INPUT_MS
} = loadTs('src/renderer/src/components/terminalAutomation.ts');

test('interactive provider commands pause queue automation', () => {
  assert.equal(opensInteractiveTerminalUi('/model'), true);
  assert.equal(opensInteractiveTerminalUi(' /provider '), true);
  assert.equal(opensInteractiveTerminalUi('/permissions allow'), true);
  assert.equal(opensInteractiveTerminalUi('/compact'), false);
  assert.equal(opensInteractiveTerminalUi('implement this'), false);
});

test('terminal automation waits for user drafts and interactive states', () => {
  const ready = { exited: false, pickerOpen: false, inputDirty: false, settleUntil: 0 };
  assert.equal(canAutomateTerminal(ready, 100), true);
  assert.equal(canAutomateTerminal({ ...ready, inputDirty: true }, 100), false);
  assert.equal(canAutomateTerminal({ ...ready, pickerOpen: true }, 100), false);
  assert.equal(canAutomateTerminal({ ...ready, exited: true }, 100), false);
  assert.equal(canAutomateTerminal({ ...ready, settleUntil: 101 }, 100), false);
});

test('an abandoned draft stops blocking delivery once it goes stale', () => {
  const typedAt = 1_000_000;
  const draft = {
    exited: false, pickerOpen: false, inputDirty: true,
    settleUntil: 0, inputDirtyAt: typedAt
  };
  // Fresh draft: the user is mid-sentence, automation must not type over it.
  assert.equal(canAutomateTerminal(draft, typedAt + 1), false);
  assert.equal(isStaleTerminalDraft(draft, typedAt + 1), false);
  // Untouched past the window: the queue must not stay wedged forever.
  assert.equal(isStaleTerminalDraft(draft, typedAt + STALE_INPUT_MS), true);
  assert.equal(canAutomateTerminal(draft, typedAt + STALE_INPUT_MS), true);
  // A draft with no timestamp keeps the old never-expires behavior.
  assert.equal(canAutomateTerminal({ ...draft, inputDirtyAt: undefined }, typedAt + 1e9), false);
});

test('automation block reports why delivery is held', () => {
  const ready = { exited: false, pickerOpen: false, inputDirty: false, settleUntil: 0 };
  assert.equal(terminalAutomationBlock(ready, 100), null);
  assert.equal(terminalAutomationBlock({ ...ready, exited: true }, 100), 'exited');
  assert.equal(terminalAutomationBlock({ ...ready, pickerOpen: true }, 100), 'picker');
  assert.equal(terminalAutomationBlock({ ...ready, inputDirty: true }, 100), 'draft');
  assert.equal(terminalAutomationBlock({ ...ready, settleUntil: 101 }, 100), 'settling');
  // A picker outranks a draft: both are true while a slash menu is open.
  assert.equal(
    terminalAutomationBlock({ ...ready, pickerOpen: true, inputDirty: true }, 100),
    'picker'
  );
});

test('terminal output follows only when already at the bottom', () => {
  assert.equal(shouldFollowTerminalOutput(100, 100), true);
  assert.equal(shouldFollowTerminalOutput(99, 100), true);
  assert.equal(shouldFollowTerminalOutput(80, 100), false);
});
