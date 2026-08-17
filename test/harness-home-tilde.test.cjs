'use strict';

/**
 * #140 — onboarding died on `ENOENT: mkdir '~/HarnessAgents'`. The wizard lets
 * the user TYPE the harness-home path, and Node's mkdir treats `~` as a literal
 * directory name. ensureHarnessHome must expand it before touching the disk.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ensureHarnessHome } = loadTs('src/main/config.ts');

test('ensureHarnessHome expands ~ before mkdir (issue #140)', () => {
  const rel = `.md-issue140-test-${process.pid}`;
  const target = path.join(os.homedir(), rel);
  const literalTilde = path.join(process.cwd(), '~');
  try {
    const res = ensureHarnessHome(`~/${rel}`);
    assert.equal(res.ok, true, res.error);
    assert.ok(fs.existsSync(target), 'created under the real home directory');
    assert.ok(!fs.existsSync(literalTilde), 'no literal "~" directory appeared in cwd');
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('an absolute path still works exactly as before', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-'));
  const inner = path.join(target, 'nested', 'home');
  try {
    const res = ensureHarnessHome(inner);
    assert.equal(res.ok, true, res.error);
    assert.ok(fs.existsSync(inner));
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('a failing mkdir still reports ok:false with the error', () => {
  // A path THROUGH a regular file cannot be created.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-'));
  const file = path.join(target, 'plain-file');
  fs.writeFileSync(file, 'x');
  try {
    const res = ensureHarnessHome(path.join(file, 'child'));
    assert.equal(res.ok, false);
    assert.ok(res.error && res.error.length > 0);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
