'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// analytics.ts reads __POSTHOG_KEY__ (an electron-vite `define`, absent here)
// and constructs a real PostHog client. Both are stubbed BEFORE the module is
// loaded so the class can be driven end to end without a network or a key.
globalThis.__POSTHOG_KEY__ = 'test-key';
globalThis.__POSTHOG_HOST__ = 'https://example.invalid';
delete process.env.DO_NOT_TRACK;

const captured = [];
class FakePostHog {
  capture(payload) { captured.push(payload); }
  async shutdown() {}
}
const posthogPath = require.resolve('posthog-node');
require.cache[posthogPath] = {
  id: posthogPath, filename: posthogPath, loaded: true, exports: { PostHog: FakePostHog }
};

const { updateTransition, readVersionStamp, writeVersionStamp, Analytics } =
  loadTs('src/main/analytics.ts');

function stateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-update-applied-'));
}

// ── the decision ────────────────────────────────────────────────────────────

test('a brand-new install is never an update', () => {
  // first_run and update_applied must stay disjoint, or every new install
  // double-counts as an upgrade and the auto-update rate is fiction.
  assert.equal(updateTransition(null, '0.4.5', true), null);
  assert.equal(updateTransition('0.4.4', '0.4.5', true), null);
});

test('an ordinary relaunch reports nothing', () => {
  assert.equal(updateTransition('0.4.5', '0.4.5', false), null);
});

test('a version change reports both ends', () => {
  assert.deepEqual(updateTransition('0.4.4', '0.4.5', false), {
    from_version: '0.4.4',
    to_version: '0.4.5'
  });
});

test('an install that predates stamping reports from unknown', () => {
  // This is the case that makes the FIRST release carrying the event
  // measurable: the id file exists (so the app ran before) but no stamp does.
  assert.deepEqual(updateTransition(null, '0.4.5', false), {
    from_version: 'unknown',
    to_version: '0.4.5'
  });
});

test('a downgrade is reported honestly, from > to', () => {
  assert.deepEqual(updateTransition('0.4.6', '0.4.5', false), {
    from_version: '0.4.6',
    to_version: '0.4.5'
  });
});

test('prerelease versions are a legal shape on both ends', () => {
  assert.deepEqual(updateTransition('0.4.5-beta.1', '0.4.5', false), {
    from_version: '0.4.5-beta.1',
    to_version: '0.4.5'
  });
});

// ── the anonymity guarantee ─────────────────────────────────────────────────

test('a hand-edited stamp cannot smuggle a free-form value out', () => {
  // The stamp is an ordinary file in userData. TELEMETRY.md promises nothing
  // free-form is ever sent, so anything not semver-shaped degrades to unknown
  // rather than riding along as a property value.
  for (const junk of ['/Users/someone/secret-repo', 'not a version', '', '0.4', 'x'.repeat(300)]) {
    const out = updateTransition(junk, '0.4.5', false);
    assert.deepEqual(out, { from_version: 'unknown', to_version: '0.4.5' }, `junk: ${junk}`);
  }
});

test('an unnameable current version reports nothing at all', () => {
  // If we cannot say where we landed there is no event worth sending.
  assert.equal(updateTransition('0.4.4', 'main', false), null);
  assert.equal(updateTransition('0.4.4', '', false), null);
});

// ── the stamp on disk ───────────────────────────────────────────────────────

test('a missing stamp reads as null, not as a throw', () => {
  assert.equal(readVersionStamp(stateDir()), null);
  assert.equal(readVersionStamp('/nope/does/not/exist'), null);
});

test('a stamp round-trips and the trailing newline is not part of it', () => {
  const dir = stateDir();
  writeVersionStamp(dir, '0.4.5');
  assert.equal(readVersionStamp(dir), '0.4.5');
  assert.equal(fs.readFileSync(path.join(dir, 'telemetry-last-version'), 'utf8'), '0.4.5\n');
});

test('an empty stamp file reads as null', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-last-version'), '\n');
  assert.equal(readVersionStamp(dir), null);
});

test('the stamp lives beside the install id and dies with the data dir', () => {
  const dir = stateDir();
  writeVersionStamp(dir, '0.4.5');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(readVersionStamp(dir), null);
});

// ── the sequence a real install walks through ───────────────────────────────

test('upgrade sequence: fires once per version change, never on a relaunch', () => {
  const dir = stateDir();
  const fired = [];
  // firstRun is true only on the boot that mints the id.
  const boot = (version, firstRun = false) => {
    const previous = readVersionStamp(dir);
    const t = updateTransition(previous, version, firstRun);
    if (previous !== version) writeVersionStamp(dir, version);
    if (t) fired.push(`${t.from_version}->${t.to_version}`);
  };

  boot('0.4.4', true); // fresh install
  boot('0.4.4');       // relaunch
  boot('0.4.5');       // auto-update lands
  boot('0.4.5');       // relaunch
  boot('0.4.5');       // relaunch
  boot('0.4.6');       // next update

  assert.deepEqual(fired, ['0.4.4->0.4.5', '0.4.5->0.4.6']);
});

