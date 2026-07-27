/**
 * Agent providers — the CLI a worker runs on. The app is no longer Claude-only:
 * a worker can run Claude Code, the OpenAI Codex CLI (`codex`), Kimi Code
 * (`kimi`), the Antigravity CLI (`agy`, Gemini models), or any custom command.
 * Each provider declares how to build its spawn command (model/auto-mode flags) and
 * whether it accepts the hive's Claude-specific identity injection
 * (`--append-system-prompt` + `--settings`).
 *
 * Shared between main and renderer; keep it dependency-free (no electron, no UI).
 * Mirrors the shape of the upstream provider-preset work (PR #47 / issue #21) so
 * the two reconcile cleanly — this build adds the `antigravity` preset alongside
 * the existing `codex` preset.
 */
import type { CmdGroup } from './claudeCommands';
import { COMMAND_GROUPS as CLAUDE_COMMAND_GROUPS } from './claudeCommands';
import { CODEX_COMMAND_GROUPS } from './codexCommands';

export type AgentProvider = 'claude' | 'codex' | 'kimi' | 'antigravity' | 'custom';

export interface AgentProviderPreset {
  id: AgentProvider;
  label: string;
  /** The binary spawned when the user hasn't typed a custom command. */
  defaultCommand: string;
  /** Slash / CLI command reference for this provider. */
  commandGroups: CmdGroup[];
  /** Environment variable to set for non-interactive / first-run suppression. */
  nonInteractiveEnv?: Record<string, string>;
  /** Flag(s) appended to the command string when auto mode is active.
   *  Kept alongside `autoFlag` (same value) for the HEAD consumers that read
   *  `autoModeFlag` via `autoModeFlagForProvider`. */
  autoModeFlag: string;
  /** Show a model picker and splice the model into the command. */
  supportsModel: boolean;
  /** Flag that selects the session model, e.g. `--model`. */
  modelFlag?: string;
  /** Flag appended when the floor is in auto (skip-permissions) mode.
   *  PR #54 consumers read this; mirrors `autoModeFlag`. */
  autoFlag?: string;
  /** Claude Code accepts the hive identity injection (`--append-system-prompt`
   *  + hook `--settings`). Other CLIs don't — they spawn with the shared AGENT_*
   *  env only. Gates the Claude-specific spawn injection in hive.ensureAgent.
   *  NOTE: this gates the *Claude-only* flag path specifically — it is NOT the
   *  same as "participates in the hive". A non-hiveAware provider can still be a
   *  full hive citizen (live status + guarded idle delivery) via a `hookBridge`. */
  hiveAware: boolean;
  /** Which config-file lifecycle-hook bridge a NON-hiveAware provider uses to get
   *  the same live status that Claude gets from `--settings`:
   *    - 'agy'   → installAgyHooks() writes ~/.gemini/.../hooks.json (translating
   *                shim, because agy's stdin/stdout shape differs from Claude's).
   *    - 'codex' → installCodexHooks() writes a per-agent CODEX_HOME/hooks.json and
   *                reuses the Claude `cth-hook` shim verbatim (Codex's hook payload
   *                + response contract are already Claude-shaped).
   *  Claude leaves this undefined (it uses its native `--settings` path, gated by
   *  hiveAware); `custom` leaves it undefined (no bridge → no hooks). This is the
   *  single switch hive.ensureAgent dispatches on to wire the bridge. */
  hookBridge?: 'agy' | 'codex';
  /** Whether the router may DELIVER inbox mail to this provider (vs bouncing it
   *  to the god). Requires lifecycle status so the renderer can deliver only at a
   *  safe idle prompt: Claude natively, Antigravity/Codex via their hookBridge.
   *  A hookless custom provider cannot expose safe-idle state, so mail bounces.
   *  Distinct from hiveAware: agy/codex are NOT hiveAware (no Claude injection)
   *  but CAN receive inbox via their bridge. */
  canReceiveInbox: boolean;
  /** For non-hive-aware CLIs that still take an INITIAL prompt to orient the
   *  session (Antigravity's `agy -i "<prompt>"`), the flag to pass it under. The
   *  hive identity+protocol rides in as the first turn — the closest thing to
   *  Claude's `--append-system-prompt` these CLIs offer. undefined = the CLI
   *  takes its initial prompt POSITIONALLY (Codex: `codex "<prompt>"`) and the
   *  injection branch appends it as a quoted trailing arg instead of a flag. */
  initialPromptFlag?: string;
  /** This CLI accepts the initial hive prompt as a trailing positional argument.
   *  Codex does; Kimi/custom do not, so they must spawn bare when no prompt flag
   *  exists instead of receiving an invalid positional argument. */
  positionalInitialPrompt?: boolean;
  /** Flag to resume a prior session on respawn, given the recorded session id
   *  (Claude `--resume <sid>`, Antigravity `--conversation <id>`). undefined = no
   *  resume support, spawn fresh. */
  resumeFlag?: string;
  resumeSubcommand?: string; // CLIs that resume via a subcommand instead of a flag (Codex: `codex resume [OPTIONS] [SESSION_ID]`)
}

