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
  nextTerminalAutomationAction,
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
  /** When the picker latch was set — the block expires, see PICKER_BLOCK_MS. */
  automationBlockedAt: number;
  /** True while the user has unsubmitted text in the live TUI prompt. */
  inputDirty: boolean;
  inputDirtyAt: number; // when the draft was last typed into; drives staleness expiry
  automationSettleUntil: number;
  /** Our model of the text on the live prompt line. On the ENTRY, not a closure
   * variable: `inputDirty` is derived from it, so anything that clears the
   * prompt (Ctrl-U, a respawn reset) has to clear both or the next keystroke
   * resurrects the deleted text as a phantom draft. */
  lineBuf: string;
  /** Bumped every time this pty is respawned under the same id. Late events from
   * the OLD process carry the generation they were registered under, so they can
   * be recognised and dropped instead of corrupting the replacement. */
  generation: number;
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
    automationBlockedAt: 0,
    inputDirty: false,
    inputDirtyAt: 0,
    automationSettleUntil: 0,
    lineBuf: '',
    generation: 0
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
  // A restart does killPty() then spawnPty() under the SAME pty id, so a stale
  // exit from the killed process could in principle latch `exited` on its
  // replacement (which would silently drop every keystroke). It can't: kill()
  // removes the session from the map synchronously (main/pty.ts kill), and the
  // process's own onExit checks it still owns that id before emitting — so the
  // stale event is suppressed in the main process and never reaches here.
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
  // It lives on the entry (see TerminalEntry.lineBuf) so every prompt-clearing
  // path resets it too.
  term.onData((data) => {
    if (entry.exited) return;
    window.cth.writePty(ptyId, data);
    // A lone Escape or Ctrl-C closes interactive pickers. Arrow-key escape
    // sequences must NOT clear the block while the user navigates a picker.
    if (data === '\x1b' || data === '\x03') {
      releasePickerBlock(entry);
      entry.lineBuf = '';
    }
    // The user's own Ctrl-U (kill-line) clears the prompt exactly like ours does.
    if (data === '\x15') entry.lineBuf = '';
    // Bracketed paste is still user-owned draft text; remove only its wrapper so
    // pasted content marks the prompt dirty instead of looking automation-safe.
    const input = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === '\r' || ch === '\n') {
        const t = entry.lineBuf.trim();
        entry.lineBuf = '';
        if (entry.automationBlocked) {
          // Enter chooses an item and closes the current picker.
          releasePickerBlock(entry);
        }
        // NOT an `else`: this Enter is the one that SUBMITTED the command, so it
        // must both close any picker that was already open and latch a new one
        // for the command it just submitted. As an `else if`, a line like
        // `/model sonnet` latched the block and then had no later Enter to clear
        // it — every queued message to that agent was skipped forever.
        if (opensInteractiveTerminalUi(t)) {
          entry.automationBlocked = true;
          entry.automationBlockedAt = Date.now();
        }
        if (t.length >= 2) entry.onPrompt?.(t);
      } else if (ch === '\x7f' || ch === '\b') {
        entry.lineBuf = entry.lineBuf.slice(0, -1);
      } else if (ch === '\x1b') {
        break; // skip escape sequences (arrow keys, etc.)
      } else if (ch >= ' ') {
        entry.lineBuf += ch;
      }
    }
    entry.inputDirty = entry.lineBuf.length > 0;
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
    pickerOpenedAt: entry.automationBlocked ? entry.automationBlockedAt : undefined,
    inputDirty: entry.inputDirty,
    inputDirtyAt: entry.inputDirty ? entry.inputDirtyAt : undefined,
    settleUntil: entry.automationSettleUntil
  };
}

