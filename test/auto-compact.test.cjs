'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  LARGE_CONTEXT_THRESHOLD,
  SMALL_CONTEXT_THRESHOLD,
  autoCompactThresholdForLimit,
  shouldAutoCompactContext,
  enableOpsStandupAutoCompact
} = loadTs('src/shared/autoCompact.ts');

test('auto-compaction uses 30% for ~250k and 20% for ~1M windows', () => {
  assert.equal(SMALL_CONTEXT_THRESHOLD, 0.3);
  assert.equal(LARGE_CONTEXT_THRESHOLD, 0.2);
  assert.equal(autoCompactThresholdForLimit(258_400), 0.3);
  assert.equal(autoCompactThresholdForLimit(1_000_000), 0.2);
  assert.equal(shouldAutoCompactContext(77_519, 258_400), false);
  assert.equal(shouldAutoCompactContext(77_520, 258_400), true);
  assert.equal(shouldAutoCompactContext(199_999, 1_000_000), false);
  assert.equal(shouldAutoCompactContext(200_000, 1_000_000), true);
});

test('auto-compaction skips missing or invalid telemetry', () => {
  assert.equal(shouldAutoCompactContext(0, 0), false);
  assert.equal(shouldAutoCompactContext(-1, 100), false);
  assert.equal(shouldAutoCompactContext(Number.NaN, 100), false);
});

test('persisted ops standup is enabled without changing other missions', () => {
  const missions = [
    { id: 'ops-standup', enabled: true, autoCompact: false },
    { id: 'custom', enabled: true, autoCompact: false }
  ];
  const migrated = enableOpsStandupAutoCompact(missions);
  assert.equal(migrated[0].autoCompact, true);
  assert.equal(migrated[1].autoCompact, false);
  assert.equal(missions[0].autoCompact, false, 'migration is immutable');
});
