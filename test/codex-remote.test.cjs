'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  codexRemoteAliasPath,
  codexRemoteEndpoint,
  withCodexRemoteArgs
} = loadTs('src/shared/codexRemote.ts');

test('Codex remote uses a short stable per-agent home alias', () => {
  const first = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const again = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const other = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-2', '/tmp');
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.ok(first.length < 80);
  assert.match(codexRemoteEndpoint(first), /^unix:\/\/\/tmp\//);
});

test('remote endpoint precedes both fresh and resumed Codex invocations', () => {
  const endpoint = 'unix:///tmp/munder-codex/a/app-server-control/app-server-control.sock';
  assert.deepEqual(
    withCodexRemoteArgs(['--model', 'gpt-5.6-sol', 'hello'], endpoint),
    ['--remote', endpoint, '--model', 'gpt-5.6-sol', 'hello']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['resume', 'session-id', '--model', 'gpt-5.6-sol'], endpoint),
    ['--remote', endpoint, 'resume', 'session-id', '--model', 'gpt-5.6-sol']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['--remote', endpoint, 'resume'], endpoint),
    ['--remote', endpoint, 'resume']
  );
});
