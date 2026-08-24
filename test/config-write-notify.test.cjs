'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts resolves its file through Electron's app.getPath(). Point that one
// dependency at a throwaway userData root so this test never touches the real
// application config.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-notify-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { writeConfig, readConfig, onConfigWritten, setAgentTokenCap, resetConfig } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('a config write notifies subscribers with the persisted config', () => {
  const seen = [];
  const off = onConfigWritten((next) => seen.push(next));

  const returned = writeConfig({ orchestratorMaySpawn: true });

  // A single logical write can persist more than once — reading the config runs
  // any pending migration, which persists in its own right. The contract is
  // that subscribers end up holding what the caller was handed back, not that
  // exactly one notification arrives.
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen[seen.length - 1], returned);
  assert.equal(seen[seen.length - 1].orchestratorMaySpawn, true);
  off();
});

// Not every field is written through writeConfig — agent token caps, and the
// reset flow below, each persist by their own route. Subscribing at the file
// write is what makes them all announce; these two tests are what stop a future
// refactor from quietly moving the hook back up into writeConfig.
test('a token-cap write notifies too, not just writeConfig', () => {
  const seen = [];
  const off = onConfigWritten((next) => seen.push(next));

  const returned = setAgentTokenCap('jim', 100);

  assert.ok(seen.length >= 1);
  assert.deepEqual(seen[seen.length - 1], returned);
  assert.equal(seen[seen.length - 1].agentTokenCaps.jim, 100);
  off();
});

test('resetting the config notifies as well', () => {
  const seen = [];
  const off = onConfigWritten((next) => seen.push(next));

  resetConfig();

  // Listeners receive the config as PERSISTED. resetConfig hands its caller a
  // trigger-enriched view of the same defaults, so the two differ by design and
  // this asserts the reset reached subscribers rather than equality with it.
  assert.ok(seen.length >= 1);
  assert.equal(seen[seen.length - 1].onboardingComplete, false);
  off();
});

test('unsubscribing stops the notifications', () => {
  const seen = [];
  const off = onConfigWritten((next) => seen.push(next));
  writeConfig({ notifications: true });
  const countWhileSubscribed = seen.length;
  assert.ok(countWhileSubscribed >= 1);

  off();
  writeConfig({ notifications: false });

  assert.equal(seen.length, countWhileSubscribed);
});

test('a listener that throws neither fails the write nor starves the next listener', () => {
  const reached = [];
  const offBad = onConfigWritten(() => { throw new Error('window is gone'); });
  const offGood = onConfigWritten((next) => reached.push(next));

  // The write itself must still return normally and still land on disk.
  const returned = writeConfig({ autoMode: true });

  assert.equal(returned.autoMode, true);
  assert.equal(readConfig().autoMode, true);
  assert.ok(reached.length >= 1);
  offBad(); offGood();
});
