import { app, ipcMain, shell } from 'electron';
import type { WebContents } from 'electron';
import { request as httpsRequest } from 'node:https';
import { readConfig } from './config';

/**
 * Auto-update from GitHub releases (v0.3.4).
 *
 * Primary path: electron-updater against the `publish` block in
 * electron-builder.yml — the release workflow uploads latest*.yml + zip +
 * blockmaps, macOS builds are Developer ID signed + notarized, so Squirrel.Mac
 * (zip), NSIS, and AppImage all update natively. Downloads happen in the
 * background; installation is ALWAYS user-initiated ("Restart to update" toast
 * → `update:restartAndInstall`). The app never restarts on its own.
 *
 * Fallback path (win-portable exe, unsigned/dev-ish builds, or any updater
 * error): a plain `releases/latest` poll — semver-compare against the running
 * version and show a notify-only toast linking the release page. Same pattern
 * as the landing page's REL upgrade fetch, with the same modest cache so we
 * stay far from the unauthenticated 60/hr rate limit.
 *
 * Everything is gated on the `autoUpdate` HarnessConfig flag (default ON,
 * Settings → General) and on `app.isPackaged` — dev runs never poll.
 */

const REPO = 'chaitanyagiri/munder-difflin';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FALLBACK_CACHE_MS = 60 * 60 * 1000;     // 1h between releases/latest polls

export type UpdateStatus =
  | { state: 'downloaded'; version: string; notes?: string }
  | { state: 'available-manual'; version: string; url: string };

let sendTo: (() => WebContents | null) | null = null;
let started = false;
let fallbackActive = false;
let lastFallbackCheck = 0;
/** Remembered so a toast dismissed by a reload can be re-served on checkNow. */
let lastStatus: UpdateStatus | null = null;

function emit(status: UpdateStatus): void {
  lastStatus = status;
  try { sendTo?.()?.send('update:status', status); } catch { /* window tore down */ }
}

function autoUpdateEnabled(): boolean {
  const cfg = readConfig();
  return cfg.autoUpdate !== false; // default ON
}

/** `1.2.3` -> [1,2,3]; returns null for anything that doesn't look like semver. */
function parseVersion(v: string): number[] | null {
  const m = v.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Notify-only check against releases/latest (no download). Never throws. */
function fallbackCheck(force = false): void {
  const now = Date.now();
  if (!force && now - lastFallbackCheck < FALLBACK_CACHE_MS) return;
  lastFallbackCheck = now;
  try {
    const req = httpsRequest(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/releases/latest`,
        method: 'GET',
        headers: { 'User-Agent': 'munder-difflin-updater', Accept: 'application/vnd.github+json' },
        timeout: 10_000
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 262_144) req.destroy(); });
        res.on('end', () => {
          try {
            const rel = JSON.parse(body) as { tag_name?: string; html_url?: string };
            const tag = rel.tag_name ?? '';
            if (tag && isNewer(tag, app.getVersion())) {
              emit({
                state: 'available-manual',
                version: tag.replace(/^v/, ''),
                url: rel.html_url ?? `https://github.com/${REPO}/releases/latest`
              });
            }
          } catch { /* malformed body — try again next interval */ }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => { /* offline — try again next interval */ });
    req.end();
  } catch { /* never let the fallback take the app down */ }
}

async function nativeCheck(): Promise<void> {
  if (fallbackActive) { fallbackCheck(); return; }
  try {
    const { autoUpdater } = await import('electron-updater');
    await autoUpdater.checkForUpdates();
  } catch {
    fallbackActive = true;
    fallbackCheck();
  }
}

/**
 * Start the updater. Call once from app.whenReady with an accessor for the
 * primary window's webContents. Safe to call in dev (no-ops).
 */
export function initAutoUpdater(getWebContents: () => WebContents | null): void {
  sendTo = getWebContents;

  // IPC surface is registered unconditionally so the renderer can always call it.
  ipcMain.handle('update:restartAndInstall', async () => {
    try {
      const { autoUpdater } = await import('electron-updater');
      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('update:checkNow', async () => {
    if (!app.isPackaged) return { ok: false, error: 'dev build' };
    if (lastStatus) emit(lastStatus); // re-serve a pending status to a fresh window
    await nativeCheck();
    return { ok: true };
  });
  ipcMain.handle('update:openRelease', (_evt, url: unknown) => {
    const href = typeof url === 'string' ? url : `https://github.com/${REPO}/releases/latest`;
    // Only ever open the project's releases page — this is not a generic opener.
    if (!href.startsWith(`https://github.com/${REPO}/`)) return { ok: false };
    void shell.openExternal(href);
    return { ok: true };
  });

  if (!app.isPackaged) return;
  if (started) return;
  started = true;

  void (async () => {
    try {
      const { autoUpdater } = await import('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false; // install ONLY on explicit restart
      autoUpdater.on('update-downloaded', (info) => {
        emit({ state: 'downloaded', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined });
      });
      autoUpdater.on('error', (err) => {
        // Portable exe / missing metadata / offline: degrade to notify-only.
        console.warn('[updater] native update failed; falling back to notify-only:', err?.message ?? err);
        fallbackActive = true;
        fallbackCheck();
      });
    } catch (e) {
      console.warn('[updater] electron-updater unavailable; notify-only mode:', e);
      fallbackActive = true;
    }

    const tick = (): void => { if (autoUpdateEnabled()) void nativeCheck(); };
    // First check shortly after boot (don't compete with spawn/startup I/O),
    // then every CHECK_INTERVAL_MS.
    setTimeout(tick, 30_000);
    setInterval(tick, CHECK_INTERVAL_MS);
  })();
}
