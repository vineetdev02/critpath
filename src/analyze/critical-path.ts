import type { CriticalPathEntry, JobAnalysis } from "./model.js";

export interface CriticalPathResult {
  path: CriticalPathEntry[];
  workMs: number;
  gapMs: number;
  /** True when at least one hop was guessed from timing rather than `needs:`. */
  inferred: boolean;
}

/**
 * Walk back from the last job to finish, hop by hop, always taking the
 * upstream job that finished latest — that is the one that was actually
 * holding everything up.
 *
 * Where `needs:` is unknown we fall back to timing: the job that finished
 * closest before this one started is the most likely blocker.
 */
export function findCriticalPath(jobs: JobAnalysis[], runStartedAt: number): CriticalPathResult {
  if (jobs.length === 0) return { path: [], workMs: 0, gapMs: 0, inferred: false };

  const byName = new Map<string, JobAnalysis>();
  for (const job of jobs) {
    const existing = byName.get(job.name);
    if (!existing || job.completedAt > existing.completedAt) byName.set(job.name, job);
  }

  let current = jobs.reduce((latest, job) => (job.completedAt > latest.completedAt ? job : latest));
  const chain: JobAnalysis[] = [current];
  const visited = new Set<number>([current.id]);
  let inferred = false;

  for (;;) {
    const declared = current.depsKnown
      ? current.needs.map((name) => byName.get(name)).filter((job): job is JobAnalysis => job !== undefined)
      : [];

    let predecessor: JobAnalysis | undefined;
    if (current.depsKnown) {
      predecessor = pickLatest(declared.filter((job) => !visited.has(job.id)));
    } else {
      const blockers = jobs.filter(
        (job) => !visited.has(job.id) && job.completedAt <= current.startedAt,
      );
      predecessor = pickLatest(blockers);
      if (predecessor) inferred = true;
    }

    if (!predecessor) break;
    chain.push(predecessor);
    visited.add(predecessor.id);
    current = predecessor;
  }

  chain.reverse();

  const path: CriticalPathEntry[] = chain.map((job, index) => {
    const previous = index === 0 ? null : chain[index - 1];
    const availableAt = previous ? previous.completedAt : runStartedAt;
    return { job, gapMs: Math.max(0, job.startedAt - availableAt) };
  });

  return {
    path,
    workMs: path.reduce((total, entry) => total + entry.job.durationMs, 0),
    gapMs: path.reduce((total, entry) => total + entry.gapMs, 0),
    inferred,
  };
}

function pickLatest(jobs: JobAnalysis[]): JobAnalysis | undefined {
  if (jobs.length === 0) return undefined;
  return jobs.reduce((latest, job) => (job.completedAt > latest.completedAt ? job : latest));
}
