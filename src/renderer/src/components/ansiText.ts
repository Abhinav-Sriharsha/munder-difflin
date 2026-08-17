/**
 * Strip ANSI escape sequences from scraped terminal output.
 *
 * The pty parser used to remove ONLY SGR color codes (`ESC[…m`), so every other
 * escape flavor leaked into the text the thought bubbles and desk cards show
 * (issue #141): the CLI repaints its live status line with cursor-forward moves
 * (`ESC[1C`) standing in for runs of spaces it knows are already on screen,
 * plus cursor addressing (`ESC[14;6H`) and erases — scraped, that rendered as
 * "all␛[1Cthree␛[1Cland…".
 *
 * Cursor-forward is TRANSLATED into the spaces it stands for (dropping it would
 * fuse adjacent words); everything else is control, not content, and is
 * removed: OSC strings (window title, hyperlinks), any remaining CSI (SGR,
 * cursor, erase, modes), charset selects, and whatever two-byte escape is left.
 */
const CUF_RE = /\x1b\[(\d*)C/g; // cursor-forward: the TUI's stand-in for spaces
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g; // OSC … BEL/ST (titles, links)
const CSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g; // any CSI: SGR, cursor, erase, modes
const CHARSET_RE = /\x1b[()][0-9A-B]/g; // charset selects (ESC ( B …)
const ESC2_RE = /\x1b./g; // stray two-byte escapes (ESC 7, ESC = …)

export function stripAnsi(chunk: string): string {
  return chunk
    .replace(CUF_RE, (_, n: string) => ' '.repeat(Math.min(parseInt(n || '1', 10) || 1, 80)))
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(CHARSET_RE, '')
    .replace(ESC2_RE, '');
}
