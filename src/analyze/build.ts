import type { WorkflowJob, WorkflowRun } from "../github/types.js";
import { findCriticalPath } from "./critical-path.js";
import { buildJobGraph, parseWorkflowJobs } from "./dag.js";
import { ms, type JobAnalysis, type RunAnalysis, type StepAnalysis } from "./model.js";

/**
 * Turn one run's raw API payload into the timing model everything else reads.
 * `workflowSource` is optional — without it we still produce a critical path,
 * just inferred from timings instead of `needs:`.
 */
export function analyzeRun(
  run: WorkflowRun,
  rawJobs: WorkflowJob[],
  workflowSource: string | null,
): RunAnalysis {
  const timed = rawJobs.filter(
    (job) =>
      job.conclusion !== "skipped" &&
      Number.isFinite(ms(job.started_at)) &&
      Number.isFinite(ms(job.completed_at)),
  );

  const specs = workflowSource ? parseWorkflowJobs(workflowSource) : [];
  const graph = buildJobGraph(
    timed.map((job) => job.name),
    specs,
  );

  const jobs: JobAnalysis[] = timed
    .map((job) => {
      const queuedAt = Number.isFinite(ms(job.created_at)) ? ms(job.created_at) : ms(job.started_at);
      const startedAt = ms(job.started_at);
      const completedAt = ms(job.completed_at);

      return {
        id: job.id,
        name: job.name,
        conclusion: job.conclusion,
        queuedAt: Math.min(queuedAt, startedAt),
        startedAt,
        completedAt,
        queueMs: Math.max(0, startedAt - queuedAt),
        durationMs: Math.max(0, completedAt - startedAt),
        steps: analyzeSteps(job),
        labels: job.labels ?? [],
        needs: graph.edges.get(job.name) ?? [],
        depsKnown: specs.length > 0 && !graph.unmatched.has(job.name),
        htmlUrl: job.html_url,
      } satisfies JobAnalysis;
    })
    .sort((a, b) => a.queuedAt - b.queuedAt || a.startedAt - b.startedAt);

  const apiStart = ms(run.run_started_at ?? run.created_at);
  const startedAt = jobs.length
    ? Math.min(apiStart || Number.POSITIVE_INFINITY, ...jobs.map((job) => job.queuedAt))
    : apiStart;
  const completedAt = jobs.length ? Math.max(...jobs.map((job) => job.completedAt)) : ms(run.updated_at);

  const critical = findCriticalPath(jobs, startedAt);
  const jobTimeMs = jobs.reduce((total, job) => total + job.durationMs, 0);
  const wallMs = Math.max(0, completedAt - startedAt);

  return {
    run,
    startedAt,
    completedAt,
    wallMs,
    jobs,
    jobTimeMs,
    totalQueueMs: jobs.reduce((total, job) => total + job.queueMs, 0),
    parallelism: wallMs > 0 ? jobTimeMs / wallMs : 0,
    criticalPath: critical.path,
    criticalWorkMs: critical.workMs,
    criticalGapMs: critical.gapMs,
    criticalPathInferred: critical.inferred,
  };
}

function analyzeSteps(job: WorkflowJob): StepAnalysis[] {
  return (job.steps ?? [])
    .filter((step) => Number.isFinite(ms(step.started_at)) && Number.isFinite(ms(step.completed_at)))
    .map((step) => {
      const startedAt = ms(step.started_at);
      const completedAt = ms(step.completed_at);
      return {
        name: step.name,
        jobName: job.name,
        conclusion: step.conclusion,
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
      } satisfies StepAnalysis;
    });
}
