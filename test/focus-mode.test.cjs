'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { refocusAfterRemoval, focusOnLoad } =
  loadTs('src/renderer/src/store/focusMode.ts');

const agents = (...ids) => ids.map((id) => ({ id }));

// --- re-homing focus mode when an agent goes away --------------------------
// Closing an agent is not a request to leave focus mode. Before this, every
// removal path re-homed selectedId and left fullscreenAgentId dangling, so the
// window fell back to the sidebar the moment you closed the agent you were
// focused on.

test('focus stays put when some OTHER agent is removed', () => {
  assert.equal(refocusAfterRemoval('b', agents('a', 'b', 'c'), 'a'), 'b');
});

test('focus follows the selection when the focused agent is removed', () => {
  assert.equal(refocusAfterRemoval('b', agents('a', 'c'), 'c'), 'c',
    'the removal path already picked a new selection, focus mode should honour it');
});

test('focus falls back to the first agent when the selection is also gone', () => {
  assert.equal(refocusAfterRemoval('b', agents('a', 'c'), null), 'a');
});

test('focus mode ends only once the last agent is gone', () => {
  assert.equal(refocusAfterRemoval('b', agents(), null), null);
});

test('a window that was not in focus mode is never dragged into it', () => {
  assert.equal(refocusAfterRemoval(null, agents('a', 'b'), 'a'), null,
    'removing an agent must not turn focus mode ON');
});

// --- restoring the preference on load --------------------------------------
// The preference is a boolean, not an id: the previously focused agent may not
// exist next launch, and restoring a stale id recreates the dangling reference
// above.

test('focus mode is restored against whoever is selected now', () => {
  assert.equal(focusOnLoad(true, 'a'), 'a');
});

test('no preference means the sidebar, as before', () => {
  assert.equal(focusOnLoad(false, 'a'), null);
});

test('the preference resolves to nothing when there is no agent to focus', () => {
  assert.equal(focusOnLoad(true, null), null,
    'first run, or every agent gone: nothing to show in focus mode');
});
