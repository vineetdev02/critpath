import { describe, expect, it } from "vitest";

import { evaluateBudget } from "../src/analyze/budget.js";
import { setColorEnabled } from "../src/render/ansi.js";
import { COMMENT_MARKER, renderMarkdown } from "../src/render/markdown.js";
import { makeJobBudgets, makeReport } from "./helpers.js";

describe("renderMarkdown", () => {
  it("leads with the comment marker so a workflow can update in place", () => {
    expect(renderMarkdown(makeReport()).startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("names the repository and the jobs on the critical path", () => {
    const out = renderMarkdown(makeReport());

    expect(out).toContain("critpath — `acme/api`");
    expect(out).toContain("#### Critical path");
    expect(out).toContain("| 1 | build |");
    expect(out).toContain("| 2 | test |");
  });

  it("puts the budget verdict above everything else", () => {
    const over = renderMarkdown(makeReport({ budget: evaluateBudget(60_000, 600_000) }));
    expect(over).toContain("**Over budget**");
    expect(over.indexOf("Over budget")).toBeLessThan(over.indexOf("Critical path"));

    const under = renderMarkdown(makeReport({ budget: evaluateBudget(3_600_000, 600_000) }));
    expect(under).toContain("**Within budget**");
    expect(under).not.toContain("Over budget");
  });

  it("says nothing about a budget that was not asked for", () => {
    expect(renderMarkdown(makeReport())).not.toContain("budget");
  });

  it("never emits ANSI escapes, even with colour switched on", () => {
    setColorEnabled(true);
    try {
      expect(renderMarkdown(makeReport())).not.toMatch(/\[/);
    } finally {
      setColorEnabled(false);
    }
  });

  it("keeps a name in a code span literal, rather than escaping what cannot be markup there", () => {
    // Outside a table nothing in a code span is markup, so an escape there
    // would print: `a\|b` and `&lt;script>` were what readers used to see.
    const out = renderMarkdown(makeReport({ workflowName: "a|b", otherWorkflows: ["<script>"] }));

    expect(out).toContain("`a|b`");
    expect(out).toContain("`<script>`");
    expect(out).not.toMatch(/(^|[^`])<script>/);
  });

  it("reports free minutes for a public repo and money for a private one", () => {
    expect(renderMarkdown(makeReport())).toContain("free on a public repo");
    expect(renderMarkdown(makeReport({ billable: true, monthlyUsd: 42 }))).toContain("/month");
  });

  it("collapses the long tables behind <details>", () => {
    const out = renderMarkdown(makeReport());

    expect(out).toContain("<summary>Slowest steps</summary>");
    expect(out).toContain("<summary>All 2 jobs</summary>");
  });

  it("survives a run whose critical path could not be built", () => {
    const empty = makeReport();
    const focus = { ...empty.focus, criticalPath: [], jobs: [] };
    const out = renderMarkdown({ ...empty, focus, runs: [focus], insights: [] });

    expect(out).toContain("#### Critical path");
    expect(out).not.toContain("| 1 |");
  });
});

describe("renderMarkdown · job budgets", () => {
  // build ran 3m 30s and test 5m 50s, so this is one job over, one job with
  // room, and one budget naming a job that is not in the sample at all.
  const report = makeReport();
  const jobBudgets = makeJobBudgets(report, "build=1m,test=1h,deploy=5m");

  it("gives each job a row, with the overrun spelled out", () => {
    const out = renderMarkdown(makeReport({ jobBudgets }));

    expect(out).toContain("#### Job budgets");
    expect(out).toContain("| 🔴 | `build` | 3m 30s | 1m 00s | **2m 30s over** |");
    expect(out).toContain("| ✅ | `test` | 5m 50s | 1h 00m | 54m 10s to spare |");
  });

  it("keeps a budget that matched no job, rather than dropping it silently", () => {
    const out = renderMarkdown(makeReport({ jobBudgets }));

    expect(out).toContain("| ⚪ | `deploy` | — | 5m 00s | no job by that name in the last 1 run |");
  });

  it("puts the job budgets above the analysis, with the wall-time verdict", () => {
    const out = renderMarkdown(makeReport({ jobBudgets, budget: evaluateBudget(60_000, 600_000) }));

    expect(out.indexOf("Over budget")).toBeLessThan(out.indexOf("Job budgets"));
    expect(out.indexOf("Job budgets")).toBeLessThan(out.indexOf("Critical path"));
  });

  it("says nothing when no job budget was asked for", () => {
    expect(renderMarkdown(makeReport())).not.toContain("Job budgets");
  });

  it("escapes a job name so it cannot break the table", () => {
    const out = renderMarkdown(
      makeReport({ jobBudgets: [{ pattern: "a|b", budgetMs: 60_000, job: "a|b", actualMs: 30_000, runs: 1, over: false }] }),
    );

    expect(out).toContain("`a\\|b`");
  });
});
