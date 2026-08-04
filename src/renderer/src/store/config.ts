// Mirrors src/main/config.ts. Kept as a renderer-side type-only module
// so we don't have to reach into the preload package to type-check.
import {
  AGENT_PROVIDER_PRESETS,
  providerPreset,
  inferAgentProvider,
  isClaudeProvider,
  type AgentProvider
} from '@shared/agentProvider';

export {
  AGENT_PROVIDER_PRESETS,
  providerPreset,
  inferAgentProvider,
  isClaudeProvider,
  type AgentProvider
};

/** A recurring auto-dispatched mission (mirrors src/main/config.ts). */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  autoCompact?: boolean;
  lastFiredAt?: number;
  kind?: 'dispatch' | 'heartbeat';
  quietThresholdMs?: number;
}

/** Circuit-breaker thresholds (mirrors src/main/config.ts CircuitBreakerConfig). */
export interface CircuitBreakerConfig {
  enabled?: boolean;
  hardStop?: boolean;
  repeatedToolLimit?: number;
  errorStormLimit?: number;
  tokenVelocityPerMin?: number;
}

/** Enterprise Knowledge Graph config (mirrors src/main/config.ts KnowledgeGraphConfig). */
export interface KnowledgeGraphConfig {
  enabled?: boolean;
  rootPath?: string;
}

export interface HarnessConfig {
  onboardingComplete: boolean;
  harnessHome: string | null;
  registeredRepos: string[];
  autoMode: boolean;
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default. */
  defaultModel?: string;
  semanticMemory: boolean;
  embeddingModel: 'minilm' | 'embeddinggemma';
  missions?: ScheduledMission[];
  opsStandupSeeded?: boolean;
  heartbeatSeeded?: boolean;
  notifications?: boolean;
  slackEnabled?: boolean;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  slackPort?: number;
  /** Free Flow voice dictation (mirrors src/main/config.ts). */
  freeflowEnabled?: boolean;
  groqApiKey?: string;
  freeflowModel?: string;
  costCapUsd?: number;
  /** Hard total-token ceiling across active agents (the user-facing budget). */
  costCapTokens?: number;
  /** Per-agent total-token ceiling, keyed by agent id. Overrides the floor budget
   *  for that agent's meter and trips the breaker for it alone. */
  agentTokenCaps?: Record<string, number>;
  autoDeliveryPausedAgents?: string[];
  maxTurns?: number;
  circuitBreaker?: CircuitBreakerConfig;
  /** Enterprise Knowledge Graph (multimodal context for agents). Default OFF. */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** TV-show office themes feature flag (Settings picker + switch flow). Default OFF. */
  tvShowOffices?: boolean;
  /** Active office map/cast theme (honored only when tvShowOffices is on). */
  officeTheme?: 'office' | 'friends' | 'brooklyn99' | 'siliconvalley' | 'got' | 'hogwarts';
}

/** The Sonnet model with the 1M-token context window — used for Michael's prep
 *  assistant (cheap, large-context context gathering). Mirrors ASSISTANT_MODEL
 *  in src/main/assistant.ts; keep the two in sync. */
export const ASSISTANT_MODEL = 'claude-sonnet-4-6[1m]';

export interface ModelOption {
  /** undefined = use the CLI default (no --model flag) */
  id?: string;
  label: string;
}

/** The models offered in the "add agent" picker and the per-agent selector.
 *  `[1m]` selects the 1M-token context window variant. */
// Deliberately has NO "pass no --model flag" entry. Every option here names a
// real model, because the whole reason to open this picker is to know which
// model an agent is on — and a no-flag option resolves to whatever Claude Code
// happens to choose, which the UI cannot show and the user cannot predict. The
// harness default is marked ` · default` instead, and it names a real model.
export const AGENT_MODELS: ModelOption[] = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-5', label: 'Opus 5 · 1M' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 · 1M' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: ASSISTANT_MODEL, label: 'Sonnet 4.6 · 1M' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
];

/** Models offered when an agent runs on the Antigravity CLI (`agy`). agy's
 *  `--model` takes the DISPLAY-NAME LABEL exactly as `agy models` prints it
 *  (verified: agy logs `Propagating selected model override … label="…"`), not a
 *  slug — so these ids ARE the labels (spaces/parens included; buildSpawnCommand
 *  quotes them and the command tokenizer keeps them whole). The command field
 *  stays editable; `agy models` is the source of truth for the live list. */
