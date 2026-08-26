/**
 * The renderer switch for RTL-script terminal support: ON keeps xterm on its
 * DOM renderer, registers the Arabic character joiner, and lets the bidi CSS
 * in design/global.css do its work — together these render Arabic (and other
 * RTL scripts' neutral runs) shaped and correctly ordered, which the WebGL
 * cell painter structurally cannot (xterm.js has no bidi: xtermjs/xterm.js#701).
 * OFF leases the WebGL renderer: faster, and exactly the previous behavior.
 *
 * DEFAULT: OFF, for everyone, until someone turns it on in Settings.
 *
 * The PR proposed defaulting it on for RTL system locales. That is the same
 * OS-sniffing the language picker deliberately does not do: it would move an
 * existing user off the GPU renderer on upgrade, because of their OS locale,
 * without them asking. The founder's rule for this release is that nothing
 * changes for anyone until they pick it, so the locale sniff is gone and the
 * toggle is the only way in. Re-defaulting it belongs with the rest of the RTL
 * UI work, once an RTL app language actually ships.
 */
const KEY = 'cth.arabicTerminal';

let enabled = read();

function read(): boolean {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch { /* private mode — off, like everyone else */ }
  return false;
}

/** Hot path — called on terminal attach; reads the cached value. */
export function isArabicTerminalEnabled(): boolean {
  return enabled;
}

/** Flip the switch. Renderer choice is made when a terminal leases WebGL (on
 *  attach), so this applies to newly created terminal views. */
export function setArabicTerminalEnabled(next: boolean): void {
  enabled = next;
  try { window.localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* private mode */ }
}
