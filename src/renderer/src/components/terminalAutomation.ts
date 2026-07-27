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