export const ANTIGRAVITY_MODELS: ModelOption[] = [
  // No `--model` flag at all — whatever the CLI itself defaults to. NOT the
  // harness's `config.defaultModel`; the pickers mark that one separately, and
  // labelling both "default" is what made the two impossible to tell apart.
  { id: undefined, label: 'CLI default' },
  { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro · High' },
  { id: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro · Low' },
  { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash · High' },
  { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash · Med' },
  { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash · Low' },
  { id: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6' },
  { id: 'Claude Opus 4.6 (Thinking)', label: 'Claude Opus 4.6' },
  { id: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B' }
];

/** Current OpenAI models offered by Codex for coding agents. */
export const CODEX_MODELS: ModelOption[] = [
  // No `--model` flag at all — whatever the CLI itself defaults to. NOT the
  // harness's `config.defaultModel`; the pickers mark that one separately, and
  // labelling both "default" is what made the two impossible to tell apart.
  { id: undefined, label: 'CLI default' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }
];

/** Models reported by the installed Grok CLI (`grok models`). */
export const GROK_MODELS: ModelOption[] = [
  // No `--model` flag at all — whatever the CLI itself defaults to. NOT the
  // harness's `config.defaultModel`; the pickers mark that one separately, and
  // labelling both "default" is what made the two impossible to tell apart.
  { id: undefined, label: 'CLI default' },
  { id: 'grok-4.5', label: 'Grok 4.5' }
];

/** Managed Kimi Code aliases accepted by `kimi --model <alias>`. */
export const KIMI_MODELS: ModelOption[] = [
  // No `--model` flag at all — whatever the CLI itself defaults to. NOT the
  // harness's `config.defaultModel`; the pickers mark that one separately, and
  // labelling both "default" is what made the two impossible to tell apart.
  { id: undefined, label: 'CLI default' },
  { id: 'kimi-code/k3', label: 'Kimi K3' },
  { id: 'kimi-code/kimi-for-coding', label: 'Kimi K2.7 Code' },
  { id: 'kimi-code/kimi-for-coding-highspeed', label: 'Kimi K2.7 · HighSpeed' }
];

/** Split a command string into argv, respecting double/single quotes so a model
 *  value with spaces (agy's `--model "Gemini 3.1 Pro (High)"`) stays one token.
 *  Quotes are stripped from the result. */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The model preset list for a given provider's picker. */
export function modelsForProvider(provider: AgentProvider): ModelOption[] {
  switch (provider) {
    case 'codex': return CODEX_MODELS;
    case 'grok': return GROK_MODELS;
    case 'kimi': return KIMI_MODELS;
    case 'antigravity': return ANTIGRAVITY_MODELS;
    case 'claude': return AGENT_MODELS;
    case 'custom': return [];
  }
}

/** Providers shown in the Command Center's cross-provider model picker.
 *  God must remain on a provider with a working inbox drain; otherwise switching
 *  to a terminal-only provider would silently disable orchestration. */
export function modelProvidersForAgent(isGod = false) {
  return AGENT_PROVIDER_PRESETS.filter((preset) =>
    preset.supportsModel && (!isGod || preset.canReceiveInbox)
  );
}

/** Native <select> values must carry both provider and model because each
 *  provider has its own "default" option and model namespace. */
export function encodeProviderModel(provider: AgentProvider, model?: string): string {
  return `${provider}:${encodeURIComponent(model ?? '')}`;
}

export function decodeProviderModel(value: string): {
  provider: AgentProvider;
  model?: string;
} | null {
  const split = value.indexOf(':');
  if (split < 1) return null;
  const provider = value.slice(0, split);
  if (!AGENT_PROVIDER_PRESETS.some((preset) => preset.id === provider)) return null;
  try {
    const model = decodeURIComponent(value.slice(split + 1));
    return { provider: provider as AgentProvider, model: model || undefined };
  } catch {
    return null;
  }
}

/** Build the command line to feed into spawnPty, honoring the provider's flags,
 *  autoMode, and an optional per-agent model override. Claude keeps the user's
 *  configured `defaultCommand`; other providers use their preset binary so the
 *  app works without Claude installed. */
export function buildSpawnCommand(
  config: Pick<HarnessConfig, 'defaultCommand' | 'autoMode'>,
  model?: string,
  provider: AgentProvider = inferAgentProvider(config.defaultCommand)
): string {
  const preset = providerPreset(provider);
  // Claude keeps the user's configured defaultCommand; custom falls back to it
  // too; every other provider (codex, grok, kimi, agy) uses its preset binary so the app
  // works even without Claude installed.
  const base =
    provider === 'claude'
      ? config.defaultCommand || preset.defaultCommand
      : provider === 'custom'
        ? config.defaultCommand || ''
        : preset.defaultCommand;
  let cmd = base;
  if (preset.supportsModel && model && preset.modelFlag) {
    // Quote model values that contain whitespace (agy labels like
    // "Gemini 3.1 Pro (High)") so the command tokenizer keeps them one arg.
    const m = /\s/.test(model) ? `"${model}"` : model;
    cmd = `${cmd} ${preset.modelFlag} ${m}`;
  }
  // Auto (skip-permissions) mode appends each provider's own flag — Claude's
  // bypassPermissions, Codex's dangerous bypass, Grok's always-approve, Kimi's
  // auto, or agy's skip flag.
  if (config.autoMode && preset.autoFlag) cmd = `${cmd} ${preset.autoFlag}`;
  return cmd;
}
