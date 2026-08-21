import { useEffect, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';

/**
 * Operator control for one agent (#7C.1-7C.3) — pause (deny tools at the next
 * boundary), graceful halt (clean stop), and mid-run steering (inject context
 * without typing into the TUI). All ride Claude Code's hook-return protocol; no
 * PTY keystrokes. A thin strip under the agent header.
 *
 * The labels used to be "CONTROL", "pause", "halt", "steer", which told you the
 * mechanism and nothing about the consequence. "Control" what, and what is the
 * difference between pausing and halting? Both stop something; only one is
 * recoverable in the same breath. So each button now says what HAPPENS, the
 * heading says what the section governs, and the explanations are on a styled
 * hover tip rather than a native `title` that waits a second and then renders
 * an unstyled OS bubble.
 *
 * Not in this strip on purpose: the 1:1 hold, which lives next to IDE in the
 * header. Pause and halt stop the AGENT; hold stops MICHAEL sending it work.
 * Grouping them would suggest they are three flavours of the same thing.
 */
interface Snapshot {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

export function AgentControlStrip({ agentId }: { agentId: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [steer, setSteer] = useState('');
  const [note, setNote] = useState('');
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    window.cth.controlSnapshot(agentId).then((s) => { if (alive && s) setSnap(s); }).catch(() => { /* none */ });
    return () => { alive = false; };
  }, [agentId]);

  const flash = (m: string) => {
    setNote(m);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 1800);
  };

  const togglePause = async () => {
    const s = snap?.paused ? await window.cth.controlResume(agentId) : await window.cth.controlPause(agentId, true);
    if (s) setSnap(s);
    flash(snap?.paused ? 'tools allowed again' : 'tools blocked from the next call on');
  };
  const halt = async () => {
    const s = await window.cth.controlHalt(agentId);
    if (s) setSnap(s);
    flash('will stop after the current step');
  };
  const sendSteer = async () => {
    const t = steer.trim();
    if (!t) return;
    const s = await window.cth.controlSteer(agentId, t);
    if (s) setSnap(s);
    setSteer('');
    flash('note queued, arrives on its next turn');
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '6px 8px', background: 'var(--cth-paper-100)',
      borderBottom: '1px solid var(--cth-ink-300)', flexShrink: 0
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          className="cth-tip cth-tip-left cth-tip-wrap"
          data-tip="What this agent is allowed to do right now, and a way to nudge it mid-run. Nothing here ends the agent or loses its session."
          style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginRight: 2, cursor: 'help' }}
        >WHAT THIS AGENT CAN DO</span>
        {/* Neither of these kills anything, and the old two-word labels never
            said so — the difference is WHEN the agent stops and whether it keeps
            its session. Say the consequence on the button, the detail on hover. */}
        <PixelButton variant={snap?.paused ? 'primary' : 'secondary'} size="sm" onClick={togglePause}>
          <span
            className="cth-tip cth-tip-left cth-tip-wrap"
            data-tip={snap?.paused
              ? 'Give its tools back. The agent keeps its session and picks up where it stopped.'
              : 'The agent keeps thinking and talking to you, but cannot read, write or run anything until you allow it again. Immediate, and reversible.'}
            aria-label={snap?.paused ? 'Allow tools again' : 'Block this agent from using tools'}
          >
            {snap?.paused ? 'allow tools' : 'block tools'}
          </span>
        </PixelButton>
        <PixelButton variant="destructive" size="sm" onClick={halt}>
          <span
            className="cth-tip cth-tip-left cth-tip-wrap"
            data-tip="Let it finish the step it is on, then stop. The process and its session survive, so Restart and Continue can pick it back up. To end the process outright, use the X."
            aria-label="Stop this agent after the current step"
          >
            stop after this step
          </span>
        </PixelButton>
        {/* v0.3.4: the auto-delivery switch moved to the god's Command Center
            header — ONE floor-wide control instead of a per-agent toggle. */}
        {snap?.autoDeliveryPaused && (
          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>queued messages held (whole floor)</span>
        )}
        {snap?.halted && <span style={{ fontSize: 11, color: 'var(--cth-coral)' }}>stopping after this step…</span>}
        {!!snap?.pendingSteers && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{snap.pendingSteers} note{snap.pendingSteers === 1 ? '' : 's'} waiting</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sendSteer(); }}
          placeholder="send this agent a note… (arrives as context on its next turn, nothing is typed into its terminal)"
          style={{
            flex: 1, padding: '4px 6px', background: 'var(--cth-paper-100)', border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
            fontSize: 12, color: 'var(--cth-ink-900)', outline: 'none'
          }}
        />
        <PixelButton variant="secondary" size="sm" onClick={sendSteer} disabled={!steer.trim()}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip="Hands the agent a note at its next turn boundary. It does not interrupt what it is doing now, and nothing is typed into its terminal."
            aria-label="Send this agent a note"
          >send</span>
        </PixelButton>
      </div>
      {note && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{note}</span>}
    </div>
  );
}
