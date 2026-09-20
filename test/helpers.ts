import { analyzeRun } from "../src/analyze/build.js";
import {
  evaluateJobBudgets,
  type JobBudgetVerdict,
  parseJobBudgets,
} from "../src/analyze/budget.js";
import { estimateCost } from "../src/analyze/cost.js";
import { buildInsights } from "../src/analyze/insights.js";
import { summarizeJobs, summarizeRuns } from "../src/analyze/stats.js";
import type { WorkflowJob, WorkflowRun, WorkflowStep } from "../src/github/types.js";
import type { Report } from "../src/render/report.js";

export const BASE = Date.parse("2026-01-01T00:00:00Z");

/** Seconds after the fixture epoch, as an ISO timestamp. */
export function at(seconds: number): string {
  return new Date(BASE + seconds * 1000).toISOString();
}

export interface JobSpec {
  name: string;
  /** Seconds after the epoch. */
  queued?: number;
  started: number;
  completed: number;
  steps?: Array<{ name: string; started: number; completed: number }>;
  labels?: string[];
  conclusion?: string;
}

let nextId = 1;

export function makeJob(spec: JobSpec): WorkflowJob {
  const steps: WorkflowStep[] = (spec.steps ?? []).map((step, index) => ({
    name: step.name,
    status: "completed",
    conclusion: "success",
    number: index + 1,
    started_at: at(step.started),
    completed_at: at(step.completed),
  }));

  return {
    id: nextId++,
    run_id: 1,
    name: spec.name,
    status: "completed",
    conclusion: spec.conclusion ?? "success",
    created_at: at(spec.queued ?? spec.started),
    started_at: at(spec.started),
    completed_at: at(spec.completed),
    steps,
    labels: spec.labels ?? ["ubuntu-latest"],
    runner_name: "runner-1",
    html_url: null,
  };
}

export function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    name: "CI",
    workflow_id: 10,
    path: ".github/workflows/ci.yml",
    head_branch: "main",
    head_sha: "abc123",
    event: "push",
    status: "completed",
    conclusion: "success",
    run_number: 42,
    run_attempt: 1,
    created_at: at(0),
    run_started_at: at(0),
    updated_at: at(600),
    html_url: "https://github.com/o/r/actions/runs/1",
    ...overrides,
  };
}

const WORKFLOW = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs: build
    runs-on: ubuntu-latest
`;

/**
 * One analysed run, wrapped in the object the renderers take: build for 3m 30s,
 * then test for 5m 50s behind it. Shared by the renderer suites so a claim
 * about the terminal report and one about the markdown are claims about the
 * same run.
 */
export function makeReport(overrides: Partial<Report> = {}): Report {
  const run = makeRun();
  const jobs = [
    makeJob({
      name: "build",
      queued: 0,
      started: 30,
      completed: 240,
      steps: [{ name: "Install dependencies", started: 40, completed: 200 }],
    }),
    makeJob({ name: "test", started: 250, completed: 600 }),
  ];

  const analysis = analyzeRun(run, jobs, WORKFLOW);
  const runs = [analysis];

  return {
    owner: "acme",
    repo: "api",
    workflowName: "CI",
    branch: "main",
    runs,
    stats: summarizeRuns(runs),
    focus: analysis,
    insights: buildInsights(analysis),
    cost: estimateCost(runs),
    monthlyUsd: null,
    billable: false,
    otherWorkflows: [],
    showAllJobs: false,
    budget: null,
    jobBudgets: [],
    ...overrides,
  };
}

/** The verdicts `--job-budget <text>` would produce for that run. */
export function makeJobBudgets(report: Report, text: string): JobBudgetVerdict[] {
  return evaluateJobBudgets(parseJobBudgets(text), summarizeJobs(report.runs));
}
