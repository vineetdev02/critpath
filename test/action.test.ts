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

  it("looks for the marker the markdown actually carries", () => {
    // The whole one-comment-per-pull-request behaviour hangs off this string
    // matching; nothing else would fail if it drifted.
    expect(scripts).toContain(COMMENT_MARKER);
  });

  it("asks critpath for markdown, which is what it publishes", () => {
    expect(scripts).toContain("--markdown");
  });
});
