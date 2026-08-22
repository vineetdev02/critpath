import type { BudgetVerdict } from "../analyze/budget.js";
import type { CostEstimate } from "../analyze/cost.js";
import type { Insight } from "../analyze/insights.js";
import type { RunAnalysis, StepAnalysis } from "../analyze/model.js";
import type { RunStats } from "../analyze/stats.js";
import { c, padEnd, padStart, terminalWidth, truncate } from "./ansi.js";
import { delta, duration, percent, relativeTime, usd } from "./format.js";
import { BAR_LEGEND, renderWaterfall } from "./waterfall.js";

export interface Report {
  owner: string;
  repo: string;
  workflowName: string;
  branch: string;
  runs: RunAnalysis[];
  stats: RunStats;
  /** The run rendered in detail — the most recent completed one. */
  focus: RunAnalysis;
  insights: Insight[];
  cost: CostEstimate;
  monthlyUsd: number | null;
  /** False for public repos, where GitHub-hosted minutes are free. */
  billable: boolean;
  /** Other workflows in this repo, so the reader knows what was left out. */
  otherWorkflows: string[];
  showAllJobs: boolean;
  /** Set only when --budget was given; null leaves the report unchanged. */
  budget: BudgetVerdict | null;
}

export function renderReport(report: Report): string {
  const width = terminalWidth();
  const out: string[] = [];

  out.push("", header(report));
  if (report.otherWorkflows.length > 0) {
    out.push(
      c.dim(
        `  also in this repo: ${report.otherWorkflows.slice(0, 3).join(", ")} — use --workflow to switch`,
      ),
    );
  }
  out.push("");
  out.push(...summary(report), "");
  if (report.budget) out.push(budgetVerdict(report.budget), "");
  out.push(...criticalPath(report.focus), "");
  out.push(...waterfall(report, width), "");
  out.push(...slowestSteps(report.focus), "");
  out.push(...whatToFix(report.insights));
  out.push("");

  return out.join("\n");
}

function header(report: Report): string {
  const title = c.bold(`critpath  ${report.owner}/${report.repo}`);
  const context = c.dim(
    `${report.workflowName}  ·  ${report.branch}  ·  last ${report.stats.count} run${report.stats.count === 1 ? "" : "s"}`,
  );
  return `${title}   ${context}`;
}

