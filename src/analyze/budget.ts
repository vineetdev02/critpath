import { UsageError } from "../args.js";
import type { JobStat } from "./stats.js";

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/**
 * `10m`, `90s`, `1h30m`, `250ms` — and a bare number, which reads as minutes
 * because that is the unit every CI budget conversation already uses.
 */
export function parseDuration(text: string, flag = "--budget"): number {
  // Whitespace is stripped so a quoted "12m 30s" reads the same as 12m30s.
  const value = text.toLowerCase().replace(/\s+/g, "");
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * UNIT_MS.m;

  let total = 0;
  let consumed = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
    consumed += (match[0] as string).length;
  }

  // Anything left over means the input was only partly understood, and a
  // budget that was silently misread is worse than one that was rejected.
  if (consumed !== value.length || total <= 0) {
    throw new UsageError(`Option "${flag}" expects a duration like 10m, 90s or 1h30m, got "${text}".`);
  }
  return total;
}

export interface BudgetVerdict {
  budgetMs: number;
  /** What was measured against the budget: p50 wall time across the sample. */
  actualMs: number;
  over: boolean;
}

/**
 * The gate reads p50 wall time, not the newest run. One unlucky run should not
 * turn a pipeline red, and "CI takes 22 minutes" was always a claim about the
 * middle of the distribution rather than about any single build.
 */
export function evaluateBudget(budgetMs: number, wallP50Ms: number): BudgetVerdict {
  return { budgetMs, actualMs: wallP50Ms, over: wallP50Ms > budgetMs };
}

export interface JobBudget {
  /** What was written on the left of the `=`. */
  pattern: string;
  budgetMs: number;
}

/**
 * `build=5m,test=8m` — and the same entries across several lines, because the
 * packaged action hands a multi-line YAML input straight through.
 *
 * A comma inside parentheses is not a separator. GitHub names a matrix job
 * `test (ubuntu-latest, 20)`, so splitting on every comma would cut that name
 * in half and leave a budget pointed at a job that does not exist — a gate
 * quietly measuring nothing, which is the failure this tool exists to avoid.
 */
export function parseJobBudgets(text: string, flag = "--job-budget"): JobBudget[] {
  const budgets: JobBudget[] = [];
  const seen = new Set<string>();

  for (const entry of splitEntries(text, flag)) {
    // Split at the last `=`: a duration never contains one, a job name might.
    const split = entry.lastIndexOf("=");
    const pattern = split === -1 ? "" : entry.slice(0, split).trim();
    if (!pattern) {
      throw new UsageError(`Option "${flag}" expects <job>=<duration>, got "${entry}".`);
    }
    if (seen.has(pattern)) {
      throw new UsageError(`Option "${flag}" gives "${pattern}" two budgets.`);
    }

    seen.add(pattern);
    budgets.push({ pattern, budgetMs: parseDuration(entry.slice(split + 1), flag) });
  }

  if (budgets.length === 0) {
    throw new UsageError(`Option "${flag}" expects at least one <job>=<duration>, e.g. build=5m.`);
  }
  return budgets;
}

function splitEntries(text: string, flag: string): string[] {
  const entries: string[] = [];
  let current = "";
  let depth = 0;

  for (const character of text) {
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);

    if (depth === 0 && (character === "," || character === "\n")) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  entries.push(current);

  // An unclosed `(` swallows every separator after it, so the rest of the list
  // would arrive as one entry that can only ever match nothing. Say so instead.
  if (depth > 0) {
    throw new UsageError(`Option "${flag}" has an unclosed "(" in "${text.trim()}".`);
  }

  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * The argv parser keeps the last value of a repeated option. That is harmless
 * for `--branch` and quietly fatal here — half a gate would disappear without
 * a word — so a second `--job-budget` is rejected rather than merged.
 */
export function rejectRepeatedJobBudget(argv: string[]): void {
  const given = argv.filter((token) => /^--?job-budget(=|$)/.test(token));
  if (given.length > 1) {
    throw new UsageError(
      'Option "--job-budget" was given twice. Put every entry in one: --job-budget "build=5m,test=8m".',
    );
  }
}

export interface JobBudgetVerdict {
  pattern: string;
  budgetMs: number;
  /** The job the pattern matched; null when nothing in the sample did. */
  job: string | null;
  /** p50 duration of that job across the sample; null when nothing matched. */
  actualMs: number | null;
  /** How many of the sampled runs contained it. */
  runs: number;
  over: boolean;
}

/**
 * One verdict per matching job, in the order the budgets were written. A
 * pattern that covers a matrix gets a verdict per shard, because `test=8m`
 * asks for eight minutes each rather than eight minutes between them.
 *
 * A pattern that matches nothing is reported but never fails the gate: a job
 * that was renamed, or that only runs on main, would otherwise turn every
 * build red with no code change behind it. Saying nothing is the other half of
 * that trap, so the row is always rendered, with `—` where a number would be.
 */
export function evaluateJobBudgets(budgets: JobBudget[], jobs: JobStat[]): JobBudgetVerdict[] {
  const verdicts: JobBudgetVerdict[] = [];

  for (const budget of budgets) {
    const matched = jobs.filter((job) => matchesJob(budget.pattern, job.name));

    if (matched.length === 0) {
      verdicts.push({ ...budget, job: null, actualMs: null, runs: 0, over: false });
      continue;
    }
    for (const job of matched) {
      verdicts.push({
        ...budget,
        job: job.name,
        actualMs: job.p50,
        runs: job.runs,
        over: job.p50 > budget.budgetMs,
      });
    }
  }

  return verdicts;
}

/**
 * The exact name, or the base name of a matrix job — GitHub spells those
 * `test (20)` and `test (ubuntu-latest, 20)`. Deliberately not a substring
 * match: `tes` quietly covering `test` is how a typo becomes a gate that looks
 * like it is working.
 */
function matchesJob(pattern: string, jobName: string): boolean {
  return jobName === pattern || jobName.startsWith(`${pattern} (`);
}

/** The gate: `--check` fails the build when any budget came out over. */
export function anyOverBudget(wall: BudgetVerdict | null, jobs: JobBudgetVerdict[]): boolean {
  return wall?.over === true || jobs.some((verdict) => verdict.over);
}
