export interface CommonFollowObservation { occurredAt: Date; count: number; dedupeKey: string; }
export interface SurgePolicyOptions { windowMs?: number; increaseThreshold?: number; durationMs?: number; }
export interface SurgeDecision { triggered: boolean; baselineCount: number; peakCount: number; triggeredAt?: Date; expiresAt?: Date; }

export function evaluateSurge(observations: readonly CommonFollowObservation[], now: Date, options: SurgePolicyOptions = {}): SurgeDecision {
  const cutoff = now.getTime() - (options.windowMs ?? 30 * 60 * 1000);
  const window = observations.filter((item) => item.occurredAt.getTime() >= cutoff && item.occurredAt.getTime() <= now.getTime()).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (window.length < 2) { const count = window[0]?.count ?? 0; return { triggered: false, baselineCount: count, peakCount: count }; }
  const baselineCount = window[0].count;
  const peakCount = Math.max(...window.map((item) => item.count));
  if (peakCount - baselineCount < (options.increaseThreshold ?? 10)) return { triggered: false, baselineCount, peakCount };
  return { triggered: true, baselineCount, peakCount, triggeredAt: now, expiresAt: new Date(now.getTime() + (options.durationMs ?? 6 * 60 * 60 * 1000)) };
}
