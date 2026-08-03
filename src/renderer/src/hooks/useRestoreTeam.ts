import { useSyncExternalStore } from 'react';
import { useStore } from '@/store/store';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type HarnessConfig } from '@/store/config';

/** "Restore team" — respawn every worker from the previous session.
 *
 *  Lives here rather than inside AgentStrip because the floor strip is hidden in
 *  fullscreen, which used to mean the restore button (and the list of restorable
 *  agents) simply vanished when you went fullscreen. Both mount points share the
 *  progress state below, so a restore kicked off from one view shows as running
 *  in the other and can't be double-started. */

let restoring = false;
let note: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// useSyncExternalStore requires a stable snapshot identity — returning a fresh
// object each call would loop forever, so the two fields are read separately.
const getRestoring = (): boolean => restoring;
const getNote = (): string | null => note;

export interface RestoreTeamState {
  restoring: boolean;
  /** Outcome of the last run ("restored 3 · 1 failed — …"), or null. */
  restoreNote: string | null;
  restoreTeam: () => Promise<void>;
}

/**
 * @param config used only to rebuild a spawn command for a restorable agent
 *        persisted before the `command` field existed.
 */
export function useRestoreTeam(config?: HarnessConfig | null): RestoreTeamState {
  const isRestoring = useSyncExternalStore(subscribe, getRestoring, getRestoring);
  const restoreNote = useSyncExternalStore(subscribe, getNote, getNote);

  /** Respawn every worker from the previous session with its ORIGINAL agent id,
   *  cwd, model and command — the hive workspace (memory.md, inbox, registry
   *  entry) reattaches by itself, no memory transplant needed. */
  const restoreTeam = async (): Promise<void> => {
    if (restoring) return;
    restoring = true;
    note = null;
    emit();
    const prevSel = useStore.getState().selectedId;
    const restorableAgents = useStore.getState().restorableAgents;
    // Tally every agent's outcome so the run ALWAYS leaves a visible trace — the
    // original bug was that every failure path was console-only, so a click that
    // couldn't spawn anything looked like a dead button.
    let restored = 0;
    let alreadyLive = 0;
    const failures: string[] = [];
    try {
      // Restore every agent CONCURRENTLY. Each spawn is keyed by its own ptyId and
      // touches no cross-agent state in the renderer, and in the main process the
      // whole `pty:spawn` handler (hive registry read-modify-write included) runs
      // synchronously between awaits, so concurrent handlers can't interleave
      // mid-update. Serially this cost the sum of every agent's git probe + spawn;
      // a 6-agent team took ~6× one agent for no reason.
      await Promise.all([...restorableAgents].map(async (a) => {
        // Per-agent guard: one agent's failure (or a rejected IPC call) must NEVER
        // abort the others — an unhandled rejection here used to make the
        // entire restore a silent no-op after the first bad agent.
        try {
          const provider = inferAgentProvider(a.command, a.provider);
          const command = (a.command ?? '').trim() || (config ? buildSpawnCommand(config, a.model, provider) : '');
          if (!command || !a.cwd) {
            // No spawn recipe (an old entry persisted before `command`, with no
            // config to rebuild one). Keep it restorable and SAY why rather than
            // silently dropping it — silent removal read as "nothing happened".
            failures.push(`${a.name}: no saved command`);
            return;
          }
          const [exe, ...args] = tokenizeCommand(command);
          const ptyId = a.ptyId ?? `pty-${a.id}`;
          // An isolated agent's worktree SURVIVES an app restart on disk (it's only
          // torn down on per-tab close / mid-session exit, not on quit). So re-enter
          // that exact worktree as the cwd rather than re-isolating — `git worktree
          // add` would conflict with the existing path/branch, and re-isolating would
          // also lose the worktree's uncommitted work. cwd = the worktree means
          // resume + seedSessionTranscript land in the CORRECT checkout.
          // But the user may have manually pruned/deleted the worktree between runs —
          // gitIsRepo (git rev-parse) returns false for a missing/invalid dir, so
          // fall back to the base repo cwd rather than spawning into a dead path.
          let cwd = a.cwd;
          let worktreeGone = false;
          if (a.worktreePath) {
            if (await window.cth.gitIsRepo(a.worktreePath)) {
              cwd = a.worktreePath;
            } else {
              worktreeGone = true;
              console.warn(`[restore] worktree gone for ${a.id} (${a.worktreePath}); falling back to base repo ${a.cwd}`);
            }
          }
          const res = await window.cth.spawnPty({
            id: ptyId,
            cwd,
            command: exe,
            provider,
            args,
            cols: 100,
            rows: 30,
            // Worktree (if any) already exists on disk — cd into it, don't create a
            // new one (re-isolating would conflict on the existing path/branch and
            // lose its uncommitted work).
            isolate: false,
            // Continue the worker's prior CLI session if one was recorded — the
            // main process picks the provider's resume flag (Claude --resume,
            // agy --conversation) and for Claude reattaches the transcript. The
            // agent id is preserved across restart, so its registry entry,
            // memory.md and inbox reattach by id. No-op without a recorded session.
            resume: true,
            hive: { id: a.id, name: a.name, provider, cwd, role: a.description }
          });
          if (res.ok) {
            restored++;
            useStore.getState().addAgent({
              ...a,
              provider,
              ptyId,
              archived: false,
              status: 'idle',
              // Surface the worktree fallback on the floor card; otherwise normal.
              action: worktreeGone ? 'worktree gone — using base repo' : 'starting up',
              // The worktree is no longer on disk — drop it so this agent is treated
              // as a plain base-cwd agent going forward (a future restore won't keep
              // re-probing a dead path).
              worktreePath: worktreeGone ? undefined : a.worktreePath,
              carrying: undefined,
              currentStation: 'desk',
              recentTextTs: Date.now()
            });
          } else if ((res.error ?? '').includes('already exists')) {
            // A live PTY with this id is already running (e.g. respawned at boot or
            // by another path) — the agent isn't actually missing, so retire it from
            // the restorable list rather than reporting a phantom failure.
            alreadyLive++;
            useStore.getState().removeRestorableAgent(a.id);
          } else {
            // Leave it restorable so the user can retry — but record WHY so the
            // outcome is shown on the floor, not buried in the devtools console.
            failures.push(`${a.name}: ${res.error ?? 'spawn failed'}`);
            console.error('[restore] spawn failed for', a.id, res.error);
          }
        } catch (e) {
          failures.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`);
          console.error('[restore] error for', a.id, e);
        }
      }));
    } finally {
      // addAgent auto-selects each spawn; put the user back where they were.
      const sel = useStore.getState();
      if (prevSel && sel.agents.some((x) => x.id === prevSel)) sel.select(prevSel);
      restoring = false;
      // ALWAYS surface a result so the button can never look inert.
      const parts: string[] = [];
      if (restored) parts.push(`restored ${restored}`);
      if (alreadyLive) parts.push(`${alreadyLive} already live`);
      if (failures.length) parts.push(`${failures.length} failed — ${failures.join('; ')}`);
      note = parts.length ? parts.join(' · ') : 'nothing to restore';
      emit();
    }
  };

  return { restoring: isRestoring, restoreNote, restoreTeam };
}