export const AGENT_PROVIDER_PRESETS: AgentProviderPreset[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    commandGroups: CLAUDE_COMMAND_GROUPS,
    autoModeFlag: '--permission-mode bypassPermissions',
    supportsModel: true,
    modelFlag: '--model',
    autoFlag: '--permission-mode bypassPermissions',
    hiveAware: true,
    canReceiveInbox: true,
    resumeFlag: '--resume'
  },
  {
    id: 'codex',
    label: 'Codex · GPT',
    defaultCommand: 'codex',
    commandGroups: CODEX_COMMAND_GROUPS,
    // Exact Codex equivalent of Claude's bypassPermissions: no approvals and no
    // Codex sandbox. Munder Difflin's global AUTO MODE is intentionally explicit
    // about this trust level; users can edit the per-agent command to remove it.
    autoModeFlag: '--dangerously-bypass-approvals-and-sandbox',
    autoFlag: '--dangerously-bypass-approvals-and-sandbox',
    // Suppresses first-run interactive prompts (directory-trust gate, installer).
    nonInteractiveEnv: { CODEX_NON_INTERACTIVE: '1' },
    supportsModel: true,
    modelFlag: '--model',
    // Codex is NOT hiveAware in the Claude-flag sense: it has no
    // `--append-system-prompt`/`--settings`. The hive protocol is injected as
    // Codex's INITIAL prompt, which it takes POSITIONALLY (`codex "<prompt>"`) —
    // hence initialPromptFlag is undefined and hive.ts appends it as a trailing arg.
    hiveAware: false,
    // …but Codex DOES expose a Claude-style hooks system (hooks.json / config.toml
    // [hooks]; PreToolUse/PostToolUse/Stop/…), so it gets full hive parity via the
    // 'codex' bridge: a per-agent CODEX_HOME/hooks.json wired to the cth-hook shim
    // (see hive.installCodexHooks). Stop→drain works natively (Codex's Stop honors
    // {decision:'block',reason} = continue-with-prompt, exactly like Claude).
    hookBridge: 'codex',
    // Inbox drains via the codex-hook bridge's Stop→drain (the renderer's idle
    // inbox-wake nudge remains as a harmless fallback for an idle worker).
    canReceiveInbox: true,
    initialPromptFlag: undefined,
    positionalInitialPrompt: true,
    // Codex resumes via a SUBCOMMAND, not a flag: `codex resume [OPTIONS]
    // [SESSION_ID]`. A `--resume <id>` flag does not exist, which is why restarts
    // used to silently start a brand-new session instead of continuing.
    resumeFlag: undefined,
    resumeSubcommand: 'resume'
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    defaultCommand: 'kimi',
    commandGroups: [],
    // Kimi --auto handles every approval and does not stop to ask questions,
    // matching Munder Difflin's autonomous Claude/Codex default.
    autoModeFlag: '--auto',
    autoFlag: '--auto',
    supportsModel: true,
    modelFlag: '--model',
    hiveAware: false,
    // Kimi's interactive TUI has no positional initial-prompt form. It supports
    // lifecycle hooks, but Munder Difflin does not yet install a Kimi hook bridge,
    // so mail must bounce rather than being delivered with no drain path.
    canReceiveInbox: false
  },
  {
    id: 'antigravity',
    label: 'Antigravity · Gemini',
    defaultCommand: 'agy',
    commandGroups: [],
    autoModeFlag: '--dangerously-skip-permissions',
    supportsModel: true,
    modelFlag: '--model',
    autoFlag: '--dangerously-skip-permissions',
    hiveAware: false,
    hookBridge: 'agy', // installAgyHooks() → ~/.gemini/.../hooks.json (translating shim)
    canReceiveInbox: true, // via the agy-hook bridge (Stop→drain); verified agy honors hook decisions
    initialPromptFlag: '-i', // agy --prompt-interactive: orient the session, then continue
    resumeFlag: '--conversation' // agy: resume a previous conversation by ID
  },
  {
    id: 'custom',
    label: 'Custom',
    defaultCommand: '',
    commandGroups: [],
    autoModeFlag: '',
    supportsModel: false,
    autoFlag: '',
    hiveAware: false,
    canReceiveInbox: false // no inbox-drain path → mail bounces to the god
  }
];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'kimi' ||
    value === 'antigravity' ||
    value === 'custom'
  );
}

