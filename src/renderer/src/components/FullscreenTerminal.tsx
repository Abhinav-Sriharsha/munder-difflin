import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { PtyTerminalView } from './PtyTerminalView';
import { terminalInstanceKey } from './terminalRecovery';
import { MessageQueueComposer } from './MessageQueueComposer';
import { disposeTerminal } from './terminalPool';
import { Icon } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import { useStore, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';

export function FullscreenTerminal() {
  const agents = useStore(s => s.agents);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const setFullscreen = useStore(s => s.setFullscreen);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAgentNote = useStore(s => s.setAgentNote);
  const archiveAgent = useStore(s => s.archiveAgent);
  const updateAgent = useStore(s => s.updateAgent);

  const agent = agents.find(a => a.id === fullscreenAgentId);
  const parser = usePtyParser(agent?.id ?? '__none__');

  // Esc exits fullscreen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A modal above fullscreen owns the interaction until it closes. Without
        // this guard, Esc from the Add Agent form unexpectedly exits fullscreen.
        if (addAgentOpen) return;
        e.preventDefault();
        setFullscreen(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addAgentOpen, setFullscreen]);

  if (!agent || !agent.ptyId) {
    // Bail out — no real agent to show
    setFullscreen(null);
    return null;
  }

  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(`Close ${agent.name}? The PTY process will terminate and the agent is archived (kept in history, off the floor).`)) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    archiveAgent(agent.id);
    setFullscreen(null);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-100)',
      zIndex: 250,
      display: 'flex',
      flexDirection: 'column',
      paddingTop: 36  // leave room for macOS traffic lights / drag region
    }}>
      {/* Title bar drag region (so the user can still move the window) */}
      <div
        className="cth-titlebar-drag"
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '2px solid var(--cth-ink-900)',
          display: 'flex', alignItems: 'center',
          paddingLeft: 96, paddingRight: 12, gap: 12,
          userSelect: 'none'
        }}
      >
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '20px',
          color: 'var(--cth-ink-900)'
        }}>MUNDER DIFFLIN · FULLSCREEN</span>
      </div>

      {/* Tabs row — the agent tabs scroll in their own track (scrollbar hidden
          via .cth-tabbar) so the kill / exit controls stay pinned and aligned at
          the right edge instead of being crowded off when many agents are open. */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 8,
        padding: '8px 12px 0',
        background: 'var(--cth-cream-200)',
        borderBottom: '2px solid var(--cth-ink-900)'
      }}>
        <div className="cth-tabbar" style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-end', gap: 4, overflowX: 'auto'
        }}>
          {agents.map(a => (
            <Tab
              key={a.id}
              agent={a}
              active={a.id === agent.id}
              onClick={() => { select(a.id); setFullscreen(a.id); }}
              onNoteChange={(note) => setAgentNote(a.id, note)}
            />
          ))}
          <button
            onClick={() => setAddAgentOpen(true)}
            title="Add agent"
            style={{
              height: 32, padding: '0 10px', marginBottom: 4, flexShrink: 0,
              background: 'var(--cth-cream-100)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 14,
              color: 'var(--cth-ink-900)',
              display: 'inline-flex', alignItems: 'center', gap: 4,
              cursor: 'pointer'
            }}
          >
            <Icon name="plus" /> agent
          </button>
        </div>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 6 }}>
          <PixelButton variant="destructive" size="sm" onClick={onKill}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <Icon name="x" /> kill
            </span>
          </PixelButton>
          <PixelButton variant="secondary" size="sm" onClick={() => setFullscreen(null)}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <Icon name="minimize" /> exit (esc)
            </span>
          </PixelButton>
        </div>
      </div>

      {/* Body */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        padding: 12, gap: 10
      }}>
        <Header agent={agent} />

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <PtyTerminalView
              key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
              ptyId={agent.ptyId}
              onStreamData={parser}
              onUserPrompt={(t) => {
                updateAgent(agent.id, { lastPrompt: t });
                if (t.trim().toLowerCase() === '/clear') {
                  updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                }
                void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
              }}
              onToggleFullscreen={() => setFullscreen(null)}
              fullscreen
            />
          </div>
          <MessageQueueComposer agent={agent} />
        </div>
      </div>
    </div>
  );
}

