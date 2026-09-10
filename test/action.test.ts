import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { COMMENT_MARKER } from "../src/render/markdown.js";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

const action = read("action.yml");
const steps = (parse(action) as { runs: { steps: { run?: string }[] } }).runs.steps;
const scripts = steps.map((step) => step.run ?? "").join("\n");

describe("the packaged action", () => {
  it("runs the version its own checkout declares, never a hardcoded one", () => {
    // The tag that ships the action ships the package too, so reading the
    // version back out of package.json is what keeps `@v0.1.4` from quietly
    // running whatever was pinned here at the time.
    expect(scripts).toContain("$GITHUB_ACTION_PATH/package.json");
    expect(scripts).toContain('"critpath@$version"');
    expect(scripts).not.toMatch(/critpath@\d/);
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
});
