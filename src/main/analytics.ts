/**
 * Product analytics (PostHog) — anonymous, allowlisted, opt-out.
 *
 * This is the OUTBOUND product-usage counterpart to telemetry.ts (which is the
 * loopback-only OTel collector and never leaves the machine). Everything here
 * is governed by TELEMETRY.md — the public contract. Keep the two in lockstep:
 * an event or property that isn't in TELEMETRY.md must not be added here, and
 * vice versa.
 *
 * 🔒 Anonymity is BY CONSTRUCTION, same philosophy as telemetry.ts:
 *   - Every event carries `$process_person_profile: false` → PostHog stores it
 *     as an anonymous event and never creates a person profile.
 *   - The distinct id is a RANDOM UUID minted at first run and stored in
 *     userData (`telemetry-install-id`) — not a machine id, not derivable from
 *     anything, gone when the app's data dir is deleted.
 *   - `track()` enforces a per-event property ALLOWLIST (EVENTS below), so a
 *     future call site cannot leak a new property by accident: unknown events
 *     and unknown keys are dropped, never sent.
 *   - No prompts, transcripts, file paths, repo names, hostnames, or agent
 *     output — nothing free-form crosses this seam.
 *
 * Sending is gated on ALL of (checked in this order):
 *   1. A build-time key (__POSTHOG_KEY__, injected from the POSTHOG_KEY env in
 *      release CI). Dev builds and forks compile with '' → this whole module is
 *      a silent no-op for them.
 *   2. The DO_NOT_TRACK env convention (any value except '' / '0') — respected
 *      unconditionally, checked at every send so it can't be raced.
 *   3. The user's `telemetryEnabled` config (Settings → Privacy; default ON,
 *      i.e. opt-out — flipped live via setEnabled()).
 *
 * Deliberately free of any `electron` import (paths/version are injected via
 * init) so it can be smoke-tested as a plain Node module, like telemetry.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostHog } from 'posthog-node';

// Injected by electron-vite `define` (electron.vite.config.ts) from the
// POSTHOG_KEY / POSTHOG_HOST env at BUILD time. Empty in dev/fork builds.
declare const __POSTHOG_KEY__: string;
declare const __POSTHOG_HOST__: string;

/** The complete event → allowed-property-keys contract. Mirrors TELEMETRY.md
 *  exactly; `track()` refuses anything outside it. Common props (`app_version`,
 *  `os`, `arch`) are stamped centrally and are not listed per event. */
const EVENTS: Record<string, ReadonlySet<string>> = {
  /** Once per install, when the install id is first minted. */
  first_run: new Set<string>(),
  /** Every app start. The DAU/retention backbone. */
  app_launched: new Set<string>(),
  /** Once per version change, on the first run after the version moved. Both
   *  values are version strings of the same shape as the `app_version` every
   *  event already carries; `from_version` is `unknown` for an install that
   *  predates version stamping (i.e. anything upgrading INTO the first release
   *  that ships this event). */
  update_applied: new Set<string>(['from_version', 'to_version']),
  /** An agent PTY spawned. `provider` is the CLI engine name only. */
  agent_spawned: new Set<string>(['provider']),
  /** Coarse feature adoption; `feature` is a fixed enum (see FEATURES), fired
   *  at most once per feature per app session. */
  feature_used: new Set<string>(['feature']),
  /** Fired on quit. `duration_bucket` is a coarse label, never raw ms. */
  session_ended: new Set<string>(['duration_bucket'])
};

/** The only values `feature_used.feature` may take. */
export type AnalyticsFeature =
  | 'slack_trigger'
  | 'webhook_trigger'
  | 'hire_install'
  | 'voice_dictation';

export interface AnalyticsInitOptions {
  /** Directory for the install-id file (userData). Created if missing. */
  stateDir: string;
  /** App version stamped on every event. */
  appVersion: string;
  /** The user's `telemetryEnabled` config at boot (default true = opt-out). */
  enabled: boolean;
}

