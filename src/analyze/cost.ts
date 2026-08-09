import type { JobAnalysis, RunAnalysis } from "./model.js";

/**
 * Published per-minute rates for GitHub-hosted standard runners on private
 * repos (public repos are free). Larger runners cost more; `--rate` overrides.
 */
export const DEFAULT_RATES_USD_PER_MINUTE = {
  linux: 0.008,
  windows: 0.016,
  macos: 0.08,
} as const;

export type Platform = keyof typeof DEFAULT_RATES_USD_PER_MINUTE;

export interface CostEstimate {
  /** GitHub bills each job rounded up to the whole minute. */
  billableMinutes: number;
  usd: number;
  byPlatform: Record<Platform, { minutes: number; usd: number }>;
  /** Minutes lost purely to per-job rounding — the cost of splitting jobs too fine. */
  roundingMinutes: number;
}

export function detectPlatform(job: JobAnalysis): Platform {
  const labels = job.labels.map((label) => label.toLowerCase()).join(" ");
  if (labels.includes("windows")) return "windows";
  if (labels.includes("macos") || labels.includes("macgo")) return "macos";
  return "linux";
}

export function estimateCost(
  runs: RunAnalysis[],
  rates: Record<Platform, number> = DEFAULT_RATES_USD_PER_MINUTE,
): CostEstimate {
  const byPlatform: Record<Platform, { minutes: number; usd: number }> = {
    linux: { minutes: 0, usd: 0 },
    windows: { minutes: 0, usd: 0 },
    macos: { minutes: 0, usd: 0 },
  };

  let billableMinutes = 0;
  let actualMinutes = 0;

  for (const run of runs) {
    for (const job of run.jobs) {
      const platform = detectPlatform(job);
      const minutes = Math.max(1, Math.ceil(job.durationMs / 60_000));
      actualMinutes += job.durationMs / 60_000;
      billableMinutes += minutes;
      byPlatform[platform].minutes += minutes;
      byPlatform[platform].usd += minutes * rates[platform];
    }
  }

  return {
    billableMinutes,
    usd: Object.values(byPlatform).reduce((total, entry) => total + entry.usd, 0),
    byPlatform,
    roundingMinutes: billableMinutes - actualMinutes,
  };
}

/** Scale a sample of runs up to a monthly figure. */
export function projectMonthly(estimate: CostEstimate, runCount: number, runsPerMonth: number): number {
  if (runCount === 0) return 0;
  return (estimate.usd / runCount) * runsPerMonth;
}
