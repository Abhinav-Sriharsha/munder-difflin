'use strict';
/**
 * Agent-provider registry tests. Self-contained, no test framework — run with
 * `node test/agent-provider.test.cjs` (mirrors test/kg-core.test.cjs). The
 * registry lives in TypeScript (src/shared/agentProvider.ts), so we transpile it
 * and its two dependency-free command-group siblings with the bundled `typescript`
 * compiler into a temp dir and require the result. Exercises the copilot preset
 * (GitHub Copilot CLI) end to end: registration, command inference, the print-mode
 * flag shape, and the model/resume passthrough — alongside the pre-existing codex
 * preset as a guard against regressions.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SHARED = path.join(__dirname, '..', 'src', 'shared');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprov-'));
for (const name of ['claudeCommands', 'codexCommands', 'grokCommands', 'agentProvider']) {
  const src = fs.readFileSync(path.join(SHARED, `${name}.ts`), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const ap = require(path.join(out, 'agentProvider.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

console.log('agent-provider registry tests');

test('copilot is a recognized, selectable provider', () => {
  assert.ok(ap.isAgentProvider('copilot'), 'isAgentProvider("copilot")');
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'copilot'), 'preset registered');
});

test('inferAgentProvider maps the copilot binary (with path/flags) to copilot', () => {
  assert.strictEqual(ap.inferAgentProvider('copilot'), 'copilot');
  assert.strictEqual(ap.inferAgentProvider('/usr/local/bin/copilot --model gpt-5.4'), 'copilot');
});

test('copilot preset builds the documented non-interactive print-mode shape', () => {
  const p = ap.providerPreset('copilot');
  assert.strictEqual(p.defaultCommand, 'copilot', 'default command binary');
  assert.strictEqual(p.initialPromptFlag, '-p', 'prompt rides in via -p');
  assert.strictEqual(ap.autoModeFlagForProvider('copilot'), '-s --allow-all-tools --no-ask-user');
  assert.strictEqual(p.autoFlag, '-s --allow-all-tools --no-ask-user', 'autoFlag mirrors autoModeFlag');
});

test('copilot passes model + resume through, non-hiveAware, never auto-receives inbox', () => {
  const p = ap.providerPreset('copilot');
  assert.ok(p.supportsModel && p.modelFlag === '--model', 'model picker + --model');
  assert.strictEqual(p.resumeFlag, '--resume', 'session resume flag');
  assert.strictEqual(p.hiveAware, false, 'no Claude-only identity injection');
  assert.strictEqual(ap.canReceiveInbox('copilot'), false, 'print mode exits, no drain → bounces');
  assert.strictEqual(ap.bridgeOf('copilot'), undefined, 'no hook/proxy bridge');
});

test('cursor is a recognized, selectable, god-eligible provider', () => {
  assert.ok(ap.isAgentProvider('cursor'), 'isAgentProvider("cursor")');
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'cursor'), 'preset registered');
  assert.strictEqual(ap.canReceiveInbox('cursor'), true, 'interactive TUI can receive inbox');
});

test('inferAgentProvider maps cursor-agent (canonical) and agent (alias) to cursor', () => {
  assert.strictEqual(ap.inferAgentProvider('cursor-agent'), 'cursor');
  assert.strictEqual(ap.inferAgentProvider('/Users/me/.local/bin/cursor-agent --model gpt-5.6-luna-high'), 'cursor');
  assert.strictEqual(ap.inferAgentProvider('agent'), 'cursor');
});

test('cursor preset is interactive (no -p), uses force+trust auto flags, types seed into TUI', () => {
  const p = ap.providerPreset('cursor');
  assert.strictEqual(p.defaultCommand, 'cursor-agent', 'default command binary');
  assert.strictEqual(p.initialPromptFlag, undefined, 'no -p; stay interactive');
  assert.strictEqual(p.seedDelivery, 'type-into-tui', 'hive protocol typed after boot');
  assert.strictEqual(ap.autoModeFlagForProvider('cursor'), '--force --trust');
  assert.strictEqual(p.autoFlag, '--force --trust', 'autoFlag mirrors autoModeFlag');
  assert.strictEqual(p.recommendedOrchestratorModel, 'gpt-5.6-luna-high');
  assert.ok(p.supportsModel && p.modelFlag === '--model', 'model picker + --model');
  assert.strictEqual(p.resumeFlag, '--resume', 'session resume flag');
  assert.strictEqual(p.hiveAware, false, 'no Claude-only identity injection');
  assert.strictEqual(ap.bridgeOf('cursor'), undefined, 'no hook/proxy bridge yet');
});

test('mcode is a recognized, selectable, god-eligible provider', () => {
  assert.ok(ap.isAgentProvider('mcode'), 'isAgentProvider("mcode")');
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'mcode'), 'preset registered');
  assert.strictEqual(ap.canReceiveInbox('mcode'), true, 'hooks bridge drains on Stop');
});

test('inferAgentProvider maps the mcode binary, with or without a path', () => {
  assert.strictEqual(ap.inferAgentProvider('mcode'), 'mcode');
  assert.strictEqual(ap.inferAgentProvider('/opt/homebrew/bin/mcode'), 'mcode');
  assert.strictEqual(ap.inferAgentProvider('C:\\Users\\me\\AppData\\npm\\mcode.cmd'), 'mcode');
});

test('mcode preset carries NO argv flags — its TUI rejects unknown ones', () => {
  // mcode's interactive root command declares exactly [prompt] --session
  // -c/--continue --tui-mode --resume and then calls allowExcessArguments(false),
  // so a stray flag is a hard startup error rather than a warning. --model and
  // --permission exist only on `mcode exec`. These four assertions are the guard:
  // if someone "helpfully" fills them in, every mcode spawn dies at boot.
  const p = ap.providerPreset('mcode');
  assert.strictEqual(p.defaultCommand, 'mcode', 'default command binary');
  assert.strictEqual(ap.autoModeFlagForProvider('mcode'), '', 'no auto flag on argv');
  assert.strictEqual(p.autoFlag, '', 'autoFlag mirrors autoModeFlag');
  assert.strictEqual(p.modelFlag, undefined, 'no --model on argv');
  assert.strictEqual(p.initialPromptFlag, undefined, 'no prompt flag');
  // …but the picker must stay visible, and the seed must ride as a positional.
  assert.strictEqual(p.supportsModel, true, 'model picker stays on (config carries it)');
  assert.strictEqual(p.positionalInitialPrompt, true, 'hive protocol rides positionally');
  assert.strictEqual(p.resumeFlag, '--session', 'session resume flag');
  assert.strictEqual(p.hiveAware, false, 'no Claude-only identity injection');
  assert.strictEqual(p.recommendedOrchestratorModel, 'MiniMax-M3');
  assert.strictEqual(p.minNodeMajor, 22, 'engines: >=22.19 <23 || >=24 <27');
});

test('mcode rides the hooks bridge with its own shim', () => {
  assert.deepStrictEqual(ap.bridgeOf('mcode'), { kind: 'hooks', shim: 'mcode' });
});

test('argsWithAutoModeFlag never appends anything for mcode', () => {
  // The generic auto-flag helper runs on every main-only spawn (ephemeral workers,
  // voice hires). An empty preset flag must make it a no-op, not append ''.
  assert.deepStrictEqual(ap.argsWithAutoModeFlag(['hello'], true, 'mcode'), ['hello']);
  assert.deepStrictEqual(ap.argsWithAutoModeFlag(['hello'], false, 'mcode'), ['hello']);
});

test('installInfoForProvider surfaces mcode installer + its higher Node floor', () => {
  const info = ap.installInfoForProvider('mcode', 'darwin');
  assert.strictEqual(info.command, 'npm install -g @minimax-ai/code');
  assert.strictEqual(info.minNodeMajor, 22);
  assert.strictEqual(info.label, 'MiniMax Code');
  // MiniMax's own installer is the node-free rung — the one that still works on a
  // machine whose Node the npm package would refuse.
  assert.ok(info.nativeCommand.includes('filecdn.minimax.chat'), 'node-free rung');
  const win = ap.installInfoForProvider('mcode', 'win32');
  assert.ok(win.nativeCommand.includes('install.ps1'), 'Windows takes the ps1 form');
  // Wrapped verbatim in `cmd /d /s /c "…"`, so an embedded quote truncates it and
  // a bare `|` would pipe in cmd.exe rather than PowerShell.
  assert.ok(!win.nativeCommand.includes('"'), 'no double quotes in the win32 form');
  assert.ok(win.nativeCommand.includes('^|'), 'pipe must be cmd-escaped');
});

test('codex preset still resolves (no regression)', () => {
  assert.strictEqual(ap.inferAgentProvider('codex'), 'codex');
  assert.strictEqual(ap.providerPreset('codex').defaultCommand, 'codex');
});

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll agent-provider tests passed');
