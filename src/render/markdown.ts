import type { BudgetVerdict } from "../analyze/budget.js";
import type { Insight } from "../analyze/insights.js";
import type { RunAnalysis, StepAnalysis } from "../analyze/model.js";
import { summarizeJobs } from "../analyze/stats.js";
import { delta, duration, percent, usd } from "./format.js";
import type { Report } from "./report.js";

/**
 * Marker so a workflow can find and update its previous comment instead of
 * posting a new one on every push.
 */
export const COMMENT_MARKER = "<!-- critpath -->";

const SEVERITY_MARK: Record<Insight["severity"], string> = {
  high: "🔴",
  medium: "🟡",
  info: "⚪",
};

/**
 * Render the report as GitHub-flavoured markdown, sized for a pull request
 * comment or a step summary.
 *
 * The waterfall is deliberately left behind: it is an ANSI bar chart that
 * depends on a known terminal width, and a table of the jobs that actually
 * decided wall time says the same thing in a comment without pretending to be
 * a picture.
 */
export function renderMarkdown(report: Report): string {
  const blocks: string[] = [COMMENT_MARKER, `### critpath — \`${report.owner}/${report.repo}\``];

  if (report.budget) blocks.push(budgetVerdict(report.budget));
  blocks.push(headline(report));
  blocks.push(criticalPath(report.focus));

  const insights = whatToFix(report.insights);
  if (insights) blocks.push(insights);

  const steps = slowestSteps(report.focus);
  if (steps) blocks.push(steps);

  const jobs = jobTable(report);
  if (jobs) blocks.push(jobs);

  blocks.push(footer(report));

  return `${blocks.join("\n\n")}\n`;
}

/** The one line a CI reader scrolls up to find, so it goes first. */
function budgetVerdict(verdict: BudgetVerdict): string {
  const { actualMs, budgetMs } = verdict;

  if (verdict.over) {
    return `🔴 **Over budget** — p50 wall time \`${duration(actualMs)}\` is ${duration(actualMs - budgetMs)} over the ${duration(budgetMs)} budget.`;
  }
  return `✅ **Within budget** — p50 wall time \`${duration(actualMs)}\`, ${duration(budgetMs - actualMs)} to spare.`;
}

function headline(report: Report): string {
  const { stats, focus, cost } = report;

  const trend =
    stats.trendMs !== null && Math.abs(stats.trendMs) >= 15_000
      ? ` · ${stats.trendMs > 0 ? "▲" : "▼"} ${delta(stats.trendMs)} vs older runs`
      : "";

  const runCount = Math.max(1, stats.count);
  const money = report.billable
    ? `${usd(cost.usd / runCount)} per run${report.monthlyUsd !== null ? ` (~${usd(report.monthlyUsd)}/month at this rate)` : ""}`
    : `${Math.round(cost.billableMinutes / runCount)} billable min per run — free on a public repo`;

  const facts = [
    `**${duration(stats.wallP50)}** p50 wall time · p90 ${duration(stats.wallP90)}${trend}`,
    `${duration(stats.criticalWorkP50)} of that is the critical path (${percent(stats.wallP50 > 0 ? stats.criticalWorkP50 / stats.wallP50 : 0)}), ${duration(stats.queueP50)} is waiting`,
    `${focus.parallelism.toFixed(1)}× parallel across ${focus.jobs.length} jobs · ${money}`,
  ];

  const context = `\`${escapeText(report.workflowName)}\` · \`${escapeText(report.branch)}\` · last ${stats.count} run${stats.count === 1 ? "" : "s"}`;

  return `${facts.join("\n\n")}\n\n<sub>${context}</sub>`;
}

/** The product: the chain of jobs that decided wall time. */
function criticalPath(run: RunAnalysis): string {
  const total = run.criticalWorkMs + run.criticalGapMs;
  const heading =
    `#### Critical path\n\n` +
    `Run [#${run.run.run_number}](${run.run.html_url}) — ${duration(run.criticalWorkMs)} running + ${duration(run.criticalGapMs)} waiting = **${duration(total)}**`;

  if (run.criticalPath.length === 0) return heading;

  const rows = run.criticalPath.map((entry, index) => {
    const name = entry.job.htmlUrl
      ? `[${escapeText(entry.job.name)}](${entry.job.htmlUrl})`
      : escapeText(entry.job.name);
    const waiting = entry.gapMs >= 5_000 ? duration(entry.gapMs) : "";
    return `| ${index + 1} | ${name} | ${duration(entry.job.durationMs)} | ${waiting} |`;
  });

  const note = run.criticalPathInferred
    ? "\n\n<sub>Dependencies inferred from timings — the workflow file was not readable at that commit.</sub>"
    : "";

  return [
    heading,
    "",
    "| | Job | Ran for | Waited |",
    "| --: | --- | --: | --: |",
    ...rows,
  ].join("\n") + note;
}

function whatToFix(insights: Insight[]): string | undefined {
  if (insights.length === 0) return undefined;

  const rows = insights.map((insight) => {
    const saving =
      insight.savingMs && insight.savingMs > 10_000
        ? `~${duration(insight.savingMs)} ${insight.savingKind === "wall" ? "off wall time" : "of compute"}`
        : "";
    return `| ${SEVERITY_MARK[insight.severity]} | **${escapeText(insight.title)}**<br><sub>${escapeText(insight.detail)}</sub> | ${saving} |`;
  });

  return ["#### What to fix", "", "| | Finding | Worth |", "| :-: | --- | --- |", ...rows].join("\n");
}

function slowestSteps(run: RunAnalysis): string | undefined {
  const steps: StepAnalysis[] = run.jobs
    .flatMap((job) => job.steps)
    .filter((step) => !/^(set up job|complete job)$/i.test(step.name.trim()))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);

  if (steps.length === 0) return undefined;

  const rows = steps.map(
    (step) =>
      `| ${escapeText(step.name)} | ${duration(step.durationMs)} | ${escapeText(step.jobName)} |`,
  );

  return details(
    "Slowest steps",
    ["| Step | Duration | Job |", "| --- | --: | --- |", ...rows].join("\n"),
  );
}

/**
 * Every job by median duration, with how often each one landed on the critical
 * path — the number that says whether speeding a job up would change anything.
 */
function jobTable(report: Report): string | undefined {
  const stats = summarizeJobs(report.runs);
  if (stats.length === 0) return undefined;

  const shown = report.showAllJobs ? stats : stats.slice(0, 20);
  const rows = shown.map(
    (job) =>
      `| ${escapeText(job.name)} | ${duration(job.p50)} | ${duration(job.p90)} | ${percent(job.criticalRate)} |`,
  );

  if (stats.length > shown.length) {
    rows.push(`| …and ${stats.length - shown.length} more | | | |`);
  }

  return details(
    `All ${stats.length} job${stats.length === 1 ? "" : "s"}`,
    ["| Job | p50 | p90 | On critical path |", "| --- | --: | --: | --: |", ...rows].join("\n"),
  );
}

function footer(report: Report): string {
  const others =
    report.otherWorkflows.length > 0
      ? ` Other workflows in this repo: ${report.otherWorkflows.slice(0, 3).map((name) => `\`${escapeText(name)}\``).join(", ")}.`
      : "";

  return `<sub>Generated by [critpath](https://github.com/vineetdev02/critpath).${others}</sub>`;
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${escapeText(summary)}</summary>\n\n${body}\n\n</details>`;
}

/** Keep table cells and inline code from breaking the surrounding markdown. */
function escapeText(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/\r?\n/g, " ");
}
