import { describe, expect, it } from "vitest";

import { analyzeRun } from "../src/analyze/build.js";
import { evaluateBudget } from "../src/analyze/budget.js";
import { estimateCost } from "../src/analyze/cost.js";
import { buildInsights } from "../src/analyze/insights.js";
import { summarizeRuns } from "../src/analyze/stats.js";
import { setColorEnabled } from "../src/render/ansi.js";
import { COMMENT_MARKER, renderMarkdown } from "../src/render/markdown.js";
import type { Report } from "../src/render/report.js";
import { makeJob, makeRun } from "./helpers.js";

const WORKFLOW = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs: build
    runs-on: ubuntu-latest
`;

function buildReport(overrides: Partial<Report> = {}): Report {
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
    ...overrides,
  };
}

describe("renderMarkdown", () => {
  it("leads with the comment marker so a workflow can update in place", () => {
    expect(renderMarkdown(buildReport()).startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("names the repository and the jobs on the critical path", () => {
    const out = renderMarkdown(buildReport());

    expect(out).toContain("critpath — `acme/api`");
    expect(out).toContain("#### Critical path");
    expect(out).toContain("| 1 | build |");
    expect(out).toContain("| 2 | test |");
  });

  it("puts the budget verdict above everything else", () => {
    const over = renderMarkdown(buildReport({ budget: evaluateBudget(60_000, 600_000) }));
    expect(over).toContain("**Over budget**");
    expect(over.indexOf("Over budget")).toBeLessThan(over.indexOf("Critical path"));

    const under = renderMarkdown(buildReport({ budget: evaluateBudget(3_600_000, 600_000) }));
    expect(under).toContain("**Within budget**");
    expect(under).not.toContain("Over budget");
  });

  it("says nothing about a budget that was not asked for", () => {
    expect(renderMarkdown(buildReport())).not.toContain("budget");
  });

  it("never emits ANSI escapes, even with colour switched on", () => {
    setColorEnabled(true);
    try {
      expect(renderMarkdown(buildReport())).not.toMatch(/\[/);
    } finally {
      setColorEnabled(false);
    }
  });

  it("escapes pipes and angle brackets so a name cannot break a table", () => {
    const out = renderMarkdown(buildReport({ workflowName: "a|b", otherWorkflows: ["<script>"] }));

    expect(out).toContain("a\\|b");
    expect(out).toContain("&lt;script>");
  });

  it("reports free minutes for a public repo and money for a private one", () => {
    expect(renderMarkdown(buildReport())).toContain("free on a public repo");
    expect(renderMarkdown(buildReport({ billable: true, monthlyUsd: 42 }))).toContain("/month");
  });

  it("collapses the long tables behind <details>", () => {
    const out = renderMarkdown(buildReport());

    expect(out).toContain("<summary>Slowest steps</summary>");
    expect(out).toContain("<summary>All 2 jobs</summary>");
  });

  it("survives a run whose critical path could not be built", () => {
    const empty = buildReport();
    const focus = { ...empty.focus, criticalPath: [], jobs: [] };
    const out = renderMarkdown({ ...empty, focus, runs: [focus], insights: [] });

    expect(out).toContain("#### Critical path");
    expect(out).not.toContain("| 1 |");
  });
});
