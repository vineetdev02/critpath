import type { RunAnalysis } from "./model.js";

/** Linear-interpolated percentile. `p` is 0-100. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;

  const rank = ((p / 100) * (sorted.length - 1));
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = sorted[lower] as number;
  if (lower === upper) return low;
  const high = sorted[upper] as number;
  return low + (high - low) * (rank - lower);
}

export interface RunStats {
  count: number;
  wallP50: number;
  wallP90: number;
  jobTimeP50: number;
  criticalWorkP50: number;
  queueP50: number;
  /** p50 of the newer half minus p50 of the older half; null when too few runs. */
  trendMs: number | null;
}

export function summarizeRuns(runs: RunAnalysis[]): RunStats {
  const walls = runs.map((run) => run.wallMs);

  return {
    count: runs.length,
    wallP50: percentile(walls, 50),
    wallP90: percentile(walls, 90),
    jobTimeP50: percentile(runs.map((run) => run.jobTimeMs), 50),
    criticalWorkP50: percentile(runs.map((run) => run.criticalWorkMs), 50),
    queueP50: percentile(runs.map((run) => run.criticalGapMs), 50),
    trendMs: computeTrend(runs),
  };
}

/**
 * Runs arrive newest-first. Compare the newer half against the older half so a
 * gradual slowdown shows up before anyone notices it by feel.
 */
function computeTrend(runs: RunAnalysis[]): number | null {
  if (runs.length < 6) return null;
  const half = Math.floor(runs.length / 2);
  const newer = runs.slice(0, half).map((run) => run.wallMs);
  const older = runs.slice(runs.length - half).map((run) => run.wallMs);
  return percentile(newer, 50) - percentile(older, 50);
}

export interface JobStat {
  name: string;
  p50: number;
  p90: number;
  runs: number;
  /** Share of analyzed runs where this job sat on the critical path. */
  criticalRate: number;
}

export function summarizeJobs(runs: RunAnalysis[]): JobStat[] {
  const durations = new Map<string, number[]>();
  const criticalCounts = new Map<string, number>();

  for (const run of runs) {
    for (const job of run.jobs) {
      const bucket = durations.get(job.name);
      if (bucket) bucket.push(job.durationMs);
      else durations.set(job.name, [job.durationMs]);
    }
    for (const entry of run.criticalPath) {
      criticalCounts.set(entry.job.name, (criticalCounts.get(entry.job.name) ?? 0) + 1);
    }
  }

  return [...durations.entries()]
    .map(([name, values]) => ({
      name,
      p50: percentile(values, 50),
      p90: percentile(values, 90),
      runs: values.length,
      criticalRate: runs.length > 0 ? (criticalCounts.get(name) ?? 0) / runs.length : 0,
    }))
    .sort((a, b) => b.p50 - a.p50);
}
