import { beforeEach, describe, expect, it } from "vitest";

import { evaluateBudget } from "../src/analyze/budget.js";
import { setColorEnabled } from "../src/render/ansi.js";
import { renderReport } from "../src/render/report.js";
import { makeJobBudgets, makeReport } from "./helpers.js";

beforeEach(() => {
  // The report is compared as text here, so the escapes have to be off no
  // matter whether the suite happens to be running attached to a terminal.
  setColorEnabled(false);
});

describe("renderReport · job budgets", () => {
  // build ran 3m 30s and test 5m 50s, so this is one job over, one with room,
  // and one budget naming a job that is not in the sample at all.
  const jobBudgets = makeJobBudgets(makeReport(), "build=1m,test=1h,deploy=5m");

  it("prints a line per job, with the overrun and the room spelled out", () => {
    const out = renderReport(makeReport({ jobBudgets }));

    expect(out).toContain("Job budgets");
    expect(out).toMatch(/✗ {2}build {2,}3m 30s {3}2m 30s over 1m 00s/);
    expect(out).toMatch(/✓ {2}test {2,}5m 50s {3}54m 10s under 1h 00m/);
  });

  it("keeps a budget that matched no job, and says why it has no number", () => {
    const out = renderReport(makeReport({ jobBudgets }));

    expect(out).toContain("no job by that name in the last 1 run");
  });

  it("names the matched job rather than the pattern that found it", () => {
    // `test` is how a matrix budget is written; `test (20)` is what ran, and
    // the number on the line belongs to the job, so the job is what is named.
    const out = renderReport(
      makeReport({
        jobBudgets: [
          { pattern: "test", budgetMs: 60_000, job: "test (20)", actualMs: 30_000, runs: 3, over: false },
        ],
      }),
    );

    expect(out).toContain("test (20)");
  });

  it("puts the gate above the detail, under the wall-time verdict", () => {
    // "Critical path" is also a summary row, so the waterfall heading is what
    // marks the start of the detail this has to stay above.
    const out = renderReport(makeReport({ jobBudgets, budget: evaluateBudget(60_000, 600_000) }));

    expect(out.indexOf("OVER BUDGET")).toBeLessThan(out.indexOf("Job budgets"));
    expect(out.indexOf("Job budgets")).toBeLessThan(out.indexOf("Waterfall"));
  });

  it("says nothing when no budget was asked for", () => {
    const out = renderReport(makeReport());

    expect(out).not.toContain("Job budgets");
    expect(out).not.toContain("budget");
  });
});
