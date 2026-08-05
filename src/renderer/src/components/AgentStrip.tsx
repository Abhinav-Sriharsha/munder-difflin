import { useEffect, useState } from 'react';
import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import { type HarnessConfig } from '@/store/config';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';

export interface AgentStripProps {
  /** Needed to rebuild a spawn command when a restorable agent predates the
   *  persisted `command` field. Optional so the strip renders without config. */
  config?: HarnessConfig | null;
}

export function AgentStrip({ config }: AgentStripProps) {
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const openTaskDetail = useStore(s => s.openTaskDetail);
  const reorderAgents = useStore(s => s.reorderAgents);
  const setAgentNote = useStore(s => s.setAgentNote);
  // Shared with the fullscreen roster so both show one restore in progress.
  const { restoring, autoRestoring, restoreNote, restoreTeam } = useRestoreTeam(config);
  // Drag-to-reorder the roster: dragId = the card being dragged, overId = the card
  // currently hovered as a drop target (drives the insertion-line cue).
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [noteHoverId, setNoteHoverId] = useState<string | null>(null);
  // Each worker's actively-DOING ledger tasks, polled from hive/tasks.json —
  // rendered as a sticky note on the avatar card (click → task detail).
  const [doingByAgent, setDoingByAgent] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const raw = await window.cth.hiveTasks() as { tasks?: Array<{ id?: string; status?: string; assignee?: string }> } | null;
        if (cancelled) return;
        const map: Record<string, string[]> = {};
        for (const t of (raw && Array.isArray(raw.tasks)) ? raw.tasks : []) {
          if (t?.status === 'doing' && typeof t.assignee === 'string' && t.assignee && typeof t.id === 'string') {
            (map[t.assignee] = map[t.assignee] ?? []).push(t.id);
          }
        }
        setDoingByAgent(map);
      } catch { /* keep last good */ }
    };
    void poll();
    const iv = setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      padding: '14px 16px',
      overflowX: 'auto',
      overflowY: 'hidden',
      borderTop: '2px solid var(--cth-ink-900)',
      background: 'var(--cth-cream-200)',
      // Tall enough for the god card to stand proud of the row (it's taller and
      // rides a drop shadow) plus the hover-lift on every card, without clipping.
      height: 132,
      minHeight: 132,
      alignItems: 'center'
    }}>
      {agents.map(a => (
        // Draggable wrapper: reorder the roster by dragging one card onto another.
        // Native HTML5 DnD (no dep). A plain click still selects — a drag only
        // starts on movement — so AgentCard's onClick is unaffected.
        <div
          key={a.id}
          draggable
          onDragStart={(e) => { setDragId(a.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e) => {
            if (!dragId || dragId === a.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (overId !== a.id) setOverId(a.id);
          }}
          onDragLeave={() => { if (overId === a.id) setOverId(null); }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== a.id) reorderAgents(dragId, a.id);
            setDragId(null);
            setOverId(null);
          }}
          onDragEnd={() => { setDragId(null); setOverId(null); }}
          onMouseEnter={() => setNoteHoverId(a.id)}
          onMouseLeave={() => setNoteHoverId((id) => id === a.id ? null : id)}
          style={{
            position: 'relative',
            flexShrink: 0,
            cursor: 'grab',
            opacity: dragId === a.id ? 0.4 : 1,
            // Insertion-line cue on the hovered drop target.
            boxShadow: overId === a.id && dragId && dragId !== a.id
              ? 'inset 3px 0 0 0 var(--cth-ink-900)'
              : 'none',
            transition: 'opacity 120ms ease'
          }}
        >
          <AgentCard
            draggable
            name={a.name}
            character={a.character}
            accent={a.accent}
            status={a.status}
            ptyId={a.ptyId}
            project={a.project}
            action={a.action}
            progress={a.progress}
            contextTokens={a.contextTokens}
            contextLimit={a.contextLimit}
            selected={a.id === selectedId}
            isGod={a.isGod}
            onClick={() => select(a.id)}
            doingCount={doingByAgent[a.id]?.length ?? 0}
            onTaskNoteClick={() => {
              const first = doingByAgent[a.id]?.[0];
              if (first) openTaskDetail(first);
            }}
          />
          {noteHoverId === a.id && !dragId && (
            <div
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: 'absolute', left: 60, right: 7, bottom: 7, height: 30, zIndex: 5,
                display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px',
                background: 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-900), 2px 2px 0 rgba(26,19,32,0.2)',
                boxSizing: 'border-box'
              }}
            >
              <span style={{
                flexShrink: 0, fontFamily: 'var(--cth-font-mono)', fontSize: 10,
                lineHeight: '18px', color: 'var(--cth-ink-700)'
              }}>NOTE</span>
              {/* A textarea, not an input: the note is a bullet list (one line
                  each) and the fullscreen roster renders every line. An <input>
                  silently drops the newlines the moment the user edits here,
                  which would eat every bullet but the first. */}
              <textarea
                draggable={false}
                rows={1}
                wrap="off"
                value={a.note ?? ''}
                onChange={(e) => setAgentNote(a.id, e.target.value)}
                placeholder="private note…"
                aria-label={`Note for ${a.name}`}
                title={a.note || undefined}
                style={{
                  flex: 1, minWidth: 0, height: 22, padding: '2px 5px',
                  border: 'none', outline: 'none', boxSizing: 'border-box',
                  resize: 'none', overflow: 'auto',
                  background: 'var(--cth-cream-100)',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                  lineHeight: '18px', color: 'var(--cth-ink-900)'
                }}
              />
            </div>
          )}
        </div>
      ))}
      {autoRestoring && (
        // The team comes back on its own at boot, so SAY so — terminals opening
        // by themselves with no explanation reads as the app doing something
        // you didn't ask for.
        <span
          style={{
            alignSelf: 'center', flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 32, padding: '0 10px',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12,
            color: 'var(--cth-ink-900)',
            background: 'var(--cth-status-working)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
          }}
          title="Your previous session's agents are being respawned with their original ids, so memory and inboxes reattach."
        >
          <Icon name="play" /> restoring your team…
        </span>
      )}
      {restorableAgents.length > 0 && (
        <span
          style={{ alignSelf: 'center', flexShrink: 0 }}
          title={`Respawn from last session: ${restorableAgents.map((a: Agent) => a.name).join(', ')} — same ids, memory and inboxes reattach automatically`}
        >
          <PixelButton
            variant="primary"
            size="lg"
            onClick={restoreTeam}
            disabled={restoring}
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <Icon name="play" /> {restoring ? 'restoring…' : `restore team (${restorableAgents.length})`}
            </span>
          </PixelButton>
        </span>
      )}
      {/* Per-agent dismiss: drop one worker from the restore list for good. Wires
          straight to the store's removeRestorableAgent (filters + persistRestorable
          → cth.restorableAgents), so a dismissed agent never reappears after reload. */}
      {restorableAgents.length > 0 && (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          {restorableAgents.map((a: Agent) => (
            <span
              key={a.id}
              title={`${a.name} — restorable from last session`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                flexShrink: 0, height: 24, padding: '0 4px 0 8px',
                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                color: 'var(--cth-ink-700)', background: 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}
            >
              {a.name}
              <button
                onClick={() => useStore.getState().removeRestorableAgent(a.id)}
                title={`Dismiss ${a.name} — remove permanently from the restore list`}
                aria-label={`Dismiss ${a.name}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 16, height: 16, padding: 0, lineHeight: 1,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                  color: 'var(--cth-ink-500)', background: 'transparent',
                  border: 'none', cursor: 'pointer'
                }}
              >✕</button>
            </span>
          ))}
        </span>
      )}
      {restoreNote && (
        <span
          style={{
            alignSelf: 'center', flexShrink: 0, maxWidth: 360,
            fontFamily: 'var(--cth-font-ui)', fontSize: 12,
            color: 'var(--cth-ink-500)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}
          title={restoreNote}
        >
          {restoreNote}
        </span>
      )}
      <PixelButton
        variant="secondary"
        size="lg"
        style={{ alignSelf: 'center', flexShrink: 0 }}
        onClick={() => setAddAgentOpen(true)}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          <Icon name="plus" /> add agent
        </span>
      </PixelButton>
    </div>
  );
}