function summary(report: Report): string[] {
  const { stats, focus, cost } = report;
  const rows: Array<[string, string, string]> = [];

  rows.push([
    "Wall time",
    `p50 ${duration(stats.wallP50)}`,
    `p90 ${duration(stats.wallP90)}${trendSuffix(stats)}`,
  ]);
  rows.push([
    "Compute",
    `p50 ${duration(stats.jobTimeP50)}`,
    `${focus.parallelism.toFixed(1)}× parallel across ${focus.jobs.length} jobs`,
  ]);
  rows.push([
    "Critical path",
    `p50 ${duration(stats.criticalWorkP50)}`,
    `${percent(stats.wallP50 > 0 ? stats.criticalWorkP50 / stats.wallP50 : 0)} of wall time`,
  ]);
  rows.push([
    "Waiting",
    `p50 ${duration(stats.queueP50)}`,
    "queueing for runners and `needs:` hops",
  ]);

  const runCount = Math.max(1, report.stats.count);
  if (report.billable) {
    rows.push([
      "Est. cost",
      `${usd(cost.usd / runCount)} / run`,
      report.monthlyUsd !== null
        ? `~${usd(report.monthlyUsd)} / month at this rate`
        : "standard runners, per-job minutes rounded up",
    ]);
  } else {
    rows.push([
      "Billable",
      `${Math.round(cost.billableMinutes / runCount)} min / run`,
      "free — public repo on GitHub-hosted runners",
    ]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const valueWidth = Math.max(...rows.map(([, value]) => value.length));

  return rows.map(
    ([label, value, note]) =>
      `  ${padEnd(c.dim(label), labelWidth)}   ${padEnd(c.bold(value), valueWidth)}   ${c.dim(note)}`,
  );
}

/**
 * The gate result, on its own line rather than folded into the summary rows —
 * it is the one thing a CI reader scrolls up to find.
 */
function budgetVerdict(verdict: BudgetVerdict): string {
  const { actualMs, budgetMs } = verdict;
  if (verdict.over) {
    const label = c.red(c.bold("OVER BUDGET"));
    return `  ${label}  p50 wall time ${duration(actualMs)} is ${duration(actualMs - budgetMs)} over ${duration(budgetMs)}`;
  }
  const label = c.green(c.bold("within budget"));
  return `  ${label}  p50 wall time ${duration(actualMs)}, ${duration(budgetMs - actualMs)} to spare`;
}

function trendSuffix(stats: RunStats): string {
  if (stats.trendMs === null || Math.abs(stats.trendMs) < 15_000) return "";
  const worse = stats.trendMs > 0;
  const text = `  ${worse ? "▲" : "▼"} ${delta(stats.trendMs)} vs older runs`;
  return worse ? c.red(text) : c.green(text);
}

function criticalPath(run: RunAnalysis): string[] {
  const out: string[] = [];
  const total = run.criticalWorkMs + run.criticalGapMs;

  out.push(
    c.bold("Critical path") +
      c.dim(
        `  run #${run.run.run_number}  ·  ${duration(run.criticalWorkMs)} running + ` +
          `${duration(run.criticalGapMs)} waiting = ${duration(total)}`,
      ),
  );
  if (run.criticalPathInferred) {
    out.push(c.dim("  (dependencies inferred from timings — workflow file not readable at that commit)"));
  }

  const nameWidth = Math.max(...run.criticalPath.map((entry) => Math.min(entry.job.name.length, 34)), 8);

  run.criticalPath.forEach((entry, index) => {
    const step = c.dim(String(index + 1).padStart(2));
    const name = padEnd(truncate(entry.job.name, nameWidth), nameWidth);
    const dur = padStart(duration(entry.job.durationMs), 9);
    const gap = entry.gapMs >= 5_000 ? c.gray(`  ░ ${duration(entry.gapMs)} waiting`) : "";
    out.push(`  ${step}  ${c.yellow(name)} ${dur}${gap}`);
  });

  return out;
}

function waterfall(report: Report, width: number): string[] {
  const { focus } = report;
  const finished = relativeTime(focus.completedAt);
  const conclusion =
    focus.run.conclusion === "success"
      ? c.green("success")
      : c.red(focus.run.conclusion ?? "unknown");

  return [
    c.bold(`Waterfall`) +
      c.dim(`  run #${focus.run.run_number}  ·  ${duration(focus.wallMs)}  ·  `) +
      conclusion +
      c.dim(`  ·  ${finished}`),
    c.dim(`  ${BAR_LEGEND}`),
    "",
    ...renderWaterfall(focus, { width, maxJobs: report.showAllJobs ? Number.MAX_SAFE_INTEGER : 25 }),
  ];
}

function slowestSteps(run: RunAnalysis): string[] {
  const steps: StepAnalysis[] = run.jobs
    .flatMap((job) => job.steps)
    .filter((step) => !/^(set up job|complete job)$/i.test(step.name.trim()))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);

  if (steps.length === 0) return [];

  const nameWidth = Math.max(...steps.map((step) => Math.min(step.name.length, 34)), 10);
  const out = [c.bold("Slowest steps") + c.dim("  across all jobs in this run")];

  for (const step of steps) {
    const name = padEnd(truncate(step.name, nameWidth), nameWidth);
    const job = c.dim(truncate(step.jobName, 24));
    out.push(`  ${name} ${padStart(duration(step.durationMs), 9)}   ${job}`);
  }

  return out;
}

function whatToFix(insights: Insight[]): string[] {
  if (insights.length === 0) {
    return [c.bold("What to fix"), c.dim("  Nothing obvious — this pipeline is already tight.")];
  }

  const out = [c.bold("What to fix")];
  const dot = { high: c.red("●"), medium: c.yellow("●"), info: c.gray("●") };

  for (const insight of insights) {
    out.push(`  ${dot[insight.severity]} ${c.bold(insight.title)}`);
    out.push(`    ${c.dim(insight.detail)}`);
    if (insight.savingMs && insight.savingMs > 10_000) {
      const unit = insight.savingKind === "wall" ? "off wall time" : "of compute";
      out.push(`    ${c.green(`~${duration(insight.savingMs)} ${unit}`)}`);
    }
  }

  return out;
}
