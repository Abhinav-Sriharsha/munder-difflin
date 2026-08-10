/**
 * useLimitWatch — watch every agent's terminal for "you've hit your limit".
 *
 * Subscribes to the raw pty stream directly rather than riding the terminal
 * pool's `onData`, for one reason that matters: `onData` is set by whichever
 * VIEW is mounted, so it only fires for the agent the operator happens to be
 * looking at. A limit almost always lands on an agent nobody is watching — that
 * is the whole reason the message gets lost today — so detection has to be
 * independent of what is on screen.
 *
 * Two subscriptions per pty is fine: `pty:data:<id>` is a plain ipcRenderer
 * channel and every listener on it receives the same chunk.
 *
 * The decision itself lives in main (`limit:report` → `LimitGate`), so a second
 * floor watching the same agent cannot arm two conflicting holds, and a renderer
 * reload cannot lose one.
 */
import { useEffect, useRef } from 'react';
import { useStore } from '@/store/store';
import { inferAgentProvider } from '@/store/config';
import { createLimitDetector } from '@shared/rateLimit';
import type { AgentProvider } from '@shared/agentProvider';

interface Watch {
  unsub: () => void;
  detector: ReturnType<typeof createLimitDetector>;
  provider: AgentProvider;
}

export function useLimitWatch(enabled: boolean): void {
  const agents = useStore((s) => s.agents);
  const setLimitHolds = useStore((s) => s.setLimitHolds);
  const watches = useRef(new Map<string, Watch>());

  // Seed the mirror and keep it fresh. Main owns holds; this is the only path
  // by which the renderer learns about them, including ones armed by another
  // floor or reinstated from disk at launch.
  useEffect(() => {
    let alive = true;
    window.cth.limitList()
      .then((holds) => { if (alive) setLimitHolds(holds); })
      .catch(() => { /* older main process — the gate is simply absent */ });
    const off = window.cth.onLimitChanged((holds) => setLimitHolds(holds));
    return () => { alive = false; off(); };
  }, [setLimitHolds]);

  useEffect(() => {
    const live = new Map<string, AgentProvider>();
    if (enabled) {
      for (const a of agents) {
        if (!a.ptyId || a.archived) continue;
        live.set(a.ptyId, inferAgentProvider(a.command, a.provider));
      }
    }

    // Drop watches for ptys that died, were archived, or changed provider (a
    // respawn under a different CLI needs a detector primed for the new one).
    for (const [ptyId, watch] of watches.current) {
      if (live.get(ptyId) === watch.provider) continue;
      watch.unsub();
      watches.current.delete(ptyId);
    }

    for (const [ptyId, provider] of live) {
      if (watches.current.has(ptyId)) continue;
      const detector = createLimitDetector(provider);
      const agentIdFor = (): string | undefined =>
        useStore.getState().agents.find((a) => a.ptyId === ptyId)?.id;

      const unsub = window.cth.onPtyData(ptyId, (chunk) => {
        const signal = detector.push(chunk, Date.now());
        if (!signal) return;
        const agentId = agentIdFor();
        if (!agentId) return; // agent removed between the write and this frame
        void window.cth.limitReport({ agentId, provider, signal })
          .catch(() => { /* main is mid-teardown; the next chunk retries */ });
      });
      watches.current.set(ptyId, { unsub, detector, provider });
    }
  }, [agents, enabled]);

  // Unsubscribe everything on unmount — the ref outlives the effect's deps.
  const watchesRef = watches;
  useEffect(() => () => {
    for (const w of watchesRef.current.values()) w.unsub();
    watchesRef.current.clear();
  }, [watchesRef]);
}
