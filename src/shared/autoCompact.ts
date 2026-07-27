/** Smaller (~250k) windows compact later to avoid excessive churn; large
 * (~1M) windows compact earlier because a 20% checkpoint is already substantial. */
export const SMALL_CONTEXT_THRESHOLD = 0.3;
export const LARGE_CONTEXT_THRESHOLD = 0.2;
export const LARGE_CONTEXT_MIN_TOKENS = 500_000;

export function autoCompactThresholdForLimit(limit: number): number {
  return limit >= LARGE_CONTEXT_MIN_TOKENS
    ? LARGE_CONTEXT_THRESHOLD
    : SMALL_CONTEXT_THRESHOLD;
}

/** Unknown or invalid telemetry must never trigger a blind compaction. */
export function shouldAutoCompactContext(used: number, limit: number): boolean {
  return Number.isFinite(used)
    && Number.isFinite(limit)
    && used >= 0
    && limit > 0
    && used / limit >= autoCompactThresholdForLimit(limit);
}

/** Enable auto-compaction on the persisted built-in hourly mission only. */
export function enableOpsStandupAutoCompact<
  T extends { id: string; autoCompact?: boolean }
>(missions: T[]): T[] {
  return missions.map((mission) =>
    mission.id === 'ops-standup' && mission.autoCompact !== true
      ? { ...mission, autoCompact: true }
      : mission
  );
}
