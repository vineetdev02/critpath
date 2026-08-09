import { describe, expect, it } from "vitest";

import { analyzeRun } from "../src/analyze/build.js";
import { estimateCost } from "../src/analyze/cost.js";
import { buildInsights } from "../src/analyze/insights.js";
import { percentile, summarizeJobs, summarizeRuns } from "../src/analyze/stats.js";
import { makeJob, makeRun } from "./helpers.js";

const WORKFLOW = `
jobs:
  build:
    name: build
    steps: [{ run: echo }]
  test:
    name: test
    needs: build
    steps: [{ run: echo }]
  lint:
    name: lint
    steps: [{ run: echo }]
`;

/**
 * build (0-100s) -> test (110-300s), with lint running in parallel (0-60s).
 * Wall time is 300s; the critical path is build -> test with a 10s gap.
 */
function fixture() {
  const jobs = [
    makeJob({ name: "build", queued: 0, started: 0, completed: 100 }),
    makeJob({ name: "lint", queued: 0, started: 0, completed: 60 }),
    makeJob({ name: "test", queued: 100, started: 110, completed: 300 }),
  ];
  return analyzeRun(makeRun({ updated_at: new Date(Date.parse("2026-01-01T00:05:00Z")).toISOString() }), jobs, WORKFLOW);
}

describe("analyzeRun", () => {
  it("computes wall time, compute time and parallelism", () => {
    const run = fixture();

    expect(run.wallMs).toBe(300_000);
    expect(run.jobTimeMs).toBe(100_000 + 60_000 + 190_000);
    expect(run.parallelism).toBeCloseTo(350 / 300, 3);
  });

  it("follows declared needs for the critical path and splits work from waiting", () => {
    const run = fixture();

    expect(run.criticalPath.map((entry) => entry.job.name)).toEqual(["build", "test"]);
    expect(run.criticalWorkMs).toBe(290_000);
    expect(run.criticalGapMs).toBe(10_000);
    expect(run.criticalWorkMs + run.criticalGapMs).toBe(run.wallMs);
    expect(run.criticalPathInferred).toBe(false);
  });

  it("falls back to timing inference when the workflow file is unavailable", () => {
    const jobs = [
      makeJob({ name: "build", started: 0, completed: 100 }),
      makeJob({ name: "test", started: 110, completed: 300 }),
    ];
    const run = analyzeRun(makeRun(), jobs, null);

    expect(run.criticalPath.map((entry) => entry.job.name)).toEqual(["build", "test"]);
    expect(run.criticalPathInferred).toBe(true);
  });

  it("ignores skipped jobs, which never occupied a runner", () => {
    const jobs = [
      makeJob({ name: "build", started: 0, completed: 100 }),
      makeJob({ name: "deploy", started: 100, completed: 100, conclusion: "skipped" }),
    ];
    const run = analyzeRun(makeRun(), jobs, null);

    expect(run.jobs.map((job) => job.name)).toEqual(["build"]);
  });

  it("records queue time separately from execution time", () => {
    const run = fixture();
    const test = run.jobs.find((job) => job.name === "test");

    expect(test?.queueMs).toBe(10_000);
    expect(test?.durationMs).toBe(190_000);
  });
});

describe("insights", () => {
  it("flags setup work that repeats across jobs", () => {
    const steps = (offset: number) => [{ name: "Install dependencies", started: offset, completed: offset + 40 }];
    const jobs = [
      makeJob({ name: "a", started: 0, completed: 100, steps: steps(0) }),
      makeJob({ name: "b", started: 0, completed: 100, steps: steps(0) }),
      makeJob({ name: "c", started: 0, completed: 100, steps: steps(0) }),
    ];

    const insights = buildInsights(analyzeRun(makeRun(), jobs, null));
    const duplicate = insights.find((insight) => insight.kind === "duplicate-step");

    expect(duplicate?.title).toContain("repeats in 3 jobs");
    expect(duplicate?.savingKind).toBe("compute");
  });

  it("does not tell you to cache your tests", () => {
    const steps = [{ name: "Run tests", started: 0, completed: 90 }];
    const jobs = ["a", "b", "c", "d"].map((name) =>
      makeJob({ name, started: 0, completed: 100, steps }),
    );

    const insights = buildInsights(analyzeRun(makeRun(), jobs, null));
    expect(insights.some((insight) => insight.kind === "duplicate-step")).toBe(false);
  });

  it("calls out a pipeline that is barely parallel", () => {
    const jobs = [
      makeJob({ name: "a", started: 0, completed: 100 }),
      makeJob({ name: "b", started: 100, completed: 200 }),
      makeJob({ name: "c", started: 200, completed: 300 }),
    ];

    const insights = buildInsights(analyzeRun(makeRun(), jobs, null));
    expect(insights.some((insight) => insight.kind === "serialized")).toBe(true);
  });
});

describe("cost", () => {
  it("rounds every job up to a whole minute, the way GitHub bills", () => {
    const jobs = [
      makeJob({ name: "a", started: 0, completed: 10 }),
      makeJob({ name: "b", started: 0, completed: 61 }),
    ];
    const cost = estimateCost([analyzeRun(makeRun(), jobs, null)]);

    expect(cost.billableMinutes).toBe(3);
    expect(cost.usd).toBeCloseTo(3 * 0.008, 6);
    expect(cost.roundingMinutes).toBeGreaterThan(1.7);
  });

  it("prices windows and macos runners from their labels", () => {
    const jobs = [
      makeJob({ name: "win", started: 0, completed: 60, labels: ["windows-latest"] }),
      makeJob({ name: "mac", started: 0, completed: 60, labels: ["macos-14"] }),
    ];
    const cost = estimateCost([analyzeRun(makeRun(), jobs, null)]);

    expect(cost.byPlatform.windows.minutes).toBe(1);
    expect(cost.byPlatform.macos.minutes).toBe(1);
    expect(cost.usd).toBeCloseTo(0.016 + 0.08, 6);
  });
});

describe("stats", () => {
  it("interpolates percentiles", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });

  it("summarises across runs and tracks how often a job blocks the run", () => {
    const runs = Array.from({ length: 6 }, () => fixture());
    const stats = summarizeRuns(runs);
    const jobs = summarizeJobs(runs);

    expect(stats.count).toBe(6);
    expect(stats.wallP50).toBe(300_000);
    expect(jobs[0]?.name).toBe("test");
    expect(jobs.find((job) => job.name === "test")?.criticalRate).toBe(1);
    expect(jobs.find((job) => job.name === "lint")?.criticalRate).toBe(0);
  });
});
