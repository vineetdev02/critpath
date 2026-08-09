import { parse } from "yaml";

export interface WorkflowJobSpec {
  /** The key under `jobs:` in the workflow file. */
  id: string;
  /** Declared `name:`, when it contains no `${{ }}` expressions. */
  name: string | null;
  /** Literal text before the first expression, usable as a prefix match. */
  namePrefix: string;
  needs: string[];
}

export interface JobGraph {
  /** API job name -> upstream API job names. */
  edges: Map<string, string[]>;
  /** API job names we could not map back to the workflow file. */
  unmatched: Set<string>;
}

/** Read the `jobs:` block of a workflow file into dependency specs. */
export function parseWorkflowJobs(source: string): WorkflowJobSpec[] {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch {
    return [];
  }

  const jobs = (doc as { jobs?: Record<string, unknown> } | null)?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  return Object.entries(jobs).map(([id, raw]) => {
    const spec = (raw ?? {}) as { name?: unknown; needs?: unknown };
    const declaredName = typeof spec.name === "string" ? spec.name : null;
    const hasExpression = declaredName?.includes("${{") ?? false;

    return {
      id,
      name: declaredName && !hasExpression ? declaredName : null,
      namePrefix: literalPrefix(declaredName ?? id),
      needs: toStringArray(spec.needs),
    };
  });
}

/**
 * Map the job names the API reports back onto workflow job ids, then express
 * `needs:` in terms of API job names.
 *
 * The API never returns the dependency graph, and its job names are decorated:
 * a matrix job appears as `Test (20, ubuntu-latest)` and a reusable-workflow
 * job as `Release / build`. So we match by narrowing: exact, then de-decorated,
 * then longest literal prefix.
 */
export function buildJobGraph(apiJobNames: string[], specs: WorkflowJobSpec[]): JobGraph {
  const assignment = new Map<string, string>();
  const bySpecId = new Map<string, string[]>();

  for (const apiName of apiJobNames) {
    const specId = matchJob(apiName, specs);
    if (!specId) continue;
    assignment.set(apiName, specId);
    const bucket = bySpecId.get(specId);
    if (bucket) bucket.push(apiName);
    else bySpecId.set(specId, [apiName]);
  }

  const specsById = new Map(specs.map((spec) => [spec.id, spec]));
  const edges = new Map<string, string[]>();
  const unmatched = new Set<string>();

  for (const apiName of apiJobNames) {
    const specId = assignment.get(apiName);
    if (!specId) {
      unmatched.add(apiName);
      continue;
    }
    const needs = specsById.get(specId)?.needs ?? [];
    edges.set(
      apiName,
      needs.flatMap((upstreamId) => bySpecId.get(upstreamId) ?? []),
    );
  }

  return { edges, unmatched };
}

function matchJob(apiName: string, specs: WorkflowJobSpec[]): string | null {
  const candidates = [apiName, stripMatrixSuffix(apiName), apiName.split(" / ")[0]?.trim() ?? apiName];

  for (const candidate of candidates) {
    const exact = specs.find((spec) => spec.name === candidate || spec.id === candidate);
    if (exact) return exact.id;
  }

  // Expression-driven names (`name: Test ${{ matrix.node }}`) only survive as
  // a literal prefix, so fall back to the most specific prefix that matches.
  let best: WorkflowJobSpec | null = null;
  for (const spec of specs) {
    if (!spec.namePrefix) continue;
    if (!apiName.startsWith(spec.namePrefix)) continue;
    if (!best || spec.namePrefix.length > best.namePrefix.length) best = spec;
  }
  return best?.id ?? null;
}

/** `Test (20, ubuntu-latest)` -> `Test` */
export function stripMatrixSuffix(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

function literalPrefix(name: string): string {
  const index = name.indexOf("${{");
  return (index === -1 ? name : name.slice(0, index)).trim();
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}
