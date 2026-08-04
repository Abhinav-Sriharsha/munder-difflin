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
  // Only a BARE command opens a picker. `/model` prompts you to choose;
  // `/model sonnet` applies the argument and returns to the prompt with no UI
  // to close. Matching on the first token alone latched the block on the second
  // form too, and nothing could ever clear it — the agent's message queue then
  // silently stopped delivering for the rest of the session.
  const trimmed = input.trim().toLowerCase();
  if (/\s/.test(trimmed)) return false;
  return INTERACTIVE_COMMANDS.has(trimmed);
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

/** How long an untouched picker keeps blocking queue delivery.
 * Like the draft block, this MUST expire. The picker latch is set when the user
 * submits a bare `/model`-style command and is only cleared by an Enter, Escape
 * or Ctrl-C typed into that same terminal — so a picker the AGENT closes, or one
 * dismissed any other way, left the flag set with no path back. That wedged the
 * agent's queue permanently, which is exactly the failure this expiry ends.
 * Longer than the draft window: a human picking from a menu is slower than a
 * human typing, and re-latching costs nothing. */
export const STALE_PICKER_MS = 180_000;

export interface TerminalAutomationState {
  exited: boolean;
  pickerOpen: boolean;
  inputDirty: boolean;
  settleUntil: number;
  inputDirtyAt?: number; // last keystroke that left a draft; absent ⇒ never expires
  pickerOpenedAt?: number; // when the picker latched; absent ⇒ never expires
}

/** A picker nobody has interacted with for STALE_PICKER_MS is treated as gone. */
export function isStaleTerminalPicker(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return state.pickerOpen
    && state.pickerOpenedAt !== undefined
    && now - state.pickerOpenedAt >= STALE_PICKER_MS;
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
  if (state.pickerOpen && !isStaleTerminalPicker(state, now)) return 'picker';
  if (state.inputDirty && !isStaleTerminalDraft(state, now)) return 'draft';
  if (now < state.settleUntil) return 'settling';
  return null;
}

/** What an automatic writer must DO before it may type into this terminal.
 *
 *  `terminalAutomationBlock` answers "may I type?", and reports an EXPIRED block
 *  as no block at all. That answer is a guess: an expiry only means nobody has
 *  touched the picker/draft for a while, not that it is gone. Every caller that
 *  acted on the guess by typing was a bug — a queued message typed into a live
 *  menu and acknowledged as delivered, or an inbox nudge fused onto the user's
 *  half-written line. So expiries resolve to an ACTION that frees the prompt
 *  ('dismiss-picker' ⇒ send Escape, 'clear-draft' ⇒ send Ctrl-U and keep the
 *  text), after which the caller retries once the TUI has repainted. */
export type TerminalAutomationAction = 'go' | 'dismiss-picker' | 'clear-draft' | 'wait';

export function nextTerminalAutomationAction(
  state: TerminalAutomationState,
  now = Date.now()
): TerminalAutomationAction {
  // A dead pty cannot be freed by typing into it.
  if (state.exited) return 'wait';
  // Picker outranks draft: both flags are set while a slash menu is open, and
  // Ctrl-U into a menu edits the menu's filter rather than freeing the prompt.
  if (state.pickerOpen) return isStaleTerminalPicker(state, now) ? 'dismiss-picker' : 'wait';
  if (state.inputDirty) return isStaleTerminalDraft(state, now) ? 'clear-draft' : 'wait';
  if (now < state.settleUntil) return 'wait';
  return 'go';
}

/** Automatic writes may own the prompt only when no user draft or picker does. */
export function canAutomateTerminal(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return terminalAutomationBlock(state, now) === null;
}
