import { describe, expect, it } from "vitest";

import {
  anyOverBudget,
  evaluateBudget,
  evaluateJobBudgets,
  type JobBudgetVerdict,
  parseDuration,
  parseJobBudgets,
  rejectRepeatedJobBudget,
} from "../src/analyze/budget.js";
import { UsageError } from "../src/args.js";

describe("parseDuration", () => {
  it("reads single units", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("250ms")).toBe(250);
  });

  it("reads compound durations", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("12m 30s")).toBe(750_000);
  });

  it("treats a bare number as minutes", () => {
    expect(parseDuration("10")).toBe(600_000);
  });

  it("rejects input it only partly understands", () => {
    expect(() => parseDuration("10m5")).toThrow(UsageError);
    expect(() => parseDuration("soon")).toThrow(UsageError);
    expect(() => parseDuration("10x")).toThrow(UsageError);
    expect(() => parseDuration("0m")).toThrow(UsageError);
    expect(() => parseDuration("")).toThrow(UsageError);
  });
});

describe("evaluateBudget", () => {
  it("gates on p50 wall time, not the newest run", () => {
    expect(evaluateBudget(600_000, 620_000)).toEqual({
      budgetMs: 600_000,
      actualMs: 620_000,
      over: true,
    });
  });

  it("is not over when exactly on budget", () => {
    expect(evaluateBudget(600_000, 600_000).over).toBe(false);
  });
});

describe("parseJobBudgets", () => {
  it("reads one entry, and several separated by commas", () => {
    expect(parseJobBudgets("build=5m")).toEqual([{ pattern: "build", budgetMs: 300_000 }]);
    expect(parseJobBudgets(" build=5m , test=8m ")).toEqual([
      { pattern: "build", budgetMs: 300_000 },
      { pattern: "test", budgetMs: 480_000 },
    ]);
  });

  it("reads the multi-line form the action passes through", () => {
    expect(parseJobBudgets("build=5m\ntest=8m\n")).toEqual([
      { pattern: "build", budgetMs: 300_000 },
      { pattern: "test", budgetMs: 480_000 },
    ]);
  });

  it("does not split a matrix job name at its own comma", () => {
    // GitHub names the job `test (ubuntu-latest, 20)`. Splitting on every comma
    // would leave a budget for "test (ubuntu-latest" — a gate that can only
    // ever report that it matched nothing.
    expect(parseJobBudgets("test (ubuntu-latest, 20)=8m, lint=1m")).toEqual([
      { pattern: "test (ubuntu-latest, 20)", budgetMs: 480_000 },
      { pattern: "lint", budgetMs: 60_000 },
    ]);
  });

  it("splits at the last = so a job name may contain one", () => {
    expect(parseJobBudgets("build (env=prod)=5m")).toEqual([
      { pattern: "build (env=prod)", budgetMs: 300_000 },
    ]);
  });

  it("rejects an entry that is not <job>=<duration>", () => {
    expect(() => parseJobBudgets("build")).toThrow(UsageError);
    expect(() => parseJobBudgets("=5m")).toThrow(UsageError);
    expect(() => parseJobBudgets("build=soon")).toThrow(UsageError);
    expect(() => parseJobBudgets("build=")).toThrow(UsageError);
  });

  it("names the option a bad duration came from", () => {
    expect(() => parseJobBudgets("build=soon")).toThrow(/--job-budget/);
  });

  it("rejects an empty list rather than gating on nothing", () => {
    expect(() => parseJobBudgets("")).toThrow(UsageError);
    expect(() => parseJobBudgets(" , ")).toThrow(UsageError);
  });

  it("rejects an unclosed parenthesis, which would swallow the next entry", () => {
    expect(() => parseJobBudgets("test (20=8m,build=5m")).toThrow(UsageError);
    // A stray closing one is harmless — it cannot hide a separator.
    expect(parseJobBudgets("test 20)=8m")).toEqual([{ pattern: "test 20)", budgetMs: 480_000 }]);
  });

  it("rejects two budgets for the same job", () => {
    expect(() => parseJobBudgets("build=5m,build=9m")).toThrow(UsageError);
  });
});