function dntSet(): boolean {
  const v = process.env.DO_NOT_TRACK;
  return v !== undefined && v !== '' && v !== '0';
}

/** Exported for the unit test only — index.ts uses the `analytics` singleton
 *  below. Constructing a fresh one is the only way to exercise the once-per-
 *  install paths (first_run, update_applied) more than once in a process. */
export class Analytics {
  private client: PostHog | null = null;
  private distinctId = '';
  private enabled = false;
  private firstRun = false;
  /** False when the state dir was unwritable and loadOrMintInstallId fell back
   *  to an ephemeral id. Such an install cannot be recognised across boots, so
   *  it must never report a version transition — it would report one on EVERY
   *  boot and inflate the exact number update_applied exists to produce. */
  private idPersisted = false;
  private startedAt = 0;
  private sessionEnded = false;
  /** Session-scoped dedup for feature_used. */
  private readonly featuresSeen = new Set<string>();
  private common: Record<string, string> = {};

  /** Boot the client (no-op without a build-time key / with DNT set). Returns
   *  whether this boot minted a fresh install id (first run ever). */
  init(opts: AnalyticsInitOptions): void {
    this.enabled = opts.enabled;
    this.startedAt = Date.now();
    this.common = {
      app_version: opts.appVersion,
      os: process.platform,
      arch: process.arch
    };
    if (!__POSTHOG_KEY__ || dntSet()) return; // stay dark: no client, no id file
    try {
      this.distinctId = this.loadOrMintInstallId(opts.stateDir);
      this.client = new PostHog(__POSTHOG_KEY__, {
        host: __POSTHOG_HOST__ || 'https://us.i.posthog.com',
        // Events are rare (a handful per session) — send immediately so quit
        // loses at most the final session_ended, never a whole batch.
        flushAt: 1,
        flushInterval: 10_000,
        // posthog-node defaults GeoIP OFF (server lib); we re-enable it for
        // country-level numbers only — PostHog discards the IP after the
        // lookup and the event is anonymous either way (TELEMETRY.md).
        disableGeoip: false
      });
    } catch (e) {
      console.error('[analytics] init failed (telemetry disabled):', e);
      this.client = null;
      return;
    }
    // Version-change detection. Read BEFORE the stamp is refreshed, and stamp
    // BEFORE sending: at-most-once beats at-least-once here, because a
    // duplicated update_applied would corrupt the very count it exists to
    // produce, while a lost one costs a single install out of thousands. The
    // stamp is refreshed for opted-out users too — we record locally and let
    // track() decide whether anything leaves the machine, so opting back in
    // never back-fills a transition that happened while we were dark.
    let transition: VersionTransition | null = null;
    if (this.idPersisted) {
      const previous = readVersionStamp(opts.stateDir);
      transition = updateTransition(previous, opts.appVersion, this.firstRun);
      if (previous !== opts.appVersion) writeVersionStamp(opts.stateDir, opts.appVersion);
    }

    if (this.firstRun) this.track('first_run');
    if (transition) this.track('update_applied', transition);
    this.track('app_launched');
  }

  /** Live opt-in/out from Settings. Turning off stops sends instantly; nothing
   *  needs recreating to turn back on. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Capture one allowlisted event. Silently drops anything not in EVENTS. */
  track(event: string, props: Record<string, string> = {}): void {
    if (!this.client || !this.enabled || dntSet() || this.sessionEnded) return;
    const allowed = EVENTS[event];
    if (!allowed) return;
    const properties: Record<string, unknown> = {
      ...this.common,
      $process_person_profile: false // anonymous event — no person profile
    };
    for (const [k, v] of Object.entries(props)) {
      if (allowed.has(k) && typeof v === 'string') properties[k] = v;
    }
    try {
      this.client.capture({ distinctId: this.distinctId, event, properties });
    } catch (e) {
      console.error('[analytics] capture failed:', e);
    }
  }

  /** feature_used with per-session dedup (adoption signal, not a usage meter). */
  trackFeature(feature: AnalyticsFeature): void {
    if (this.featuresSeen.has(feature)) return;
    this.featuresSeen.add(feature);
    this.track('feature_used', { feature });
  }