export function normalizeAgentProvider(value: unknown): AgentProvider | undefined {
  return isAgentProvider(value) ? value : undefined;
}

export function providerPreset(provider: AgentProvider): AgentProviderPreset {
  return AGENT_PROVIDER_PRESETS.find((p) => p.id === provider) ?? AGENT_PROVIDER_PRESETS[0];
}

export function isClaudeProvider(provider: AgentProvider | undefined): boolean {
  return provider === 'claude';
}

/** Whether this provider takes the hive's Claude-only identity injection. */
export function isHiveAwareProvider(provider: AgentProvider | undefined): boolean {
  return providerPreset(provider ?? 'claude').hiveAware;
}

/** Whether the router may deliver inbox mail to this provider (else bounce to
 *  the god). True when lifecycle status supports guarded idle delivery; false
 *  for hookless custom commands. */
export function canReceiveInbox(provider: AgentProvider | undefined): boolean {
  return providerPreset(provider ?? 'claude').canReceiveInbox;
}

/** The bare executable from a command string ('agy --model x' → 'agy'). */
function commandBinary(command: string | undefined): string {
  const first = (command ?? '').trim().split(/\s+/)[0] ?? '';
  // strip a path + extension so 'C:\...\agy.exe' and '/usr/bin/claude' both map
  const leaf = first.split(/[\\/]/).pop() ?? first;
  return leaf.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** Infer the provider from a command (or honor an explicit override). */
export function inferAgentProvider(command: string | undefined, explicit?: unknown): AgentProvider {
  const normalized = normalizeAgentProvider(explicit);
  if (normalized) return normalized;
  const bin = commandBinary(command);
  if (bin === 'codex') return 'codex';
  if (bin === 'kimi') return 'kimi';
  if (bin === 'agy' || bin === 'antigravity') return 'antigravity';
  if (bin === 'claude' || !bin) return 'claude';
  return 'custom';
}

export function defaultCommandForProvider(provider: AgentProvider, fallback = ''): string {
  if (provider === 'custom') return fallback;
  return providerPreset(provider).defaultCommand || fallback;
}

/** Returns the preset's auto-mode CLI flag for the given provider. Empty string = no flag. */
export function autoModeFlagForProvider(provider: AgentProvider): string {
  return providerPreset(provider).autoModeFlag ?? '';
}

/** Returns any env vars the provider needs for non-interactive / first-run suppression. */
export function nonInteractiveEnvForProvider(provider: AgentProvider): Record<string, string> {
  return providerPreset(provider).nonInteractiveEnv ?? {};
}

/** Returns the command reference groups for the given provider. */
export function commandGroupsForProvider(provider: AgentProvider): CmdGroup[] {
  return providerPreset(provider).commandGroups ?? [];
}
