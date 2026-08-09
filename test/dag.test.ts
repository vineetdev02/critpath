import { describe, expect, it } from "vitest";

import { buildJobGraph, parseWorkflowJobs, stripMatrixSuffix } from "../src/analyze/dag.js";

const WORKFLOW = `
name: CI
on: [push]
jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  changed:
    name: "Diff: node-latest"
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  test:
    name: "Test: \${{ matrix.kind }}, node-\${{ matrix.node }}"
    needs: changed
    strategy:
      matrix:
        node: [20, 22]
    steps: [{ run: echo }]
  test-vite7:
    name: "Test: vite@7, \${{ matrix.kind }}"
    needs: changed
    steps: [{ run: echo }]
  merge:
    name: Merge Reports
    needs: [test, changed]
    steps: [{ run: echo }]
`;

describe("parseWorkflowJobs", () => {
  it("reads ids, literal names and needs", () => {
    const specs = parseWorkflowJobs(WORKFLOW);
    const byId = Object.fromEntries(specs.map((spec) => [spec.id, spec]));

    expect(specs).toHaveLength(5);
    expect(byId.lint?.name).toBe("Lint");
    expect(byId.merge?.needs).toEqual(["test", "changed"]);
    expect(byId.test?.needs).toEqual(["changed"]);
  });

  it("drops names containing expressions but keeps their literal prefix", () => {
    const byId = Object.fromEntries(parseWorkflowJobs(WORKFLOW).map((spec) => [spec.id, spec]));

    expect(byId.test?.name).toBeNull();
    expect(byId.test?.namePrefix).toBe("Test:");
    expect(byId["test-vite7"]?.namePrefix).toBe("Test: vite@7,");
  });

  it("returns nothing for unparseable or job-less input", () => {
    expect(parseWorkflowJobs(":::not yaml:::")).toEqual([]);
    expect(parseWorkflowJobs("name: CI\non: push\n")).toEqual([]);
  });
});

describe("buildJobGraph", () => {
  const specs = parseWorkflowJobs(WORKFLOW);
  const apiNames = [
    "Lint",
    "Diff: node-latest",
    "Test: unit, node-20",
    "Test: unit, node-22",
    "Test: vite@7, e2e",
    "Merge Reports",
  ];

  it("resolves needs into API job names, fanning out across a matrix", () => {
    const graph = buildJobGraph(apiNames, specs);

    expect(graph.unmatched.size).toBe(0);
    expect(graph.edges.get("Test: unit, node-20")).toEqual(["Diff: node-latest"]);
    expect(graph.edges.get("Merge Reports")).toEqual([
      "Test: unit, node-20",
      "Test: unit, node-22",
      "Diff: node-latest",
    ]);
  });

  it("prefers the longest matching prefix so overlapping names do not collide", () => {
    const graph = buildJobGraph(apiNames, specs);

    // "Test: vite@7, e2e" matches both `Test:` and `Test: vite@7,` — the more
    // specific spec must win, otherwise it inherits the wrong dependencies.
    expect(graph.edges.get("Test: vite@7, e2e")).toEqual(["Diff: node-latest"]);
    expect(graph.edges.get("Merge Reports")).not.toContain("Test: vite@7, e2e");
  });

  it("reports jobs it cannot map back to the workflow", () => {
    const graph = buildJobGraph(["Something Else"], specs);
    expect([...graph.unmatched]).toEqual(["Something Else"]);
  });

  it("matches reusable-workflow job names by their caller segment", () => {
    const graph = buildJobGraph(["Lint / inner"], specs);
    expect(graph.unmatched.size).toBe(0);
  });
});

describe("stripMatrixSuffix", () => {
  it("removes only a trailing parenthesised group", () => {
    expect(stripMatrixSuffix("Test (20, ubuntu-latest)")).toBe("Test");
    expect(stripMatrixSuffix("Build (release)")).toBe("Build");
    expect(stripMatrixSuffix("Test (fast) suite")).toBe("Test (fast) suite");
  });
});
