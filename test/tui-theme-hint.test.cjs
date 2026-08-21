'use strict';

// Crush and OpenCode paint their own (dark) backgrounds regardless of the app
// theme. The spawn now hands every agent a COLORFGBG hint and writes a theme
// into the per agent config dirs of both TUIs. Never into the user's ~/.config.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-tui-theme-'));
}

test('crush: light theme writes options.tui.transparent and COLORFGBG', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  t.after(() => { try { hive.stopAllProxyBridges(); } catch { /* already gone */ } });

  const injection = await hive.ensureAgent(
    { id: 'crush-t', name: 'Crush', provider: 'crush', cwd: home },
    { theme: 'light' }
  );
  assert.equal(injection.env.COLORFGBG, '0;15');
  const config = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'crush-t', 'crush.json'), 'utf8'));
  assert.equal(config.options.tui.transparent, true);
  assert.ok(config.providers, 'the proxy routing is still there');
});

test('crush: dark theme sends the dark hint and still goes transparent', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  t.after(() => { try { hive.stopAllProxyBridges(); } catch { /* already gone */ } });

  const injection = await hive.ensureAgent(
    { id: 'crush-d', name: 'Crush', provider: 'crush', cwd: home },
    { theme: 'dark' }
  );
  assert.equal(injection.env.COLORFGBG, '15;0');
  const config = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'crush-d', 'crush.json'), 'utf8'));
  assert.equal(config.options.tui.transparent, true);
});

test('no theme passed: no hint, no options block (old behaviour)', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  t.after(() => { try { hive.stopAllProxyBridges(); } catch { /* already gone */ } });

  const injection = await hive.ensureAgent({ id: 'crush-n', name: 'Crush', provider: 'crush', cwd: home });
  assert.equal(injection.env.COLORFGBG, undefined);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'crush-n', 'crush.json'), 'utf8'));
  assert.equal(config.options, undefined);
});

test('opencode: theme lands in the per agent config dir as the system theme', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  const injection = await hive.ensureAgent(
    { id: 'oc-1', name: 'OpenCode', provider: 'opencode', cwd: home },
    { theme: 'light' }
  );
  const dir = injection.env.OPENCODE_CONFIG_DIR;
  assert.ok(dir, 'OPENCODE_CONFIG_DIR is set');
  assert.ok(dir.startsWith(path.join(home, 'hive', 'agents', 'oc-1')), 'per agent dir, never ~/.config');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tui.json'), 'utf8')).theme, 'system');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).theme, 'system');
  assert.equal(injection.env.COLORFGBG, '0;15');
});