  /** Fire session_ended and flush. Bounded by the caller (will-quit races this
   *  against a timeout) — never assume it completes. Idempotent. */
  async endSession(): Promise<void> {
    if (!this.client || this.sessionEnded) return;
    this.track('session_ended', { duration_bucket: durationBucket(Date.now() - this.startedAt) });
    this.sessionEnded = true;
    try {
      await this.client.shutdown();
    } catch (e) {
      console.error('[analytics] shutdown flush failed:', e);
    }
    this.client = null;
  }

  private loadOrMintInstallId(stateDir: string): string {
    const file = join(stateDir, 'telemetry-install-id');
    try {
      if (existsSync(file)) {
        const id = readFileSync(file, 'utf8').trim();
        if (id) {
          this.idPersisted = true;
          return id;
        }
      }
      const id = randomUUID();
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(file, id + '\n', 'utf8');
      this.firstRun = true;
      this.idPersisted = true;
      return id;
    } catch (e) {
      // Unwritable state dir: use an ephemeral id for this session rather than
      // failing closed on analytics (still anonymous, just not stable).
      console.error('[analytics] install-id persist failed (ephemeral id):', e);
      return randomUUID();
    }
  }
}

/** The version this install last ran, kept beside the install id in userData.
 *  Deleting the app's data dir clears it exactly like the install id. */
const VERSION_STAMP_FILE = 'telemetry-last-version';

/** Semver-shaped and nothing else. The stamp is an ordinary file in userData
 *  that a user can edit, so it is re-validated on the way out — that keeps
 *  `from_version` provably closed-form and honours TELEMETRY.md's "nothing
 *  free-form" promise even against a hand-edited state dir. */
const VERSION_RE = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;

/** A type alias, NOT an interface: `track()` takes `Record<string, string>` and
 *  TypeScript only gives object *type aliases* an implicit index signature. */
export type VersionTransition = {
  from_version: string;
  to_version: string;
};

/** The single place that decides whether a boot is a version change.
 *
 *  - `firstRun` (the install id was just minted) → a brand-new install, never
 *    an update. This is what keeps update_applied and first_run disjoint.
 *  - no stamp on an install that already had an id → the install predates
 *    version stamping, so it arrived here from SOME earlier version:
 *    `from_version: 'unknown'`. This is what makes the very first release
 *    carrying the event measurable, instead of silent for one whole cycle.
 *  - stamp !== current → a version change (a downgrade reports honestly, with
 *    from > to).
 *  - stamp === current → an ordinary relaunch. Nothing.
 *
 *  Pure and exported so the decision can be unit-tested without PostHog. */
export function updateTransition(
  previous: string | null,
  current: string,
  firstRun: boolean
): VersionTransition | null {
  if (firstRun) return null;
  if (!VERSION_RE.test(current)) return null; // can't name where we landed
  if (previous === current) return null;
  return {
    from_version: previous && VERSION_RE.test(previous) ? previous : 'unknown',
    to_version: current
  };
}

/** Raw stamp, or null when absent/unreadable. Never throws. */
export function readVersionStamp(stateDir: string): string | null {
  try {
    const file = join(stateDir, VERSION_STAMP_FILE);
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Best-effort. A failed stamp just means the transition may be reported again
 *  next boot; it must never take the app down. */
export function writeVersionStamp(stateDir: string, version: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, VERSION_STAMP_FILE), version + '\n', 'utf8');
  } catch (e) {
    console.error('[analytics] version stamp persist failed:', e);
  }
}

/** Coarse, non-identifying session-length label. */
function durationBucket(ms: number): string {
  const m = ms / 60_000;
  if (m < 5) return '<5m';
  if (m < 30) return '5-30m';
  if (m < 120) return '30m-2h';
  if (m < 480) return '2-8h';
  return '8h+';
}

/** The process-wide singleton, mirroring how index.ts owns other services. */
export const analytics = new Analytics();