describe("rejectRepeatedJobBudget", () => {
  it("accepts the option once, in either spelling", () => {
    expect(() => rejectRepeatedJobBudget(["--job-budget", "build=5m"])).not.toThrow();
    expect(() => rejectRepeatedJobBudget(["--job-budget=build=5m", "--budget", "10m"])).not.toThrow();
  });

  it("rejects it twice, because the parser would keep only the last", () => {
    // Merging them silently is the other option, and a gate that lost half its
    // budgets without saying so is exactly the false pass this tool avoids.
    expect(() => rejectRepeatedJobBudget(["--job-budget", "a=5m", "--job-budget", "b=5m"])).toThrow(
      UsageError,
    );
    expect(() => rejectRepeatedJobBudget(["--job-budget=a=5m", "--job-budget=b=5m"])).toThrow(
      UsageError,
    );
  });

  it("is not fooled by a flag that merely starts the same way", () => {
    expect(() => rejectRepeatedJobBudget(["--job-budgets", "a=5m", "--job-budget", "b=5m"])).not.toThrow();
  });
});

const JOBS = [
  { name: "test (20)", p50: 480_000, p90: 500_000, runs: 5, criticalRate: 1 },
  { name: "test (22)", p50: 240_000, p90: 260_000, runs: 5, criticalRate: 0 },
  { name: "build", p50: 300_000, p90: 320_000, runs: 5, criticalRate: 1 },
];

describe("evaluateJobBudgets", () => {
  it("measures p50 against the budget", () => {
    const [verdict] = evaluateJobBudgets([{ pattern: "build", budgetMs: 240_000 }], JOBS);

    expect(verdict).toEqual({
      pattern: "build",
      budgetMs: 240_000,
      job: "build",
      actualMs: 300_000,
      runs: 5,
      over: true,
    });
  });

  it("is not over when exactly on budget", () => {
    expect(evaluateJobBudgets([{ pattern: "build", budgetMs: 300_000 }], JOBS)[0]?.over).toBe(false);
  });

  it("gives every shard of a matrix its own verdict", () => {
    // `test=5m` means five minutes each: the shards run in parallel, so summing
    // them would fail a gate that nothing on the critical path violated.
    const verdicts = evaluateJobBudgets([{ pattern: "test", budgetMs: 300_000 }], JOBS);

    expect(verdicts.map((verdict) => [verdict.job, verdict.over])).toEqual([
      ["test (20)", true],
      ["test (22)", false],
    ]);
  });

  it("keeps the order the budgets were written in", () => {
    const verdicts = evaluateJobBudgets(
      [
        { pattern: "build", budgetMs: 300_000 },
        { pattern: "test (22)", budgetMs: 300_000 },
      ],
      JOBS,
    );

    expect(verdicts.map((verdict) => verdict.job)).toEqual(["build", "test (22)"]);
  });

  it("reports a budget that matched nothing, and does not fail on it", () => {
    const [verdict] = evaluateJobBudgets([{ pattern: "deploy", budgetMs: 60_000 }], JOBS);

    expect(verdict).toMatchObject({ pattern: "deploy", job: null, actualMs: null, over: false });
  });

  it("does not match a job by a fragment of its name", () => {
    // A typo has to surface as "matched nothing", not quietly gate the job it
    // happens to be a prefix of.
    expect(evaluateJobBudgets([{ pattern: "bui", budgetMs: 1_000 }], JOBS)[0]?.job).toBeNull();
    expect(evaluateJobBudgets([{ pattern: "test (2", budgetMs: 1_000 }], JOBS)[0]?.job).toBeNull();
  });
});

describe("anyOverBudget", () => {
  const over = (patch: Partial<JobBudgetVerdict> = {}): JobBudgetVerdict => ({
    pattern: "build",
    budgetMs: 60_000,
    job: "build",
    actualMs: 300_000,
    runs: 5,
    over: true,
    ...patch,
  });

  it("fails on either kind of budget", () => {
    expect(anyOverBudget(evaluateBudget(600_000, 620_000), [])).toBe(true);
    expect(anyOverBudget(null, [over()])).toBe(true);
  });

  it("passes when everything measured came in under", () => {
    expect(anyOverBudget(null, [])).toBe(false);
    expect(anyOverBudget(evaluateBudget(600_000, 400_000), [over({ over: false })])).toBe(false);
  });

  it("does not fail on a budget that matched no job", () => {
    expect(anyOverBudget(null, [over({ job: null, actualMs: null, runs: 0, over: false })])).toBe(false);
  });
});
