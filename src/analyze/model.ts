import type { WorkflowRun } from "../github/types.js";

export interface StepAnalysis {
  name: string;
  jobName: string;
  conclusion: string | null;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface JobAnalysis {
  id: number;
  name: string;
  conclusion: string | null;
  /** Entered the queue. */
  queuedAt: number;
  /** A runner picked it up. */
  startedAt: number;
  completedAt: number;
  queueMs: number;
  durationMs: number;
  steps: StepAnalysis[];
  labels: string[];
  /** Upstream job names, resolved from the workflow's `needs:` declarations. */
  needs: string[];
  /** False when we could not map this job back to the workflow file. */
  depsKnown: boolean;
  htmlUrl: string | null;
}

export interface CriticalPathEntry {
  job: JobAnalysis;
  /** Idle time between the upstream job finishing and this job starting. */
  gapMs: number;
}

export interface RunAnalysis {
  run: WorkflowRun;
  startedAt: number;
  completedAt: number;
  wallMs: number;
  jobs: JobAnalysis[];
  /** Sum of every job's execution time — what you are billed for. */
  jobTimeMs: number;
  totalQueueMs: number;
  /** jobTimeMs / wallMs: how much real parallelism the run achieved. */
  parallelism: number;
  criticalPath: CriticalPathEntry[];
  /** Time actually spent running on the critical path. */
  criticalWorkMs: number;
  /** Time spent idle (queueing, scheduling) on the critical path. */
  criticalGapMs: number;
  /** True when the critical path came from timing inference, not `needs:`. */
  criticalPathInferred: boolean;
}

export function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}
