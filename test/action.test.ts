import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { COMMENT_MARKER } from "../src/render/markdown.js";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

interface Action {
  inputs: Record<string, unknown>;
  runs: { steps: Array<{ id?: string; env?: Record<string, string>; run?: string }> };
}

const action = read("action.yml");
const doc = parse(action) as Action;
const steps = doc.runs.steps;
const scripts = steps.map((step) => step.run ?? "").join("\n");
const mainStep = steps.find((step) => step.id === "critpath");

describe("the packaged action", () => {
  it("runs the version its own checkout declares, never a hardcoded one", () => {
    // The tag that ships the action ships the package too, so reading the
    // version back out of package.json is what keeps `@v0.1.4` from quietly
    // running whatever was pinned here at the time.
    expect(scripts).toContain("process.env.GITHUB_ACTION_PATH");
    expect(scripts).toContain('"critpath@$version"');
    expect(scripts).not.toMatch(/critpath@\d/);
  });

  it("never pastes a path into JavaScript source", () => {
    // A Windows runner's action path is `D:\a\_actions\…\v0.1.9`, and inside
    // a JavaScript string literal `\v` is a vertical tab: the require failed
    // and the step died before critpath ran. The path goes through the
    // environment instead.
    const code = scripts.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/node -[ep] "[^"]*\$\{?[A-Z_]+/);
  });

  it("does not fail the job because a comment could not be posted", () => {
    // A fork's pull request gets a read-only token. The comment step says so
    // and carries on; it is the budget step that decides the job.
    const comment = steps.find((step) => step.run?.includes("gh api")) ?? {};
    expect(comment.run).toContain("::warning::");
    expect(comment.run).toMatch(/if ! gh api -X POST/);
  });

  it("installs into a directory of its own, rather than npx-ing itself", () => {
    // npx resolves a spec against the current project before the registry, so
    // in this repository — the one dogfooding the action — `npx critpath@…`
    // decided the checkout already satisfied it, skipped the download, and
    // exited 127 with `critpath: not found` because nothing had built dist.
    // Changing directory would also fix it; the directory has to stay, because
    // critpath reads the git remote of the working directory when none is
    // given.
    // A line, not the word: the comment above the fix says "npx" too.
    expect(scripts).not.toMatch(/^\s*npx\s/m);
    expect(scripts).toContain("--prefix");
    expect(scripts).toContain("node_modules/.bin/critpath");
  });

  it("looks for the marker the markdown actually carries", () => {
    // The whole one-comment-per-pull-request behaviour hangs off this string
    // matching; nothing else would fail if it drifted.
    expect(scripts).toContain(COMMENT_MARKER);
  });

  it("asks critpath for markdown, which is what it publishes", () => {
    expect(scripts).toContain("--markdown");
  });

  it("passes both kinds of budget, and asks for the gate when either is set", () => {
    // --check is what makes the verdict machine-readable, and a per-job budget
    // with no --check would be analysed and then thrown away.
    expect(scripts).toContain('args+=(--budget "$CRITPATH_BUDGET")');
    expect(scripts).toContain('args+=(--job-budget "$CRITPATH_JOB_BUDGET")');
    expect(scripts).toMatch(/if \[ -n "\$CRITPATH_BUDGET" \] \|\| \[ -n "\$CRITPATH_JOB_BUDGET" \]/);
  });

  it("passes --job-budget once, which is all the CLI accepts", () => {
    // Lines, not occurrences: the comment above the fix names the flag too.
    const lines = (mainStep?.run ?? "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#") && line.includes("--job-budget"));

    expect(lines).toHaveLength(1);
  });

  it("backs every variable the step reads with an input it declares", () => {
    // An input that was never declared reads as empty, so the flag it guards
    // silently never appears and the gate it was meant to set is simply gone.
    const used = [...new Set([...(mainStep?.run ?? "").matchAll(/\$\{?CRITPATH_([A-Z_]+)\}?/g)].map(
      (match) => match[1] as string,
    ))];

    expect(used.length).toBeGreaterThan(0);
    for (const variable of used) {
      expect(Object.keys(mainStep?.env ?? {})).toContain(`CRITPATH_${variable}`);
      expect(Object.keys(doc.inputs)).toContain(variable.toLowerCase().replace(/_/g, "-"));
    }
  });
});
