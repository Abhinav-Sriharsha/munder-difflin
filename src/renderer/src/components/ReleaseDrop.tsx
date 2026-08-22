/**
 * The release drop — a centered, full-bleed "what's new" moment.
 *
 * A corner toast with three clipped bullets is a changelog notification. This is
 * the other thing: a page the release author designs, shown once, at the size the
 * work deserves.
 *
 * There is NO chrome button here, on purpose. The app frames the drop and gets
 * out of the way; every action the release wants to offer — read the notes, star
 * the repo, join the Discord — is authored INSIDE the HTML as an ordinary link,
 * where the person writing the release controls the wording and the placement.
 *
 * The authored HTML runs in an iframe with a `default-src 'none'` CSP and a
 * sandbox that grants exactly one capability: `allow-popups` (see
 * shared/releaseDrop.ts for why everything else stays shut). That is what makes
 * an authored `<a target="_blank">` work — the frame cannot navigate anything
 * itself, it can only ASK for a window, and main's setWindowOpenHandler denies
 * the window and hands the URL to the OS browser if and only if it is http(s).
 * No scripts, no same-origin, no forms, no top-level navigation.
 *
 * One consequence still shapes the layout: the frame's height cannot be measured
 * (that needs a postMessage bridge, which needs allow-scripts). So the modal is a
 * fixed viewport-relative box and the drop scrolls inside it, rather than the box
 * growing to fit.
 *
 * Dismissal is Esc or a click on the backdrop. Both were always here; with the
 * close button gone the header says so in words, because a modal this large with
 * no visible way out is a trap.
 */
import { useEffect, useMemo } from 'react';
import { buildDropSrcDoc } from '../../../shared/releaseDrop';

export interface ReleaseDropProps {
  version: string;
  /** Authored HTML, already extracted from the release body. */
  html: string;
  onDismiss: () => void;
}

export function ReleaseDrop({ version, html, onDismiss }: ReleaseDropProps) {
  const srcDoc = useMemo(() => buildDropSrcDoc(html), [html]);

  // Esc dismisses. A modal this large with no keyboard exit feels like a trap,
  // and "later" is always a legitimate answer to an update.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  // The chrome deliberately drops the app's pixel idiom. Inside this dialog the
  // drop is the subject and the surrounding UI should read as a quiet frame
  // around it — sharp 2px borders and hard drop-shadows fight a modern page.
  const INK_SOFT = '#6C6875';
  const LINE = 'rgba(20,19,26,0.10)';

  return (
    <div
      // Backdrop. Clicking it dismisses — same meaning as "later".
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(26,19,32,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        // Same lesson as the onboarding overlay: center with auto margins on the
        // child, and let the overlay scroll, so a tall dialog is never clipped
        // at the top where it cannot be scrolled back to.
        overflowY: 'auto'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          margin: 'auto',
          // Roughly 1:1 at 80% of the viewport height. Deriving the width FROM the
          // height is what keeps it square as the window changes; `min(…, 94vw)`
          // is the escape hatch for a window too narrow to hold a square that
          // tall, where it becomes a portrait sheet rather than overflowing.
          height: '80vh',
          width: 'min(80vh, 94vw)',
          minHeight: 380,
          display: 'flex', flexDirection: 'column',
          background: '#FBFAF8',
          // Soft, modern elevation — not the app's pixel drop-shadow. The drop is
          // an authored artifact presented BY the app, not a piece of its chrome.
          borderRadius: 20,
          overflow: 'hidden', // so the frame's corners are clipped to the radius
          boxShadow: '0 24px 70px rgba(20,19,26,0.34), 0 2px 8px rgba(20,19,26,0.18)',
          // The app's own UI font is part of its pixel identity and reads as
          // retro chrome wrapped around a modern page. The dialog uses the system
          // stack instead, matching the drop inside it — one typographic voice.
          fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif'
        }}
      >
        {/* Header — a thin, quiet bar. The drop supplies its own title, and the
            only thing out here is a label plus how to leave. Both are inert
            text: the whole point of this dialog is that it holds no controls. */}
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 18px 12px', borderBottom: `1px solid ${LINE}`,
          background: '#FBFAF8',
          fontSize: 11.5, fontWeight: 600, letterSpacing: '.1em',
          textTransform: 'uppercase', color: INK_SOFT
        }}>
          <span style={{ flex: 1, minWidth: 0 }}>Munder Difflin · {version}</span>
          <span aria-hidden style={{ flexShrink: 0, opacity: 0.75, letterSpacing: '.08em' }}>
            Esc to close
          </span>
        </div>

        {/* The drop itself. `allow-popups` is the ONLY grant: it is what lets an
            authored <a target="_blank"> reach the OS browser, and it carries no
            script, same-origin, form or navigation rights with it. */}
        <iframe
          title={`What's new in ${version}`}
          srcDoc={srcDoc}
          sandbox="allow-popups"
          referrerPolicy="no-referrer"
          style={{
            flex: 1, minHeight: 0, width: '100%', border: 'none',
            background: '#FBFAF8'
          }}
        />
      </div>
    </div>
  );
}
