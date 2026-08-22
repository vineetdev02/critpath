import { describe, expect, it } from "vitest";

import { evaluateBudget, parseDuration } from "../src/analyze/budget.js";
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
