/** Slash commands that open an interactive picker/panel instead of starting a
 * normal agent turn. Automated queue delivery must wait until that UI closes. */
const INTERACTIVE_COMMANDS = new Set([
  '/model',
  '/reasoning',
  '/permissions',
  '/permission',
  '/provider',
  '/settings',
  '/config',
  '/experimental',
  '/experiments',
  '/hooks',
  '/mcp',
  '/apps',
  '/plugins',
  '/resume',
  '/sessions'
]);

export function opensInteractiveTerminalUi(input: string): boolean {
  const command = input.trim().toLowerCase().split(/\s+/, 1)[0];
  return INTERACTIVE_COMMANDS.has(command);
}

/** Follow output only if the user was already at (or one line from) the bottom.
 * This keeps live TUIs visible without yanking someone reading scrollback. */
export function shouldFollowTerminalOutput(viewportY: number, baseY: number): boolean {
  return baseY - viewportY <= 1;
}

/** How long an untouched draft on the prompt keeps blocking queue delivery.
 * A draft blocks so automation can't fuse its text with the user's, but the
 * block MUST expire: the renderer's line buffer is only a model of the real
 * input line, and a TUI that swallows keystrokes for its own UI can leave the
 * buffer non-empty while the prompt looks clear — which used to wedge an
 * agent's queue permanently with the composer still claiming it was sending. */
export const STALE_INPUT_MS = 60_000;

export interface TerminalAutomationState {
  exited: boolean;
  pickerOpen: boolean;
  inputDirty: boolean;
  settleUntil: number;
  inputDirtyAt?: number; // last keystroke that left a draft; absent ⇒ never expires
}

/** Why automation may not own the prompt right now, or null when it may. */
export type TerminalAutomationBlock = 'exited' | 'picker' | 'draft' | 'settling' | null;

/** A draft nobody has touched for STALE_INPUT_MS is treated as abandoned. */
export function isStaleTerminalDraft(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return state.inputDirty
    && state.inputDirtyAt !== undefined
    && now - state.inputDirtyAt >= STALE_INPUT_MS;
}

export function terminalAutomationBlock(
  state: TerminalAutomationState,
  now = Date.now()
): TerminalAutomationBlock {
  if (state.exited) return 'exited';
  if (state.pickerOpen) return 'picker';
  if (state.inputDirty && !isStaleTerminalDraft(state, now)) return 'draft';
  if (now < state.settleUntil) return 'settling';
  return null;
}

/** Automatic writes may own the prompt only when no user draft or picker does. */
export function canAutomateTerminal(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return terminalAutomationBlock(state, now) === null;
}