/** Drop the picker latch and give the TUI a moment to repaint the freed line. */
function releasePickerBlock(entry: TerminalEntry): void {
  entry.automationBlocked = false;
  entry.automationBlockedAt = 0;
  entry.automationSettleUntil = Date.now() + 500;
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
export function clearTerminalDraft(ptyId: string): string {
  const entry = pool.get(ptyId);
  if (!entry) return '';
  // Hand the text back so the caller can park it somewhere the user can find it
  // again. Ctrl-U is not undoable in a TUI, so silently discarding it was data
  // loss every time an abandoned-looking draft turned out to be a real one.
  const discarded = entry.lineBuf;
  void window.cth.writePty(ptyId, '\x15');
  entry.inputDirty = false;
  entry.inputDirtyAt = 0;
  // Reset our model of the line too. Leaving it set made the very next keystroke
  // recompute `inputDirty` from the text we just deleted, so the draft block
  // came straight back and the deleted text corrupted the next parsed command.
  entry.lineBuf = '';
  // NOT cleared: `automationBlocked`. Ctrl-U kills the input line; it does not
  // close an open picker. Clearing the latch here told automation the prompt was
  // free while a picker still owned it, so the queued message was typed into the
  // picker and acknowledged as delivered — the message was lost and the picker
  // got garbage. The latch is released by a real Enter/Esc/Ctrl-C, or it expires.
  // Let the TUI repaint the cleared line before automation types into it.
  entry.automationSettleUntil = Date.now() + 300;
  return discarded;
}

/** Close an open picker by sending the key that actually closes one.
 * The Escape round-trips through xterm's own onData handler, so the latch is
 * released by the same path a user pressing Escape would take — we never just
 * assert the picker is gone without telling the TUI to close it. */
export function dismissTerminalPicker(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry || entry.exited) return;
  void window.cth.writePty(ptyId, '\x1b');
  releasePickerBlock(entry);
}

export interface AutomationPreparation {
  /** True only when the prompt is free RIGHT NOW and safe to type into. */
  ready: boolean;
  /** Draft text taken off the prompt, so the caller can park it somewhere the
   *  user can find it again. Null when nothing was discarded. */
  discardedDraft: string | null;
}

/** Make this terminal's prompt safe for automation, and say whether it now is.
 *
 *  EVERY automatic writer must go through this — not just the queue drain. A
 *  block that has expired is only a GUESS that the UI it was guarding is gone:
 *  the picker latch is cleared by an Enter/Escape/Ctrl-C in that terminal, and a
 *  picker closed any other way (or still genuinely open) leaves it set. Acting
 *  on that guess by typing is how a queued message got typed into a live menu
 *  and acknowledged as delivered — lost, with the queue reporting success.
 *
 *  So an expired block is acted on by CLOSING the thing it described and
 *  reporting not-ready. The caller retries on its next tick, by which time the
 *  Escape (or Ctrl-U) has landed and the TUI has repainted the freed line. */
export function prepareTerminalForAutomation(
  ptyId: string,
  now = Date.now()
): AutomationPreparation {
  const entry = pool.get(ptyId);
  // No pooled terminal ⇒ no local picker and no draft we could be fusing with.
  if (!entry) return { ready: true, discardedDraft: null };
  switch (nextTerminalAutomationAction(automationStateOf(entry), now)) {
    case 'go':
      return { ready: true, discardedDraft: null };
    case 'dismiss-picker':
      dismissTerminalPicker(ptyId);
      return { ready: false, discardedDraft: null };
    case 'clear-draft':
      // "Abandoned" is only a guess (a minute of no keystrokes), and it is wrong
      // whenever the user paused to think or switched windows — so hand the text
      // back instead of destroying it with a Ctrl-U they never asked for.
      return { ready: false, discardedDraft: clearTerminalDraft(ptyId) };
    default:
      return { ready: false, discardedDraft: null };
  }
}

/** Give this terminal a WebGL renderer for as long as it is on screen.
 *
 *  The DOM renderer assumes a perfectly monospace font, but VT323 is missing
 *  glyphs (↔, arrows, some box-drawing) and has no real bold — the browser
 *  substitutes fallback glyphs with different advance widths, so box-drawing
 *  tables shear apart and the cursor drifts. WebGL draws every glyph into its
 *  own fixed cell, keeping the grid aligned. NOT the deprecated canvas addon
 *  (its dirty-region tracking garbles scrollback).
 *
 *  It is a LEASE, taken on attach and released on detach (see detachTerminal),
 *  because a browser allows only a limited number of live WebGL contexts —
 *  around 16 in Chromium — and silently discards the oldest when a new one
 *  pushes past the cap. Terminals used to hold their context for the whole
 *  session even while detached, so restoring a team (which opens one terminal
 *  per agent in quick succession) blew the cap and the browser killed a
 *  background terminal's context. Its pty, buffer and subscription all stayed
 *  healthy — only the renderer was dead — which is exactly the reported
 *  "terminal is black and typing does nothing": the keystrokes were delivered
 *  and the replies arrived, with nothing left alive to paint them.
 *
 *  Best-effort: on init failure or context loss, fall back to the DOM renderer
 *  rather than leave a black terminal. */
