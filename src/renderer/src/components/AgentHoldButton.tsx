import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';

/**
 * 1:1 — "I have this agent, Michael stop sending it work."
 *
 * Lives in `AgentControlStrip` beside "block tools" and "stop after this step",
 * so it is present in both sidebar and focus mode. It was briefly in the title
 * bar, which focus mode covers, making it invisible in the one mode you are
 * most likely to be in during a 1:1.
 *
 * It is a different KIND of control from the two it sits with, and the tooltip
 * carries that since the grouping no longer does: those two restrain the AGENT
 * (take its tools, or stop it after this step), while this one restrains
 * MICHAEL. The agent keeps running and keeps answering you. "Stop after this
 * step" is in fact the worst thing to reach for in a 1:1, because it stops the
 * agent you wanted to talk to.
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
          ? `End the 1:1. Michael can hand ${agent.name} work again.`
          : `Take ${agent.name} aside. Michael stops sending them work until you end it. Unlike the two buttons here, this does not restrain the agent: they keep running and keep answering you.`}
        aria-label={on ? 'End the 1:1 and release this agent to Michael' : 'Take this agent aside for a 1:1'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Icon name={on ? 'pause' : 'play'} /> {on ? 'in 1:1' : '1:1'}
      </span>
    </PixelButton>
  );
}
