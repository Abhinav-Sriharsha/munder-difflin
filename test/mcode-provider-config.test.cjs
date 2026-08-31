'use strict';

/**
 * MiniMax Code (`mcode`) bridge.
 *
 * mcode's interactive root command declares a CLOSED flag set — `[prompt]
 * --session -c/--continue --tui-mode --resume` — and then calls
 * `allowExcessArguments(false)`, so an unrecognized flag is a hard startup error.
 * `--model` and `--permission` live only on `mcode exec`, which exits per turn.
 * A TUI-resident hive worker therefore cannot receive its model or its permission
 * posture on argv: both are written into `$MINIMAX_DATA_DIR/config.yaml`, which is
 * also the directory mcode scans for lifecycle hooks.
 *
 * These tests pin that contract end to end — the env var, the two config keys and
 * their auto-mode gating, and hook files that survive mcode's OWN parser rules
 * (frontmatter + a fenced bash block), which are re-implemented below verbatim
 * from the shipped bundle so a formatting change here fails loudly instead of
 * silently producing files mcode skips with a warning.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, mcodeHookFile } = loadTs('src/main/hive.ts');

// --- mcode's own parser rules, transcribed from the shipped bundle -------------
// BA(): frontmatter is required; `hookEvent` (or `event`) and a `type` of
// script/bash/prompt are required; priority/timeout are numbers when present.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
// V$(): a script hook's command is pulled out of the FIRST bash/shell/sh fence.
const SCRIPT_FENCE = /```(?:bash|shell|sh)\s*\n([\s\S]*?)```/;

function parseMcodeHook(text) {
  const fm = FRONTMATTER.exec(text);
  assert.ok(fm, 'mcode rejects a hook file with no frontmatter');
  const front = Object.fromEntries(
    fm[1].split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    })
  );
  const body = text.slice(fm[0].length);
  const fence = SCRIPT_FENCE.exec(body);
  return { front, command: fence ? fence[1].trim() : null };
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcode-config-'));
}

async function spawnMcode(t, opts = {}) {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const injection = await hive.ensureAgent(
    { id: 'mcode-1', name: 'MiniMax Worker', provider: 'mcode', cwd: home },
    opts
  );
  return { home, injection, agentDir: path.join(home, 'hive', 'agents', 'mcode-1') };
}

test('mcode gets a per-agent MINIMAX_DATA_DIR, not the user\'s ~/.minimax', async (t) => {
  const { injection, agentDir } = await spawnMcode(t, { autoMode: true });
  assert.equal(injection.env.MINIMAX_DATA_DIR, path.join(agentDir, '.minimax'));
  assert.notEqual(injection.env.MINIMAX_DATA_DIR, path.join(os.homedir(), '.minimax'));
  // The hooks bridge must also arm the socket the shim posts to.
  assert.ok(injection.env.HIVE_SOCK, 'HIVE_SOCK is what the cth-hook shim talks to');
});

test('the model reaches the CLI through config.yaml, never through argv', async (t) => {
  const { injection, agentDir } = await spawnMcode(t, { model: 'MiniMax-M3', autoMode: true });
  const config = fs.readFileSync(path.join(agentDir, '.minimax', 'config.yaml'), 'utf8');
  assert.match(config, /^defaultModel: "MiniMax-M3"$/m);
  // The spawn injection must stay flag-free — anything here lands on a command
  // line that mcode refuses to start with.
  assert.equal(injection.args.includes('--model'), false, 'no --model on argv');
  assert.equal(injection.args.includes('--permission'), false, 'no --permission on argv');
});

test('auto mode gates permissionMode exactly like every other engine\'s auto flag', async (t) => {
  const on = await spawnMcode(t, { autoMode: true });
  assert.match(
    fs.readFileSync(path.join(on.agentDir, '.minimax', 'config.yaml'), 'utf8'),
    /^permissionMode: bypassPermissions$/m
  );
  const off = await spawnMcode(t, { autoMode: false });
  assert.match(
    fs.readFileSync(path.join(off.agentDir, '.minimax', 'config.yaml'), 'utf8'),
    /^permissionMode: default$/m
  );
});

test('a "CLI default" model writes no defaultModel at all', async (t) => {
  // Inventing a slug here would override whatever the user configured in mcode
  // itself — the exact failure the OpenCode preset's missing recommended model
  // documents. Absent means absent.
  const { agentDir } = await spawnMcode(t, { autoMode: true });
  const config = fs.readFileSync(path.join(agentDir, '.minimax', 'config.yaml'), 'utf8');
  assert.doesNotMatch(config, /defaultModel/);
});

test('every hook file parses under mcode\'s own rules and runs the cth-hook shim', async (t) => {
  const { agentDir } = await spawnMcode(t, { autoMode: true });
  const hooksDir = path.join(agentDir, '.minimax', 'hooks');
  const files = fs.readdirSync(hooksDir).sort();

  // Stop is the one that matters: it is what turns "status went idle" into an
  // actual inbox drain instead of a bounce to the god.
  assert.ok(files.includes('munder-hive-stop.md'), 'Stop hook is the inbox drain');
  assert.deepEqual(files, [
    'munder-hive-precompact.md', 'munder-hive-postcompact.md',
    'munder-hive-posttooluse.md', 'munder-hive-pretooluse.md',
    'munder-hive-sessionstart.md', 'munder-hive-stop.md',
    'munder-hive-subagentstop.md', 'munder-hive-userpromptsubmit.md'
  ].sort());

  for (const name of files) {
    const { front, command } = parseMcodeHook(fs.readFileSync(path.join(hooksDir, name), 'utf8'));
    assert.ok(front.hookEvent, `${name}: mcode requires hookEvent`);
    assert.equal(front.type, 'script', `${name}: must be a script hook`);
    // Milliseconds here — mcode reads `timeout` as ms and defaults to 3e4. Codex's
    // writer uses SECONDS in the same-named key, which is why this is asserted.
    assert.equal(front.timeout, '30000', `${name}: timeout is milliseconds`);
    assert.ok(command, `${name}: mcode skips a script hook with no bash fence`);
    assert.match(command, /cth-hook\.cjs$/, `${name}: reuses the Claude shim verbatim`);
    // Bundled node, not a bare `node` — hooks run with a stripped PATH. The
    // cross-installer guard for that lives in hive-hook-node.test.cjs, which now
    // parses these .md fences too; asserting the launcher prefix again here would
    // be the same check written weaker.
  }

  // Tool events carry a matcher; session-scoped ones match by definition.
  const tooled = parseMcodeHook(fs.readFileSync(path.join(hooksDir, 'munder-hive-pretooluse.md'), 'utf8'));
  assert.equal(tooled.front.matcher, '".*"');
  const stop = parseMcodeHook(fs.readFileSync(path.join(hooksDir, 'munder-hive-stop.md'), 'utf8'));
  assert.equal(stop.front.matcher, undefined, 'Stop takes no matcher');
});

test('mcodeHookFile omits the matcher key entirely when there is none', () => {
  // An empty `matcher:` would be read as the string "", which mcode anchors to
  // `^$` — a matcher that matches nothing. Omission is the match-everything form.
  const { front, command } = parseMcodeHook(mcodeHookFile('Stop', '/usr/bin/node /h/cth-hook.cjs'));
  assert.equal(front.hookEvent, 'Stop');
  assert.equal('matcher' in front, false);
  assert.equal(command, '/usr/bin/node /h/cth-hook.cjs');
});

test('the login is mirrored as files; state directories stay per-agent', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcode-home-'));
  const home = path.join(base, 'user');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  // Refuse to run rather than read/link the developer's real ~/.minimax.
  assert.equal(os.homedir(), home, 'home redirect failed — aborting');

  const userMinimax = path.join(home, '.minimax');
  fs.mkdirSync(path.join(userMinimax, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(userMinimax, 'auth.json'), '{"token":"user-login"}');
  fs.writeFileSync(path.join(userMinimax, 'credentials.json'), '{"k":1}');
  fs.writeFileSync(path.join(userMinimax, 'config.yaml'), 'permissionMode: acceptEdits\n');
  fs.writeFileSync(path.join(userMinimax, 'sessions', 'other-agent.db'), 'x');

  const hive = new HiveManager(() => home);
  await hive.ensureAgent(
    { id: 'mcode-2', name: 'M', provider: 'mcode', cwd: home },
    { autoMode: true }
  );
  const dataDir = path.join(home, 'hive', 'agents', 'mcode-2', '.minimax');

  // Whatever the credential is called, it came with us — that is the point of
  // mirroring by shape instead of by filename.
  for (const f of ['auth.json', 'credentials.json']) {
    assert.equal(fs.existsSync(path.join(dataDir, f)), true, `${f} must reach the worker`);
    assert.equal(fs.readFileSync(path.join(dataDir, f), 'utf8'),
      fs.readFileSync(path.join(userMinimax, f), 'utf8'), `${f} must resolve to the user's file`);
  }
  // …but the session store must NOT be shared: one sqlite store across concurrent
  // workers is contention plus a cross-agent history leak.
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions')), false,
    'state directories must stay per-agent, not link back to the user\'s');
  // And our config wins over the user's, without losing the rest of their file.
  const config = fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8');
  assert.match(config, /^permissionMode: bypassPermissions$/m);
  assert.doesNotMatch(config, /acceptEdits/, 'the user\'s value must be overridden, not duplicated');

  // Idempotent: a second spawn over the same dir must not throw or double-link.
  await hive.ensureAgent(
    { id: 'mcode-2', name: 'M', provider: 'mcode', cwd: home },
    { autoMode: false }
  );
  assert.match(fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8'),
    /^permissionMode: default$/m, 'respawn re-applies the current auto-mode state');
});

test('a user config.yaml is preserved, and our keys override rather than duplicate', async (t) => {
  const { HiveManager: HM } = loadTs('src/main/hive.ts');
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HM(() => home);

  // Exercise the stripper directly: reformatting a user's whole YAML with a
  // library would silently drop their comments, so this is line-based and its
  // one real hazard is eating a NESTED key of the same name.
  const strip = hive.stripTopLevelYamlKeys.bind(hive);
  const out = strip([
    '# my settings',
    'permissionMode: acceptEdits',
    'defaultModel: SomethingElse',
    'provider:',
    '  minimax:',
    '    defaultModel: keep-me',
    'sessionTitle:',
    '  enabled: false'
  ].join('\n'), ['permissionMode', 'defaultModel']);

  assert.doesNotMatch(out, /^permissionMode:/m, 'top-level key removed');
  assert.doesNotMatch(out, /^defaultModel:/m, 'top-level key removed');
  assert.match(out, /^# my settings$/m, 'comments survive');
  assert.match(out, /^ {4}defaultModel: keep-me$/m, 'a NESTED same-named key is left alone');
  assert.match(out, /^ {2}enabled: false$/m, 'unrelated blocks survive intact');
});