test('the 0.4.4 to 0.4.5 fleet: an existing install with no stamp fires exactly once', () => {
  const dir = stateDir();          // has an install id, no stamp — the real world
  const fired = [];
  const boot = (version) => {
    const previous = readVersionStamp(dir);
    const t = updateTransition(previous, version, false);
    if (previous !== version) writeVersionStamp(dir, version);
    if (t) fired.push(`${t.from_version}->${t.to_version}`);
  };

  boot('0.4.5');
  boot('0.4.5');
  boot('0.4.5');

  assert.deepEqual(fired, ['unknown->0.4.5']);
});


// ── end to end, through the real class ──────────────────────────────────────

/** One app boot against a persistent stateDir. Returns the events it sent. */
function bootApp(dir, appVersion, { enabled = true } = {}) {
  const before = captured.length;
  new Analytics().init({ stateDir: dir, appVersion, enabled });
  return captured.slice(before).map((c) => ({ event: c.event, props: c.properties }));
}

test('e2e: a fresh install sends first_run and app_launched, never update_applied', () => {
  const names = bootApp(stateDir(), '0.4.5').map((e) => e.event);
  assert.deepEqual(names, ['first_run', 'app_launched']);
});

test('e2e: an existing 0.4.4 install starting 0.4.5 reports the upgrade once', () => {
  const dir = stateDir();
  bootApp(dir, '0.4.4');                       // the install exists and is stamped
  const second = bootApp(dir, '0.4.5');        // the update lands
  assert.deepEqual(second.map((e) => e.event), ['update_applied', 'app_launched']);
  const props = second[0].props;
  assert.equal(props.from_version, '0.4.4');
  assert.equal(props.to_version, '0.4.5');
  assert.equal(props.app_version, '0.4.5');    // common props still stamped
  assert.equal(props.$process_person_profile, false); // still an anonymous event

  const third = bootApp(dir, '0.4.5');         // relaunch: nothing extra
  assert.deepEqual(third.map((e) => e.event), ['app_launched']);
});

test('e2e: a live 0.4.4 install with no stamp reports unknown, exactly once', () => {
  // The real 0.4.4 -> 0.4.5 fleet: telemetry-install-id exists, no stamp does.
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-install-id'), 'a-uuid-from-0.4.4\n');

  const first = bootApp(dir, '0.4.5');
  assert.deepEqual(first.map((e) => e.event), ['update_applied', 'app_launched']);
  assert.equal(first[0].props.from_version, 'unknown');

  assert.deepEqual(bootApp(dir, '0.4.5').map((e) => e.event), ['app_launched']);
});

test('e2e: an opted-out install sends nothing and is not back-filled on opting in', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-install-id'), 'a-uuid\n');

  assert.deepEqual(bootApp(dir, '0.4.5', { enabled: false }), []);
  // The stamp still advanced locally, so opting back in later does NOT replay a
  // transition that happened while we were dark.
  assert.equal(readVersionStamp(dir), '0.4.5');
  assert.deepEqual(bootApp(dir, '0.4.5').map((e) => e.event), ['app_launched']);
});

test('e2e: DO_NOT_TRACK sends nothing and writes no stamp at all', () => {
  const dir = stateDir();
  process.env.DO_NOT_TRACK = '1';
  try {
    assert.deepEqual(bootApp(dir, '0.4.5'), []);
    assert.equal(readVersionStamp(dir), null);
    assert.equal(fs.existsSync(path.join(dir, 'telemetry-install-id')), false);
  } finally {
    delete process.env.DO_NOT_TRACK;
  }
});

test('e2e: an unwritable state dir reports no transition, on any boot', () => {
  // The ephemeral-id fallback cannot recognise the install across boots, so a
  // version transition here would fire on EVERY launch. It must fire on none.
  const dir = path.join(os.tmpdir(), 'md-update-applied-file-not-a-dir');
  fs.writeFileSync(dir, 'x');                  // mkdirSync/writeFileSync will throw
  try {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(bootApp(dir, '0.4.5').map((e) => e.event), ['app_launched']);
    }
  } finally {
    fs.rmSync(dir, { force: true });
  }
});

test('e2e: the allowlist still drops a property nobody declared', () => {
  const a = new Analytics();
  a.init({ stateDir: stateDir(), appVersion: '0.4.5', enabled: true });
  const before = captured.length;
  a.track('update_applied', { from_version: '0.4.4', to_version: '0.4.5', repo_path: '/Users/me/secret' });
  const props = captured[before].properties;
  assert.equal(props.from_version, '0.4.4');
  assert.equal('repo_path' in props, false);
});
