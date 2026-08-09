import { execFileSync } from "node:child_process";

import { getBool, getNumber, getString, UsageError, type ParsedArgs } from "../args.js";
import { analyzeRun } from "../analyze/build.js";
import { estimateCost, projectMonthly } from "../analyze/cost.js";
import { buildInsights } from "../analyze/insights.js";
import type { RunAnalysis } from "../analyze/model.js";
import { summarizeJobs, summarizeRuns } from "../analyze/stats.js";
import { getRepo, getRun, getWorkflowSource, listRunJobs, listWorkflowRuns, parseRepoSlug } from "../github/api.js";
import { GitHubClient } from "../github/client.js";
import { resolveToken, TOKEN_HINT } from "../github/token.js";
import type { WorkflowRun } from "../github/types.js";
import { c, setColorEnabled } from "../render/ansi.js";
import { renderReport, type Report } from "../render/report.js";

export const ANALYZE_FLAGS = {
  branch: "string",
  "all-branches": "boolean",
  workflow: "string",
  runs: "string",
  run: "string",
  event: "string",
  json: "boolean",
  all: "boolean",
  color: "boolean",
  token: "string",
} as const;

export async function analyzeCommand(args: ParsedArgs): Promise<number> {
  if (args.flags.has("color")) setColorEnabled(getBool(args, "color"));
  const asJson = getBool(args, "json");
  if (asJson) setColorEnabled(false);

  const slug = args.positionals[0] ?? detectRepoFromGit();
  if (!slug) {
    throw new UsageError(
      "No repository given, and this directory has no GitHub remote.\n\n  whyslow owner/repo",
    );
  }
  const { owner, repo } = parseRepoSlug(slug);

  // Public repos work unauthenticated at 60 requests/hour, which is enough for
  // one look. Warn rather than block — the API error will say more if we hit it.
  const token = resolveToken(getString(args, "token"));
  if (!token && !asJson) process.stderr.write(`${c.dim(TOKEN_HINT)}\n`);

  const client = new GitHubClient({ token });
  const limit = clampRunCount(getNumber(args, "runs") ?? 20);

  progress("Fetching repository…");
  const repoInfo = await getRepo(client, owner, repo);
  const branch = getBool(args, "all-branches")
    ? undefined
    : (getString(args, "branch") ?? repoInfo.default_branch);

  progress("Fetching workflow runs…");
  const candidates = await collectRunGroups(client, owner, repo, args, branch, limit);
  if (candidates.length === 0) {
    clearProgress();
    process.stderr.write(noRunsMessage(owner, repo, branch, getString(args, "workflow")));
    return 1;
  }

  const analyses = await analyzeFirstUsableGroup(client, owner, repo, candidates);
  clearProgress();

  if (analyses.length === 0) {
    process.stderr.write("Found runs, but none had completed jobs with usable timings.\n");
    return 1;
  }

  const focus = analyses[0] as RunAnalysis;
  const stats = summarizeRuns(analyses);
  const cost = estimateCost(analyses);

  const report: Report = {
    owner,
    repo,
    workflowName: focus.run.name ?? focus.run.path.replace(/^\.github\/workflows\//, ""),
    branch: branch ?? "all branches",
    runs: analyses,
    stats,
    focus,
    insights: buildInsights(focus),
    cost,
    monthlyUsd: repoInfo.private ? monthlyProjection(analyses, cost) : null,
    billable: repoInfo.private,
    otherWorkflows: candidates
      .map((group) => group[0])
      .filter((run): run is WorkflowRun => run !== undefined && run.path !== focus.run.path)
      .map((run) => run.name ?? run.path.replace(/^\.github\/workflows\//, "")),
    showAllJobs: getBool(args, "all"),
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(toJson(report, analyses), null, 2)}\n`);
    return 0;
  }

  process.stdout.write(renderReport(report));
  return 0;
}

/**
 * Candidate workflows, most time-consuming first. Repos run many workflows and
 * mixing them into one set of percentiles would be meaningless, so we analyze
 * one. Ranking by run count picks badly — a lint workflow fires as often as the
 * real pipeline — so we rank by total time consumed, which is what the question
 * "why is CI slow" is actually about. Still a ranked list, because a workflow
 * can look busy and have no usable job timings.
 */
async function collectRunGroups(
  client: GitHubClient,
  owner: string,
  repo: string,
  args: ParsedArgs,
  branch: string | undefined,
  limit: number,
): Promise<WorkflowRun[][]> {
  const explicitRun = getNumber(args, "run");
  if (explicitRun !== undefined) {
    return [[await getRun(client, owner, repo, explicitRun)]];
  }

  const workflow = getString(args, "workflow");
  const serverSideFilter = workflow && /\.ya?ml$/i.test(workflow) ? workflow : undefined;

  const fetched = await listWorkflowRuns(client, owner, repo, {
    branch,
    event: getString(args, "event"),
    workflow: serverSideFilter,
    // Choosing *which* workflow needs a wide sample even when the user only
    // wants a few runs analyzed — and one page holds 100, so a floor is free.
    limit: serverSideFilter ? limit : Math.min(100, Math.max(50, limit * 5)),
  });

  // A skipped run never started a job, so it carries no timing signal at all.
  const usable = fetched.filter((run) => run.status === "completed" && run.conclusion !== "skipped");
  if (serverSideFilter) return usable.length > 0 ? [usable.slice(0, limit)] : [];

  const named = workflow
    ? usable.filter(
        (run) =>
          run.name?.toLowerCase().includes(workflow.toLowerCase()) ||
          run.path.toLowerCase().includes(workflow.toLowerCase()),
      )
    : usable;

  return groupByWorkflow(named).map((group) => group.slice(0, limit));
}

function groupByWorkflow(runs: WorkflowRun[]): WorkflowRun[][] {
  const groups = new Map<string, WorkflowRun[]>();
  for (const run of runs) {
    const bucket = groups.get(run.path);
    if (bucket) bucket.push(run);
    else groups.set(run.path, [run]);
  }
  return [...groups.values()].sort((a, b) => totalDurationMs(b) - totalDurationMs(a));
}

/** Rough wall time straight off the run objects — no job fetch required. */
function totalDurationMs(runs: WorkflowRun[]): number {
  return runs.reduce((total, run) => {
    const started = Date.parse(run.run_started_at ?? run.created_at);
    const ended = Date.parse(run.updated_at);
    return total + (Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0);
  }, 0);
}

/** Walk the candidate workflows in order until one yields real job timings. */
async function analyzeFirstUsableGroup(
  client: GitHubClient,
  owner: string,
  repo: string,
  candidates: WorkflowRun[][],
): Promise<RunAnalysis[]> {
  for (const group of candidates.slice(0, MAX_WORKFLOW_ATTEMPTS)) {
    const head = group[0];
    if (!head) continue;

    progress(`Fetching jobs for ${group.length} run${group.length === 1 ? "" : "s"}…`);
    const jobsPerRun = await Promise.all(group.map((run) => listRunJobs(client, owner, repo, run.id)));

    progress("Reading workflow definition…");
    const source = await getWorkflowSource(client, owner, repo, head.path, head.head_sha);

    const analyses = group
      .map((run, index) => analyzeRun(run, jobsPerRun[index] ?? [], source))
      .filter((analysis) => analysis.jobs.length > 0);

    if (analyses.length > 0) return analyses;
  }

  return [];
}

const MAX_WORKFLOW_ATTEMPTS = 3;

/** Extrapolate the sampled runs to a monthly figure using their real cadence. */
function monthlyProjection(analyses: RunAnalysis[], cost: ReturnType<typeof estimateCost>): number | null {
  if (analyses.length < 3) return null;

  const newest = Math.max(...analyses.map((analysis) => analysis.completedAt));
  const oldest = Math.min(...analyses.map((analysis) => analysis.completedAt));
  const spanDays = (newest - oldest) / 86_400_000;
  if (spanDays < 0.5) return null;

  const runsPerMonth = (analyses.length / spanDays) * 30;
  return projectMonthly(cost, analyses.length, runsPerMonth);
}

function toJson(report: Report, analyses: RunAnalysis[]) {
  return {
    repo: `${report.owner}/${report.repo}`,
    workflow: report.workflowName,
    branch: report.branch,
    runsAnalyzed: analyses.length,
    stats: report.stats,
    cost: { ...report.cost, billable: report.billable, monthlyUsd: report.monthlyUsd },
    jobs: summarizeJobs(analyses),
    insights: report.insights,
    focusRun: {
      id: report.focus.run.id,
      number: report.focus.run.run_number,
      url: report.focus.run.html_url,
      conclusion: report.focus.run.conclusion,
      wallMs: report.focus.wallMs,
      jobTimeMs: report.focus.jobTimeMs,
      parallelism: report.focus.parallelism,
      criticalWorkMs: report.focus.criticalWorkMs,
      criticalGapMs: report.focus.criticalGapMs,
      criticalPathInferred: report.focus.criticalPathInferred,
      criticalPath: report.focus.criticalPath.map((entry) => ({
        job: entry.job.name,
        durationMs: entry.job.durationMs,
        gapMs: entry.gapMs,
      })),
      jobs: report.focus.jobs.map((job) => ({
        name: job.name,
        conclusion: job.conclusion,
        queueMs: job.queueMs,
        durationMs: job.durationMs,
        startOffsetMs: job.startedAt - report.focus.startedAt,
      })),
    },
  };
}

function clampRunCount(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--runs expects a positive integer, got "${value}".`);
  }
  return Math.min(value, 100);
}

function detectRepoFromGit(): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();

    const match = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/i.exec(url);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function noRunsMessage(owner: string, repo: string, branch: string | undefined, workflow?: string): string {
  const filters = [branch ? `branch "${branch}"` : null, workflow ? `workflow "${workflow}"` : null]
    .filter(Boolean)
    .join(" and ");

  return (
    `No completed workflow runs found for ${owner}/${repo}${filters ? ` on ${filters}` : ""}.\n\n` +
    `Try --all-branches, or --branch <name> if your default branch is not where CI runs.\n`
  );
}

function progress(message: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\r\u001b[2K\u001b[2m${message}\u001b[0m`);
}

function clearProgress(): void {
  if (process.stderr.isTTY) process.stderr.write("\r\u001b[2K");
}
