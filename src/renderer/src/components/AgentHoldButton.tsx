import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';

/**
 * 1:1 HOLD — "I have this agent, Michael stop sending it work."
 *
 * Sits immediately left of the IDE button on BOTH agent surfaces (the sidebar
 * detail panel and the focus-mode header) because focus mode covers the title
 * bar, so a title-bar control simply vanishes in the mode where you are most
 * likely to be working with one agent one-on-one.
 *
 * Distinct from the pause and halt controls below the header, and the tooltip
 * says so, because the three look interchangeable and are not: pause and halt
 * stop the AGENT (deny its tools, or stop it after this step), while hold stops
 * MICHAEL (the agent keeps running and answering you). Halt in particular is
 * the wrong tool for a 1:1 — it stops the agent you wanted to talk to.
 *
 * Never rendered for Michael himself: telling the orchestrator to stop routing
 * work to itself is not a state worth having.
 */
export function AgentHoldButton({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const [busy, setBusy] = useState(false);

  // The registry is the record and it survives restarts, so the store's copy
  // can be stale on a fresh launch. Read it back once per agent.
  useEffect(() => {
    let alive = true;
    window.cth.hiveRegistry?.().then((reg) => {
      if (!alive) return;
      const onHold = !!(reg as { agents?: Record<string, { onHold?: boolean }> })?.agents?.[agentId]?.onHold;
      if (onHold !== !!useStore.getState().agents.find((a) => a.id === agentId)?.onHold) {
        useStore.getState().updateAgent(agentId, { onHold });
      }
    }).catch(() => { /* no hive — the button is harmless either way */ });
    return () => { alive = false; };
  }, [agentId]);

  if (!agent || agent.isGod) return null;
  const on = !!agent.onHold;

  return (
    <PixelButton
      variant={on ? 'primary' : 'secondary'}
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        // Mirror locally only after main confirms the write. Flipping
        // optimistically would show a hold Michael never heard about.
        void window.cth.hiveSetAgentHold(agentId, !on)
          .then((r) => { if (r.ok) useStore.getState().updateAgent(agentId, { onHold: !on }); })
          .finally(() => setBusy(false));
      }}
    >
      <span
        className="cth-tip cth-tip-wrap"
        data-tip={on
          ? `Release ${agent.name}. Michael can hand them work again.`
          : `Hold ${agent.name} for a 1:1. Michael stops sending them work until you release. They keep running and answering you — this is not pause or halt.`}
        aria-label={on ? 'Release this agent to Michael' : 'Hold this agent for a 1:1'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Icon name={on ? 'pause' : 'play'} /> {on ? 'on hold' : 'hold'}
      </span>
    </PixelButton>
  );
}
