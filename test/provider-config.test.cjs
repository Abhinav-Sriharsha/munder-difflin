'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  inferAgentProvider,
  isAgentProvider,
  providerPreset
} = loadTs('src/shared/agentProvider.ts');
const {
  buildSpawnCommand,
  decodeProviderModel,
  encodeProviderModel,
  modelProvidersForAgent,
  modelsForProvider
} = loadTs('src/renderer/src/store/config.ts');

const autoConfig = { defaultCommand: 'claude', autoMode: true };

test('Kimi is a first-class inferred provider with autonomous defaults', () => {
  assert.equal(isAgentProvider('kimi'), true);
  assert.equal(inferAgentProvider('kimi --auto'), 'kimi');
  const preset = providerPreset('kimi');
  assert.equal(preset.defaultCommand, 'kimi');
  assert.equal(preset.autoFlag, '--auto');
  assert.equal(preset.supportsModel, true);
  assert.equal(preset.canReceiveInbox, false);
  assert.equal(preset.positionalInitialPrompt, undefined);
});

test('provider commands use matching models and equivalent bypass modes', () => {
  assert.equal(
    buildSpawnCommand(autoConfig, 'claude-sonnet-5', 'claude'),
    'claude --model claude-sonnet-5 --permission-mode bypassPermissions'
  );
  assert.equal(
    buildSpawnCommand(autoConfig, 'gpt-5.6-sol', 'codex'),
    'codex --model gpt-5.6-sol --dangerously-bypass-approvals-and-sandbox'
  );
  assert.equal(
    buildSpawnCommand(autoConfig, 'kimi-code/k3', 'kimi'),
    'kimi --model kimi-code/k3 --auto'
  );
});

test('model picker options stay provider-specific', () => {
  assert.equal(
    modelsForProvider('claude').find((model) => model.id === 'claude-opus-5')?.label,
    'Opus 5 · 1M'
  );
  assert.deepEqual(
    modelsForProvider('codex').map((model) => model.id),
    [undefined, 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
  );
  assert.deepEqual(
    modelsForProvider('kimi').map((model) => model.id),
    [
      undefined,
      'kimi-code/k3',
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed'
    ]
  );
  assert.deepEqual(modelsForProvider('custom'), []);
});

test('Command Center model choices round-trip provider and model', () => {
  const encoded = encodeProviderModel('antigravity', 'Gemini 3.1 Pro (High)');
  assert.deepEqual(
    decodeProviderModel(encoded),
    { provider: 'antigravity', model: 'Gemini 3.1 Pro (High)' }
  );
  assert.deepEqual(
    decodeProviderModel(encodeProviderModel('kimi')),
    { provider: 'kimi', model: undefined }
  );
  assert.equal(decodeProviderModel('unknown:model'), null);
});

test('God only sees providers that can drain hive inbox messages', () => {
  assert.deepEqual(
    modelProvidersForAgent(true).map((preset) => preset.id),
    ['claude', 'codex', 'antigravity']
  );
  assert.deepEqual(
    modelProvidersForAgent(false).map((preset) => preset.id),
    ['claude', 'codex', 'kimi', 'antigravity']
  );
});
