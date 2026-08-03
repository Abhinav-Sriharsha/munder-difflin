/**
 * A process-wide pool of live xterm terminals, one per ptyId.
 *
 * Why: node-pty keeps no scrollback. If we created/disposed an xterm every time
 * the user switched agents (or toggled fullscreen), the new terminal would be
 * empty and stay blank until the TUI happened to repaint — which is exactly the
 * "terminal vanishes until I drag the splitter" bug.
 *
 * Instead each pty gets ONE Terminal for the app's lifetime. It is opened into a
 * detached host <div> and subscribes to the pty stream once, so its buffer is
 * always populated. A view (the sidebar tab or the fullscreen overlay) simply
 * re-parents that host element into itself when it mounts and detaches it on
 * unmount — the rendered content moves with it, so the terminal is always
 * visible immediately, no repaint required.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import {
  createTerminalRecoveryState,
  normalizePtyChunk,
  requestInitialPtyRedraw,
  scheduleWebglRecovery,
  type TerminalRecoveryState
} from './terminalRecovery';
import {
  canAutomateTerminal,
  isStaleTerminalDraft,
  opensInteractiveTerminalUi,
  shouldFollowTerminalOutput,
  terminalAutomationBlock,
  type TerminalAutomationBlock
} from './terminalAutomation';
import '@xterm/xterm/css/xterm.css';

export interface TerminalEntry {
  /** The pty this terminal mirrors — needed to poke `resizePty` on a reflow. */
  ptyId: string;
  term: Terminal;
  fit: FitAddon;
  /** The element xterm renders into; views re-parent this in/out of the DOM. */
  host: HTMLDivElement;
  /** xterm is only `open()`ed once its host is first attached to the document. */
  opened: boolean;
  exited: boolean;
  /** Stream subscriptions to tear down on dispose. */
  unsub: Array<() => void>;
  /** Current consumer callbacks — set by whichever view is mounted. */
  onData?: (chunk: string) => void;
  onPrompt?: (text: string) => void;
  recovery: TerminalRecoveryState;
  needsRendererRepaint: boolean;
  /** A user-opened slash-command picker (for example Codex `/model`) owns the
   * input line. Queue automation waits until the picker closes. */
  automationBlocked: boolean;
  /** True while the user has unsubmitted text in the live TUI prompt. */
  inputDirty: boolean;
  inputDirtyAt: number; // when the draft was last typed into; drives staleness expiry
  automationSettleUntil: number;
  webgl?: WebglAddon;
}

const pool = new Map<string, TerminalEntry>();

type ThemeMap = Record<string, string>;

/** Get (or lazily create) the persistent terminal for a pty. Theme/font are
 *  only used at creation; an attaching view re-applies its own afterwards. */