function Tab({
  agent,
  active,
  onClick,
  onNoteChange
}: {
  agent: Agent;
  active: boolean;
  onClick: () => void;
  onNoteChange: (note: string) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const [notePosition, setNotePosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
  }, []);

  const showNote = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 280;
    // Fullscreen tabs sit against the top edge, so the note always opens BELOW
    // its agent. Clamp horizontally so right-most tabs stay inside the viewport.
    setNotePosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + 6
    });
  };

  const scheduleHideNote = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      // Keep the editor open while the user is typing, even if their pointer
      // leaves the popover. Blur schedules the normal close.
      if (noteRef.current?.contains(document.activeElement)) return;
      setNotePosition(null);
    }, 120);
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={onClick}
        onMouseEnter={showNote}
        onMouseLeave={scheduleHideNote}
        aria-label={`${agent.name} · ${agent.project}`}
        style={{
          height: active ? 38 : 32,
          padding: '0 10px',
          marginBottom: active ? 0 : 4,
          background: active ? 'var(--cth-cream-100)' : 'var(--cth-cream-300)',
          border: 'none',
          boxShadow: active
            ? 'inset 0 0 0 2px var(--cth-ink-900), inset 0 -3px 0 var(--cth-cream-100)'
            : 'inset 0 0 0 1px var(--cth-ink-700)',
          display: 'inline-flex', alignItems: 'center', gap: 8,
          cursor: 'pointer',
          position: 'relative',
          fontFamily: 'var(--cth-font-ui)', fontSize: 14,
          color: 'var(--cth-ink-900)',
          maxWidth: 240,
          whiteSpace: 'nowrap'
        }}
      >
        <div style={{
          width: 20, height: 32,
          background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          overflow: 'hidden'
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis',
          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px'
        }}>{agent.name.toUpperCase()}</span>
        <PixelBadge status={agent.status} />
      </button>
      {notePosition && createPortal(
        <div
          ref={noteRef}
          onMouseEnter={showNote}
          onMouseLeave={scheduleHideNote}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: notePosition.left,
            top: notePosition.top,
            width: 280,
            zIndex: 450,
            padding: 8,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 2px var(--cth-ink-900), 4px 4px 0 rgba(26,19,32,0.25)',
            boxSizing: 'border-box'
          }}
        >
          <div style={{
            marginBottom: 5,
            fontFamily: 'var(--cth-font-display)',
            fontSize: 8,
            lineHeight: '12px',
            color: 'var(--cth-ink-700)'
          }}>
            {agent.name.toUpperCase()} · PRIVATE NOTE
          </div>
          <input
            value={agent.note ?? ''}
            onChange={(e) => onNoteChange(e.target.value)}
            onFocus={() => {
              if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
            }}
            onBlur={scheduleHideNote}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setNotePosition(null);
                buttonRef.current?.focus();
              }
            }}
            placeholder="private note…"
            aria-label={`Note for ${agent.name}`}
            style={{
              width: '100%',
              height: 28,
              padding: '2px 7px',
              border: 'none',
              outline: 'none',
              boxSizing: 'border-box',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
              fontFamily: 'var(--cth-font-mono)',
              fontSize: 11,
              color: 'var(--cth-ink-900)'
            }}
          />
        </div>,
        document.body
      )}
    </>
  );
}

function Header({ agent }: { agent: Agent }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '6px 10px',
      background: 'var(--cth-cream-50)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
    }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px',
        color: 'var(--cth-ink-900)'
      }}>{agent.name.toUpperCase()}</span>
      <span style={{
        fontSize: 13, color: 'var(--cth-ink-500)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        maxWidth: 300
      }}>{agent.cwd}</span>
      <span style={{
        fontSize: 13, color: 'var(--cth-ink-700)',
        fontStyle: 'italic'
      }}>“{agent.description}”</span>
      <div style={{ marginLeft: 'auto' }}>
        <PixelBadge status={agent.status} />
      </div>
    </div>
  );
}
