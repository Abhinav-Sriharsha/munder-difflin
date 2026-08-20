'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-crush-config-'));
}

test('crush provider points CRUSH_GLOBAL_CONFIG at the agent directory', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const hive = new HiveManager(() => home);
  // ensureAgent on a proxy-tier provider spawns a real hive-proxy sidecar
  // (ChildProcess + two sockets). Without this the handle keeps the test
  // process alive forever and wedges the whole `node --test test/*` run.
  t.after(() => { try { hive.stopAllProxyBridges(); } catch { /* already gone */ } });
  const injection = await hive.ensureAgent({
    id: 'crush-1',
    name: 'Crush Worker',
    provider: 'crush',
    cwd: home
  });

  const agentDir = path.join(home, 'hive', 'agents', 'crush-1');
  assert.equal(injection.env.CRUSH_GLOBAL_CONFIG, agentDir);
  assert.equal(injection.env.CRUSH_GLOBAL_DATA, path.join(agentDir, '.crush-data'));

  const configPath = path.join(agentDir, 'crush.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.providers.openai.base_url.startsWith('http://127.0.0.1:'), true);
});