export function acquireTerminal(ptyId: string, theme?: ThemeMap, fontSize = 14): TerminalEntry {
  const existing = pool.get(ptyId);
  if (existing) return existing;

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';

  const term = new Terminal({
    theme,
    fontFamily: 'VT323, monospace',
    fontSize,
    lineHeight: 1.0,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 100000,
    // Guarantee legible text no matter what colors a running program sets.
    // When a program paints a coloured cell background (e.g. a git-diff add line
    // with a green bg, or a yellow-highlighted line) while leaving the default
    // foreground, the theme's dark ink would otherwise render dark-on-colour and
    // be unreadable on the light/cream theme. xterm auto-adjusts the foreground
    // per cell to keep at least this contrast ratio (WCAG AA = 4.5) against the
    // actual background — so it also rescues low-contrast coloured *text* on the
    // cream paper. Untouched for already-high-contrast cells (the dark theme).
    minimumContrastRatio: 4.5,
    allowProposedApi: true
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Unicode 11 width tables: xterm's default (Unicode 6) counts most emoji as
  // ONE cell wide, but Claude Code positions text with modern widths (emoji =
  // two cells) — the glyph then overflows its single cell and merges with the
  // following text (e.g. "✅FIX-…"). Match the app's idea of character width.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  // NOTE: don't open() yet — xterm needs its host connected to the document to
  // measure correctly. We open on first attach (see attachTerminal).

  const entry: TerminalEntry = {
    ptyId,
    term,
    fit,
    host,
    opened: false,
    exited: false,
    unsub: [],
    recovery: createTerminalRecoveryState(),
    needsRendererRepaint: false,
    automationBlocked: false,
    inputDirty: false,
    inputDirtyAt: 0,
    automationSettleUntil: 0
  };

  // Subscribe to the pty stream ONCE for the terminal's whole lifetime, so the
  // buffer keeps filling even while this terminal isn't mounted in any view.
  entry.unsub.push(window.cth.onPtyData(ptyId, (rawChunk) => {
    const chunk = normalizePtyChunk(rawChunk);
    if (!chunk) return;
    const active = term.buffer.active;
    const follow = shouldFollowTerminalOutput(active.viewportY, active.baseY);
    term.write(chunk, () => {
      if (follow) {
        try { term.scrollToBottom(); } catch { /* terminal may be detaching */ }
      }
    });
    entry.onData?.(chunk);
  }));
  entry.unsub.push(window.cth.onPtyExit(ptyId, ({ exitCode, signal }) => {
    entry.exited = true;
    term.writeln(`\r\n\x1b[2m─ process exited (code ${exitCode}${signal ? `, signal ${signal}` : ''}) ─\x1b[0m`);
  }));

  // ── Copy / paste ──────────────────────────────────────────────────────────
  // With an accelerated renderer there is no DOM text, so the browser's native
  // copy can't see the terminal — the selection lives inside xterm. Wire the
  // usual terminal conventions:
  //   Ctrl/Cmd+C with a selection → copy (without one it stays SIGINT)
  //   Ctrl/Cmd+Shift+C            → copy ;  Ctrl/Cmd+Shift+V → paste
  //   right-click                 → copy the selection, else paste (console style)
  const copySelection = (): boolean => {
    if (!term.hasSelection()) return false;
    void window.cth.copyToClipboard(term.getSelection());
    return true;
  };
  const pasteClipboard = (): void => {
    if (entry.exited) return;
    void window.cth.readClipboard().then((t) => { if (t) term.paste(t); });
  };
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    if (!(ev.ctrlKey || ev.metaKey)) return true;
    const key = ev.key.toLowerCase();
    if (key === 'c' && (ev.shiftKey || term.hasSelection())) {
      // Copy-on-Ctrl+C only while a selection exists; clear it after, so a
      // second Ctrl+C still interrupts the agent as usual.
      if (copySelection() && !ev.shiftKey) term.clearSelection();
      ev.preventDefault();
      return false;
    }
    if (key === 'v' && ev.shiftKey) {
      pasteClipboard();
      ev.preventDefault();
      return false;
    }
    return true;
  });
  host.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (copySelection()) { term.clearSelection(); return; }
    pasteClipboard();
  });

  // Keystrokes → pty. A small line buffer surfaces the last submitted prompt.
  let lineBuf = '';
  term.onData((data) => {
    if (entry.exited) return;
    window.cth.writePty(ptyId, data);
    // A lone Escape or Ctrl-C closes interactive pickers. Arrow-key escape
    // sequences must NOT clear the block while the user navigates a picker.
    if (data === '\x1b' || data === '\x03') {
      entry.automationBlocked = false;
      entry.automationSettleUntil = Date.now() + 500;
      lineBuf = '';
    }
    // Bracketed paste is still user-owned draft text; remove only its wrapper so
    // pasted content marks the prompt dirty instead of looking automation-safe.
    const input = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === '\r' || ch === '\n') {
        const t = lineBuf.trim();
        lineBuf = '';
        if (entry.automationBlocked) {
          // Enter chooses an item and closes the current picker.
          entry.automationBlocked = false;
          entry.automationSettleUntil = Date.now() + 500;
        } else if (opensInteractiveTerminalUi(t)) {
          entry.automationBlocked = true;
        }
        if (t.length >= 2) entry.onPrompt?.(t);
      } else if (ch === '\x7f' || ch === '\b') {
        lineBuf = lineBuf.slice(0, -1);
      } else if (ch === '\x1b') {
        break; // skip escape sequences (arrow keys, etc.)
      } else if (ch >= ' ') {
        lineBuf += ch;
      }
    }
    entry.inputDirty = lineBuf.length > 0;
    // Re-stamped on every keystroke, so the staleness clock measures time since
    // the user last touched the draft — not since they started it.
    if (entry.inputDirty) entry.inputDirtyAt = Date.now();
  });

  pool.set(ptyId, entry);
  return entry;
}

/** Whether queued automation can safely own this terminal's input line. A PTY
 * without a pooled terminal cannot have a user-opened local picker. */
export function isTerminalAutomationSafe(ptyId: string, now = Date.now()): boolean {
  const entry = pool.get(ptyId);
  if (!entry) return true;
  return canAutomateTerminal(automationStateOf(entry), now);
}