function leaseWebglRenderer(entry: TerminalEntry): void {
  if (entry.webgl) return;
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
      scheduleWebglRecovery(entry.recovery, requestAnimationFrame, () =>
        repaintTerminalAfterRendererLoss(entry));
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
}

/** Release the WebGL lease so an off-screen terminal isn't holding a GPU context
 *  that an on-screen one needs. xterm falls back to the DOM renderer, which is
 *  fine for a terminal nobody is looking at; the next attach takes a fresh
 *  lease. The buffer and pty subscription are untouched. */
function releaseWebglRenderer(entry: TerminalEntry): void {
  const webgl = entry.webgl;
  if (!webgl) return;
  entry.webgl = undefined;
  try { webgl.dispose(); } catch { /* noop */ }
  // The DOM renderer that takes over inherits xterm's cached cell metrics, which
  // may be stale by the time this terminal is shown again.
  entry.needsRendererRepaint = true;
}

/** Re-parent a pty's terminal into `container`, opening xterm on first attach. */
export function attachTerminal(entry: TerminalEntry, container: HTMLElement): void {
  container.appendChild(entry.host);
  if (!entry.opened) {
    // open() must come first — the WebGL addon can only load onto an opened
    // terminal, and xterm needs its host in the document to measure the cell.
    entry.term.open(entry.host);
    entry.opened = true;
  }
  leaseWebglRenderer(entry);
  // PTY startup output can arrive before this pooled terminal subscribes.
  // Request one same-size redraw after open/subscription even when fit() later
  // sees unchanged dimensions and therefore emits no resize of its own.
  requestInitialPtyRedraw(entry.recovery, () => window.cth.redrawPty(entry.ptyId));
  if (entry.needsRendererRepaint) {
    scheduleWebglRecovery(entry.recovery, requestAnimationFrame, () =>
      repaintTerminalAfterRendererLoss(entry));
  }
}

/** Take the terminal off screen: drop the WebGL lease and unparent the host.
 *  Everything that makes the terminal a terminal — buffer, scrollback, pty
 *  subscription — stays in the pool, so re-attaching shows it fully rendered. */
export function detachTerminal(entry: TerminalEntry, container: HTMLElement): void {
  // Guard: another view may have already taken the host (React can mount the new
  // owner before the old one's cleanup runs). Releasing the renderer then would
  // blank the terminal that just legitimately claimed it.
  if (entry.host.parentElement !== container) return;
  releaseWebglRenderer(entry);
  container.removeChild(entry.host);
}

function repaintTerminalAfterRendererLoss(entry: TerminalEntry): void {
  if (!entry.opened || !entry.host.isConnected
      || !entry.host.clientWidth || !entry.host.clientHeight) {
    entry.needsRendererRepaint = true;
    return;
  }
  reflowTerminal(entry.ptyId);
  try {
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
    // Only NOW is the repaint confirmed. Clearing the marker before the refresh
    // meant a throw here (the renderer still settling) discarded the last record
    // that this terminal needed repainting — so it stayed black until something
    // unrelated happened to resize it, which is why Cmd +/- fixed it only some
    // of the time.
    entry.needsRendererRepaint = false;
  } catch {
    entry.needsRendererRepaint = true;
  }
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
  // The old process's prompt is gone with it — drop our model of that line and
  // any picker it had open, or the replacement inherits a phantom draft and a
  // block that nothing can clear.
  entry.lineBuf = '';
  entry.automationBlocked = false;
  entry.automationBlockedAt = 0;
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
