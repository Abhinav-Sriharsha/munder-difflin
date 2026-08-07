/**
 * The missing-engine-CLI install ladder.
 *
 * Split out of index.ts deliberately: it imports NOTHING from electron, so the
 * decision ("which installer can actually succeed on this machine?") and the
 * script it emits are both testable without booting an app.
 */
import type { AgentProvider, ProviderInstallInfo } from '../shared/agentProvider';
import { installInfoForProvider } from '../shared/agentProvider';

/** Pick which rung of the install ladder to run, given what this machine has.
 *
 *  Every provider's `installCommand` is `npm install -g …`, which needs npm,
 *  which needs node. On a machine with no node the banner used to print that
 *  command anyway and run it — so the user watched `npm: command not found`
 *  scroll past and concluded the app was broken. Classify first:
 *
 *    npm present                   → npm install (unchanged; the common case)
 *    npm absent, native installer  → the vendor's self-contained installer
 *    npm absent, no native         → manual only. Do NOT run a doomed command.
 *
 *  We never auto-install a system Node, touch nvm, or edit the user's shell rc —
 *  a missing runtime is the user's to resolve, and the manual rung says so. */
export function chooseInstallRung(
  info: ProviderInstallInfo,
  npmAvailable: boolean
): { command?: string; kind: 'npm' | 'native' | 'manual'; nodeMissing: boolean } {
  if (info.command && npmAvailable) return { command: info.command, kind: 'npm', nodeMissing: false };
  if (info.nativeCommand) return { command: info.nativeCommand, kind: 'native', nodeMissing: !npmAvailable };
  return { kind: 'manual', nodeMissing: !npmAvailable };
}

/** Build the shell script the missing-CLI auto-install path runs IN PLACE of a
 *  missing engine CLI. When a rung of the ladder above is runnable it prints a
 *  banner then RUNS it visibly (so the user can watch + finish any sign-in);
 *  otherwise it prints a manual instruction only and runs nothing. The script is
 *  emitted in the target platform's shell syntax ($SHELL on unix, cmd.exe on
 *  Windows) — `platform` is a parameter only so the Windows branch is reachable
 *  from a test on macOS. The only user-derived value (the missing binary name) is
 *  sanitized to a safe identifier; the install commands are trusted constants. */
export function buildMissingCliScript(
  bin: string,
  provider: AgentProvider,
  npmAvailable: boolean,
  platform: string = process.platform
): string {
  const info: ProviderInstallInfo = installInfoForProvider(provider, platform);
  const safeBin = (bin || provider).replace(/[^A-Za-z0-9._-]/g, '') || provider;
  const rung = chooseInstallRung(info, npmAvailable);
  const cmd = rung.command; // trusted constant, or undefined → manual hint only
  const label = info.label;
  const docs = info.docsUrl;
  const rule = '------------------------------------------------------------';

  if (platform === 'win32') {
    // ONE cmd.exe line: `&` chains steps, `^&` prints a literal ampersand, and the
    // script carries NO double-quotes (it is wrapped verbatim in `/d /s /c "..."`).
    // We avoid `if errorlevel` branching (untestable here) — a combined success/
    // failure hint after the install is robust and satisfies the manual-fallback DoD.
    const parts: string[] = ['echo.', `echo ${rule}`, `echo   Engine CLI not found:  ${safeBin}`, 'echo.'];
    if (rung.nodeMissing) {
      parts.push('echo   Node.js is not installed on this machine, so the usual', 'echo   npm installer cannot run here.', 'echo.');
    }
    if (cmd) {
      if (rung.kind === 'native') parts.push(`echo   Using the self-contained ${label} installer instead ^(no Node needed^):`);
      else parts.push(`echo   Installing the ${label} CLI now so you can watch:`);
      parts.push(
        'echo.',
        `echo     ${cmd}`,
        `echo ${rule}`,
        'echo.',
        cmd,
        'echo.',
        'echo   [done] If it succeeded, the agent launches automatically.',
        'echo   If it failed, run the command above manually, then restart the agent.'
      );
    } else {
      if (rung.nodeMissing) {
        parts.push(
          `echo   Install Node.js ^(nodejs.org^), then the ${label} CLI:`,
          `echo     ${info.command ?? ''}`,
          'echo   …or install the CLI by whatever method its docs recommend.'
        );
      } else {
        parts.push(
          `echo   No bundled installer for the ${label} provider.`,
          'echo   Install it manually, then restart the agent to launch it.'
        );
      }
      if (docs) parts.push(`echo   Docs: ${docs}`);
      parts.push(`echo ${rule}`);
    }
    return parts.join(' & ');
  }

  // unix ($SHELL -lc <script>): one statement per line, single-quoted echo text so
  // no shell metacharacter expands. We avoid `!` so any shell with history
  // expansion never fires. npm is found via the interactive PATH spawn() injects.
  const lines: string[] = [
    `echo ''`,
    `echo '${rule}'`,
    `echo '  Engine CLI not found:  ${safeBin}'`,
    `echo ''`
  ];
  if (rung.nodeMissing) {
    lines.push(
      `echo '  Node.js is not installed on this machine, so the usual npm'`,
      `echo '  installer cannot run here.'`,
      `echo ''`
    );
  }
  if (cmd) {
    lines.push(
      ...(rung.kind === 'native'
        ? [`echo '  Using the self-contained ${label} installer instead (no Node needed) —'`,
           `echo '  finish any sign-in it prompts for, then come back to this terminal.'`]
        : [`echo '  Installing the ${label} CLI now so you can watch — finish any'`,
           `echo '  sign-in it prompts for, then come back to this terminal.'`]),
      `echo ''`,
      `echo '    ${cmd}'`,
      `echo '${rule}'`,
      `echo ''`,
      cmd,
      `__clirc=$?`,
      `echo ''`,
      `if [ $__clirc -eq 0 ]; then`,
      `  echo '  [done] Installed — launching the agent…'`,
      `else`,
      `  echo "  [x] Install exited with code $__clirc — finish it manually:"`,
      `  echo '    ${cmd}'`,
      ...(docs ? [`  echo '    Docs: ${docs}'`] : []),
      `  echo '  Then restart the agent to launch it.'`,
      `fi`
    );
  } else if (rung.nodeMissing) {
    // The honest dead end: no node, and this vendor ships no node-free installer.
    // Say what is actually missing instead of running a command that cannot work.
    lines.push(
      `echo '  Install Node.js (nodejs.org), then the ${label} CLI:'`,
      ...(info.command ? [`echo '    ${info.command}'`] : []),
      `echo '  …or install the CLI by whatever method its docs recommend.'`,
      ...(docs ? [`echo '  Docs: ${docs}'`] : []),
      `echo '${rule}'`
    );
  } else {
    lines.push(
      `echo '  No bundled installer for the ${label} provider.'`,
      `echo '  Install it manually, then restart the agent to launch it.'`,
      ...(docs ? [`echo '  Docs: ${docs}'`] : []),
      `echo '${rule}'`
    );
  }
  return lines.join(String.fromCharCode(10));
}