function automationStateOf(entry: TerminalEntry) {
  return {
    exited: entry.exited,
    pickerOpen: entry.automationBlocked,
    inputDirty: entry.inputDirty,
    inputDirtyAt: entry.inputDirty ? entry.inputDirtyAt : undefined,
    settleUntil: entry.automationSettleUntil
  };
}

/** Why queue delivery is currently held back for this pty, or null if it isn't.
 * The composer shows this instead of claiming it is sending. */
export function terminalAutomationBlockFor(
  ptyId: string | undefined,
  now = Date.now()
): TerminalAutomationBlock {
  if (!ptyId) return null;
  const entry = pool.get(ptyId);
  if (!entry) return null;
  return terminalAutomationBlock(automationStateOf(entry), now);
}

/** Wipe the TUI prompt's current line and re-arm automation. Ctrl-U is the
 * readline kill-to-start binding every supported CLI's input honors. */
export function clearTerminalDraft(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  void window.cth.writePty(ptyId, '\x15');
  entry.inputDirty = false;
  entry.inputDirtyAt = 0;
  entry.automationBlocked = false;
  // Let the TUI repaint the cleared line before automation types into it.
  entry.automationSettleUntil = Date.now() + 300;
}

/** Drop a draft nobody has touched for STALE_INPUT_MS so it cannot fuse with the
 * text automation is about to type. No-op while the draft is still fresh. */
export function clearStaleTerminalDraft(ptyId: string, now = Date.now()): boolean {
  const entry = pool.get(ptyId);
  if (!entry || !isStaleTerminalDraft(automationStateOf(entry), now)) return false;
  clearTerminalDraft(ptyId);
  return true;
}

/** Re-parent a pty's terminal into `container`, opening xterm on first attach. */
export function attachTerminal(entry: TerminalEntry, container: HTMLElement): void {
  container.appendChild(entry.host);
  if (!entry.opened) {
    entry.term.open(entry.host);
    entry.opened = true;
    // Switch from the DOM renderer to WebGL (must load after open()). The DOM
    // renderer assumes a perfectly monospace font, but VT323 is missing glyphs
    // (↔, arrows, some box-drawing) and has no real bold — the browser
    // substitutes fallback glyphs with different advance widths, so box-drawing
    // tables shear apart and the cursor drifts. WebGL draws every glyph into its
    // own fixed cell, keeping the grid aligned. NOT the deprecated canvas addon
    // (its dirty-region tracking garbles scrollback). Best-effort: on init
    // failure or GPU context loss, dispose → fall back to the DOM renderer
    // rather than leave a black terminal.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        if (entry.webgl !== webgl) return;
        console.warn('[terminal] webgl context lost — falling back to DOM renderer');
        entry.webgl = undefined;
        entry.needsRendererRepaint = true;
        try { webgl.dispose(); } catch { /* noop */ }
        // Laptop sleep == GPU sleep == WebGL context loss: the likely PRIMARY
        // trigger for the post-wake "can't scroll past a recent point" bug. The
        // renderer swap leaves xterm's cached cell-height (and the viewport
        // scroll-area derived from it) stale, so only part of the intact buffer
        // is scrollable until something forces a re-measure. Heal it here, on the
        // next frame so the (waking) layout has settled. Guarded + idempotent, so
        // it composes safely with the visibilitychange/focus path in the view.
        scheduleWebglRecovery(entry.recovery, requestAnimationFrame, () => {
          repaintTerminalAfterRendererLoss(entry);
        });
      });
      // Set before loadAddon: an immediately-lost context may call the handler
      // during initialization, and it must be recognized as the active renderer.
      entry.webgl = webgl;
      entry.term.loadAddon(webgl);
    } catch (e) {
      try { entry.webgl?.dispose(); } catch { /* noop */ }
      entry.webgl = undefined;
      console.warn('[terminal] webgl renderer unavailable, using DOM renderer:', e);
    }
    // PTY startup output can arrive before this pooled terminal subscribes.
    // Request one same-size redraw after open/subscription even when fit() later
    // sees unchanged dimensions and therefore emits no resize of its own.
    requestInitialPtyRedraw(entry.recovery, () => {
      void window.cth.redrawPty(entry.ptyId);
    });
  }
  if (entry.needsRendererRepaint) {
    scheduleWebglRecovery(entry.recovery, requestAnimationFrame, () => {
      repaintTerminalAfterRendererLoss(entry);
    });
  }
}

