import type { AgentProvider } from './agentProvider';

const COMPACTION_FOCUS =
  'Summarise exactly what you are currently working on and the next step, ' +
  'so you can resume from the same point — then continue that work after compacting.';

/** Generate only commands that the target provider's interactive TUI supports. */
export function compactionCommandForProvider(provider: AgentProvider): string | null {
  switch (provider) {
    case 'claude':
      return `/compact ${COMPACTION_FOCUS}`;
    case 'codex':
      // Codex treats trailing text differently across CLI releases. Its stable
      // automation form is the bare slash command.
      return '/compact';
    case 'kimi':
      // Kimi Code documents `/compact [<instruction>]`, so preserve the task
      // focus in its supported optional instruction.
      return `/compact ${COMPACTION_FOCUS}`;
    default:
      return null;
  }
}

/** Safe fallback when a provider has no native context-compaction command. */
export function compactionPromptFallback(): string {
  return (
    'Summarise the current task, decisions, and exact next step in your persistent ' +
    'memory, then continue from that checkpoint.'
  );
}

/** Claude exposes remote control as a slash command; Codex uses its daemon and
 * Kimi has no equivalent slash command. */
export function remoteControlCommandForProvider(
  provider: AgentProvider,
  sessionName?: string
): string | null {
  if (provider !== 'claude') return null;
  const name = sessionName?.trim();
  return name ? `/remote-control ${name}` : '/remote-control';
}

/** Initial TUI output needs a short provider-specific settle before typing. */
export function terminalReadySettleMs(provider: AgentProvider): number {
  switch (provider) {
    case 'kimi': return 650;
    case 'codex': return 500;
    default: return 400;
  }
}

/**
 * A live TUI is ready after it has produced an initial frame and had a short
 * settle period. Do not require output to become quiet: Codex can continuously
 * repaint its status line, which previously kept queued messages blocked until
 * every readiness attempt timed out.
 *
 * `undefined` is accepted for compatibility with a renderer hot-reloaded
 * against an older main process that does not yet expose `hasOutput`.
 */
export function terminalReadyToReceive(
  hasOutput: boolean | undefined,
  elapsedMs: number,
  provider: AgentProvider
): boolean {
  return hasOutput !== false && elapsedMs >= terminalReadySettleMs(provider);
}
