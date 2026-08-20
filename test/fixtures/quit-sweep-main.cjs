'use strict';
/**
 * Electron main fixture for test/quit-sweep.electron.test.cjs — runs INSIDE
 * Electron (real lifecycle, real ConPTY-patched node-pty, which is rebuilt for
 * Electron's ABI and therefore unloadable from plain Node).
 *
 * Reproduces the quit path that leaked agent trees on Windows: spawn a real
 * PTY whose child has a child of its own, record the live tree's PIDs to
 * --pid-file, then run PtyManager.killAll() and exit ~1.2s later — the same
 * bounded window teardownAndQuit/will-quit gives the analytics flush. Pre-fix,
 * ensureKilled's 4s unref'd taskkill timer could never fire inside that window,
 * so the tree survived the app; the synchronous win32 sweep must kill it here.
 */
const { app } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pidFile = process.argv.find((a) => a.startsWith('--pid-file='))?.slice('--pid-file='.length);

function bail(code, message) {
  try {
    if (pidFile) fs.writeFileSync(pidFile, JSON.stringify({ error: message }), 'utf8');
  } catch { /* the outer test will report the missing file instead */ }
  console.error(`[fixture] ${message}`);
  app.exit(code);
}

/** All live descendants of `root`, walked from one Win32_Process snapshot. */
function descendantsOf(root) {
  const raw = execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const byParent = new Map();
  for (const row of JSON.parse(raw)) {
    const list = byParent.get(row.ParentProcessId) ?? [];
    list.push(row.ProcessId);
    byParent.set(row.ParentProcessId, list);
  }
  const out = [];
  const stack = [root];
  while (stack.length) {
    for (const child of byParent.get(stack.pop()) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Belt-and-braces: if anything below wedges, die loudly instead of hanging the
// outer test until its own timeout. app.exit() on the happy path preempts this.
setTimeout(() => bail(4, 'fixture timed out'), 45_000);

app.whenReady().then(async () => {
  if (!pidFile) return bail(2, 'missing --pid-file argument');

  const loadTs = require('../load-ts.cjs');
  const { PtyManager } = loadTs('src/main/pty.ts');
  const mgr = new PtyManager();

  // powershell (PTY root) that starts a hidden child powershell — a minimal
  // stand-in for an agent CLI with helper processes of its own.
  const psExe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  const script =
    `Start-Process -WindowStyle Hidden -FilePath '${psExe}' ` +
    `-ArgumentList '-NoProfile','-Command','Start-Sleep 300'; Start-Sleep 300`;
  const res = mgr.spawn({
    id: 'quit-sweep-fixture',
    cwd: os.tmpdir(),
    command: psExe,
    args: ['-NoProfile', '-Command', script]
  });
  if (!res.ok) return bail(2, `pty spawn failed: ${res.error}`);
  const rootPid = mgr.list()[0]?.pid;
  if (!rootPid) return bail(2, 'pty spawned but reported no pid');

  // Wait until the grandchild exists — killing a tree of one proves nothing.
  let pids = [];
  for (let i = 0; i < 30 && pids.length < 2; i++) {
    await sleep(500);
    pids = [rootPid, ...descendantsOf(rootPid)];
  }
  if (pids.length < 2) return bail(2, `tree never grew a descendant (root ${rootPid})`);
  fs.writeFileSync(pidFile, JSON.stringify({ root: rootPid, pids }), 'utf8');

  // The quit path under test: killAll, then exit inside the same ~1.2s window
  // the real teardown allows will-quit's bounded analytics flush.
  mgr.killAll();
  setTimeout(() => app.exit(0), 1_200);
}).catch((e) => bail(3, `fixture threw: ${e?.stack || e}`));