function repaintTerminalAfterRendererLoss(entry: TerminalEntry): void {
  if (!entry.opened || !entry.host.isConnected
      || !entry.host.clientWidth || !entry.host.clientHeight) {
    entry.needsRendererRepaint = true;
    return;
  }
  entry.needsRendererRepaint = false;
  reflowTerminal(entry.ptyId);
  try {
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
  } catch { /* renderer may still be settling */ }
}

/**
 * Re-measure cell metrics and rebuild the viewport scroll-area for a pooled
 * terminal. Use after a display wake / GPU (WebGL) context loss / DPR change:
 * xterm caches the cell height measured at open() and only recomputes it on a
 * font change or resize. When that cached metric goes stale (sleep/wake), the
 * .xterm-viewport scroll-area height (rows × cellHeight) is wrong, so only PART
 * of the still-intact buffer is scrollable — the user otherwise has to zoom to
 * force a fit() and reveal the rest.
 *
 * Mirrors the document.fonts.ready re-measure in PtyTerminalView: re-applying the
 * SAME font invalidates xterm's cached cell metrics, clearTextureAtlas re-rasters
 * the WebGL glyph atlas at the right size, then fit() recomputes cols/rows and
 * rebuilds the viewport. Preserves scroll position (NO scrollToBottom) so a user
 * reading history isn't yanked down. No-op until the terminal is opened and its
 * host has a real size, so it composes safely with multiple triggers firing
 * together (onContextLoss + visibilitychange + focus) — a cheap reflow twice is
 * harmless; the guards make an early/duplicate call a no-op.
 */
export function reflowTerminal(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry || !entry.opened) return;
  const host = entry.host;
  // Skip while detached or unsized — fitting a 0×0 host makes xterm propose a
  // tiny grid and resize the pty to it (clipped/oversized banner).
  if (!host.isConnected || !host.clientWidth || !host.clientHeight) return;
  try {
    // Re-apply the SAME font options to force xterm's CharSizeService to
    // re-measure the cell against the now-correct (woken) layout, then drop the
    // glyph atlas so it re-rasters at the corrected metrics.
    entry.term.options.fontFamily = entry.term.options.fontFamily;
    entry.term.options.fontSize = entry.term.options.fontSize;
    entry.term.clearTextureAtlas?.();
    const before = { cols: entry.term.cols, rows: entry.term.rows };
    entry.fit.fit();
    // Only poke the pty when the grid actually changed (every resize repaints
    // the TUI and pushes a frame into scrollback).
    if (entry.term.cols !== before.cols || entry.term.rows !== before.rows) {
      window.cth.resizePty(ptyId, entry.term.cols, entry.term.rows);
    }
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
  } catch { /* host may not be sized yet */ }
}

/**
 * Soft-reset a pooled terminal for an IN-PLACE pty respawn (the same ptyId is
 * reused — e.g. a model change or agent restart). Clears the screen + scrollback
 * and re-arms input while keeping the SAME Terminal, its live data subscription
 * and its DOM attachment, so the mounted view stays visible and typeable across
 * the restart.
 *
 * Why not disposeTerminal here: the view (PtyTerminalView) keys its attach effect
 * on the ptyId, which doesn't change on a restart — so it never re-attaches a
 * replacement terminal. Disposing therefore left a dead, detached pane that
 * swallowed every keystroke. Resetting in place avoids that entirely.
 */
export function resetTerminal(
  ptyId: string,
  opts: { preserveScrollback?: boolean } = {}
): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  // Re-arm input — a prior exit (or the kill that precedes the respawn) may have
  // latched `exited`, which otherwise makes onData drop keystrokes silently.
  entry.exited = false;
  entry.inputDirty = false;
  entry.inputDirtyAt = 0;
  try {
    if (opts.preserveScrollback) {
      entry.term.writeln('\r\n\x1b[2m─ resuming existing session ─\x1b[0m');
    } else {
      // Fresh sessions need a clean grid; resume keeps the existing scrollback.
      entry.term.reset();
    }
  } catch { /* not yet open */ }
}

/** Tear down a pty's terminal (call when the agent/pty is gone for good). */
export function disposeTerminal(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  entry.unsub.forEach((u) => { try { u(); } catch { /* noop */ } });
  try { entry.webgl?.dispose(); } catch { /* noop */ }
  try { entry.term.dispose(); } catch { /* noop */ }
  entry.host.remove();
  pool.delete(ptyId);
}
