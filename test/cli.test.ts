import { describe, expect, it } from "vitest";

import { getBool, getNumber, getString, parseArgs, UsageError } from "../src/args.js";
import { parseRepoSlug } from "../src/github/api.js";
import { nextPageUrl } from "../src/github/client.js";
import { duration, percent, usd } from "../src/render/format.js";

const KNOWN = { branch: "string", runs: "string", json: "boolean", color: "boolean" } as const;

describe("parseArgs", () => {
  it("handles positionals, spaced values and inline values", () => {
    const args = parseArgs(["owner/repo", "--branch", "dev", "--runs=5"], KNOWN);

    expect(args.positionals).toEqual(["owner/repo"]);
    expect(getString(args, "branch")).toBe("dev");
    expect(getNumber(args, "runs")).toBe(5);
  });

  it("supports --flag and --no-flag", () => {
    expect(getBool(parseArgs(["--json"], KNOWN), "json")).toBe(true);
    expect(parseArgs(["--no-color"], KNOWN).flags.get("color")).toBe(false);
  });

  it("rejects typos instead of ignoring them", () => {
    expect(() => parseArgs(["--brnach", "dev"], KNOWN)).toThrow(UsageError);
  });

  it("rejects a value-taking option with no value", () => {
    expect(() => parseArgs(["--branch"], KNOWN)).toThrow(UsageError);
    expect(() => parseArgs(["--branch", "--json"], KNOWN)).toThrow(UsageError);
  });

  it("rejects a non-numeric count", () => {
    expect(() => getNumber(parseArgs(["--runs", "many"], KNOWN), "runs")).toThrow(UsageError);
  });
});

describe("parseRepoSlug", () => {
  it("accepts slugs, URLs and .git suffixes", () => {
    expect(parseRepoSlug("vercel/next.js")).toEqual({ owner: "vercel", repo: "next.js" });
    expect(parseRepoSlug("https://github.com/vercel/next.js")).toEqual({ owner: "vercel", repo: "next.js" });
    expect(parseRepoSlug("https://github.com/vercel/next.js.git")).toEqual({ owner: "vercel", repo: "next.js" });
  });

  it("rejects anything that is not owner/repo", () => {
    expect(() => parseRepoSlug("next.js")).toThrow();
  });
});

describe("nextPageUrl", () => {
  it("picks the next link and ignores the others", () => {
    const header =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(nextPageUrl(header)?.searchParams.get("page")).toBe("2");
  });

  it("returns null on the last page", () => {
    expect(nextPageUrl('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
  });
});

describe("formatting", () => {
  it("shows at most two units", () => {
    expect(duration(45_000)).toBe("45s");
    expect(duration(724_000)).toBe("12m 04s");
    expect(duration(4_020_000)).toBe("1h 07m");
    expect(duration(Number.NaN)).toBe("—");
  });

  it("formats money at a sane precision", () => {
    expect(usd(0.482)).toBe("$0.482");
    expect(usd(3.2)).toBe("$3.20");
    expect(usd(482.4)).toBe("$482");
  });

  it("rounds percentages", () => {
    expect(percent(0.615)).toBe("62%");
  });
});
