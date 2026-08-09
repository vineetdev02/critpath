import type { RunAnalysis, StepAnalysis } from "./model.js";

export type InsightKind = "duplicate-step" | "queue" | "serialized" | "slow-step" | "off-critical";

export interface Insight {
  kind: InsightKind;
  severity: "high" | "medium" | "info";
  title: string;
  detail: string;
  /** Time this could plausibly return, when that can be estimated. */
  savingMs?: number;
  /** Whether the saving is wall-clock time or billed compute — they are not the same. */
  savingKind?: "wall" | "compute";
}

/** Runner-managed steps that exist in every job and can't be optimised away. */
const RUNNER_STEPS = /^(set up job|complete job|post job cleanup)$/i;

/**
 * Steps whose output is deterministic enough to cache or build once and share.
 * Test and lint steps also repeat across a matrix, but that repetition *is* the
 * work — telling someone to cache it would be bad advice.
 */
const CACHEABLE_STEP =
  /(install|setup|set up|checkout|restore|cache|build|compile|bundle|download|dependenc|toolchain|prepare|bootstrap|node version|pnpm|yarn|poetry|gradle|maven|cargo fetch|go mod)/i;

const ACTUAL_WORK_STEP = /(test|spec|e2e|lint|typecheck|type-check|benchmark|coverage|audit)/i;

export function buildInsights(run: RunAnalysis): Insight[] {
  const insights: Insight[] = [
    ...duplicateStepInsights(run),
    ...queueInsight(run),
    ...serializationInsight(run),
    ...slowStepInsight(run),
    ...offCriticalInsight(run),
  ];

  const rank = { high: 0, medium: 1, info: 2 };
  return insights.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (b.savingMs ?? 0) - (a.savingMs ?? 0),
  );
}

/**
 * The single most common real finding: the same setup work repeated in every
 * job because nobody cached it or shared a build artifact.
 */
function duplicateStepInsights(run: RunAnalysis): Insight[] {
  const groups = new Map<string, StepAnalysis[]>();

  for (const job of run.jobs) {
    for (const step of job.steps) {
      const name = step.name.trim();
      if (RUNNER_STEPS.test(name)) continue;
      if (!CACHEABLE_STEP.test(name) || ACTUAL_WORK_STEP.test(name)) continue;

      const key = name.toLowerCase();
      const bucket = groups.get(key);
      if (bucket) bucket.push(step);
      else groups.set(key, [step]);
    }
  }

  const findings: Insight[] = [];
  for (const steps of groups.values()) {
    const jobCount = new Set(steps.map((step) => step.jobName)).size;
    const total = steps.reduce((sum, step) => sum + step.durationMs, 0);
    if (jobCount < 3 || total < 45_000) continue;

    const slowest = Math.max(...steps.map((step) => step.durationMs));
    findings.push({
      kind: "duplicate-step",
      severity: total > 180_000 ? "high" : "medium",
      title: `"${steps[0]?.name ?? "step"}" repeats in ${jobCount} jobs`,
      detail:
        `${formatShort(total)} of compute across the run. If the output is the same everywhere, ` +
        `do it once and pass it downstream with upload-artifact — or check that actions/cache is hitting.`,
      savingMs: total - slowest,
      savingKind: "compute",
    });
  }

  return findings.sort((a, b) => (b.savingMs ?? 0) - (a.savingMs ?? 0)).slice(0, 3);
}

function queueInsight(run: RunAnalysis): Insight[] {
  if (run.wallMs <= 0) return [];
  const share = run.criticalGapMs / run.wallMs;
  if (share < 0.1 || run.criticalGapMs < 20_000) return [];

  return [
    {
      kind: "queue",
      severity: share > 0.25 ? "high" : "medium",
      title: `${Math.round(share * 100)}% of wall time is waiting, not running`,
      detail:
        `${formatShort(run.criticalGapMs)} on the critical path was spent queueing for a runner ` +
        `or waiting on \`needs:\`. More concurrency or fewer dependency hops fixes this, not faster code.`,
      savingMs: run.criticalGapMs,
      savingKind: "wall",
    },
  ];
}

function serializationInsight(run: RunAnalysis): Insight[] {
  if (run.jobs.length < 3 || run.parallelism >= 1.5) return [];

  return [
    {
      kind: "serialized",
      severity: "high",
      title: `${run.jobs.length} jobs, but only ${run.parallelism.toFixed(1)}× parallelism`,
      detail:
        "The graph is running close to serial. Check whether every `needs:` is a real dependency — " +
        "each unnecessary edge adds its job's full duration to wall time.",
    },
  ];
}

function slowStepInsight(run: RunAnalysis): Insight[] {
  const onPath = new Set(run.criticalPath.map((entry) => entry.job.name));
  const steps = run.jobs
    .filter((job) => onPath.has(job.name))
    .flatMap((job) => job.steps)
    .filter((step) => !RUNNER_STEPS.test(step.name.trim()));

  if (steps.length === 0 || run.criticalWorkMs <= 0) return [];

  const slowest = steps.reduce((max, step) => (step.durationMs > max.durationMs ? step : max));
  const share = slowest.durationMs / run.criticalWorkMs;
  if (share < 0.2) return [];

  return [
    {
      kind: "slow-step",
      severity: share > 0.4 ? "high" : "medium",
      title: `"${slowest.name}" is ${Math.round(share * 100)}% of the critical path`,
      detail: `${formatShort(slowest.durationMs)} in job "${slowest.jobName}". This one step is the single biggest lever on wall time.`,
    },
  ];
}

function offCriticalInsight(run: RunAnalysis): Insight[] {
  const onPath = new Set(run.criticalPath.map((entry) => entry.job.name));
  const slack = run.jobs.filter(
    (job) => !onPath.has(job.name) && run.completedAt - job.completedAt > 60_000,
  );
  if (slack.length === 0) return [];

  const compute = slack.reduce((total, job) => total + job.durationMs, 0);
  return [
    {
      kind: "off-critical",
      severity: "info",
      title: `${slack.length} job${slack.length === 1 ? "" : "s"} finish with time to spare`,
      detail:
        `${formatShort(compute)} of compute that ends well before the run does. ` +
        `Speeding these up costs effort and saves zero wall time — they are already free.`,
    },
  ];
}

function formatShort(millis: number): string {
  const totalSeconds = Math.round(millis / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
