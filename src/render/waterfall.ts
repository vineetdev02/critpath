import type { JobAnalysis, RunAnalysis } from "../analyze/model.js";
import { c, padEnd, padStart, truncate } from "./ansi.js";
import { duration } from "./format.js";

const QUEUE_CHAR = "░";
const RUN_CHAR = "█";

export interface WaterfallOptions {
  width: number;
  /** Cap the number of rows; the rest collapse into a summary line. */
  maxJobs?: number;
}

export function renderWaterfall(run: RunAnalysis, options: WaterfallOptions): string[] {
  if (run.jobs.length === 0) return [c.dim("  (no completed jobs in this run)")];

  const maxJobs = options.maxJobs ?? 40;
  const shown = run.jobs.length <= maxJobs
    ? run.jobs
    : [...run.jobs].sort((a, b) => b.durationMs - a.durationMs).slice(0, maxJobs)
        .sort((a, b) => a.queuedAt - b.queuedAt);
  const hidden = run.jobs.length - shown.length;

  const longestName = Math.max(...shown.map((job) => job.name.length));
  const labelWidth = Math.max(8, Math.min(longestName, 30, Math.floor(options.width * 0.3)));
  const metaWidth = 9;
  const barWidth = Math.max(10, options.width - 2 - labelWidth - 1 - 2 - metaWidth);

  const onCriticalPath = new Set(run.criticalPath.map((entry) => entry.job.id));
  const scale = (timestamp: number): number => {
    if (run.wallMs <= 0) return 0;
    const ratio = (timestamp - run.startedAt) / run.wallMs;
    return Math.max(0, Math.min(barWidth, Math.round(ratio * barWidth)));
  };

  const lines = shown.map((job) => {
    const critical = onCriticalPath.has(job.id);
    const marker = critical ? c.yellow("▸ ") : "  ";
    const label = padEnd(truncate(job.name, labelWidth), labelWidth);
    const bar = renderBar(job, scale, barWidth, critical);
    const meta = padStart(duration(job.durationMs), metaWidth);

    return `${marker}${critical ? c.bold(label) : label} ${bar}  ${c.dim(meta)}`;
  });

  if (hidden > 0) {
    lines.push(c.dim(`  … ${hidden} shorter job${hidden === 1 ? "" : "s"} hidden (--all to show)`));
  }

  lines.push(renderAxis(run, labelWidth, barWidth));
  return lines;
}

function renderBar(
  job: JobAnalysis,
  scale: (timestamp: number) => number,
  barWidth: number,
  critical: boolean,
): string {
  const queueStart = scale(job.queuedAt);
  const runStart = scale(job.startedAt);
  const end = scale(job.completedAt);

  const queueChars = Math.max(0, runStart - queueStart);
  const runChars = Math.max(1, Math.min(end - runStart, barWidth - runStart));
  const lead = " ".repeat(queueStart);
  const trail = " ".repeat(Math.max(0, barWidth - queueStart - queueChars - runChars));

  const queue = queueChars > 0 ? c.gray(QUEUE_CHAR.repeat(queueChars)) : "";
  const body = RUN_CHAR.repeat(runChars);
  const failed = job.conclusion !== null && job.conclusion !== "success";

  const painted = failed ? c.red(body) : critical ? c.yellow(body) : c.blue(body);
  return `${lead}${queue}${painted}${trail}`;
}

function renderAxis(run: RunAnalysis, labelWidth: number, barWidth: number): string {
  const left = "0s";
  const right = duration(run.wallMs);
  const fill = Math.max(1, barWidth - left.length - right.length);
  return c.dim(`  ${" ".repeat(labelWidth)} ${left}${"─".repeat(fill)}${right}`);
}

export const BAR_LEGEND = `${QUEUE_CHAR} queued   ${RUN_CHAR} running   ▸ on critical path`;
