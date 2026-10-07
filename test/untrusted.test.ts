import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageError } from "../src/args.js";
import { analyzeRun } from "../src/analyze/build.js";
import { estimateCost } from "../src/analyze/cost.js";
import { buildInsights } from "../src/analyze/insights.js";
import { summarizeRuns } from "../src/analyze/stats.js";
import { parseRepoSlug } from "../src/github/api.js";
import { GitHubClient } from "../src/github/client.js";
import { setColorEnabled } from "../src/render/ansi.js";
import { printable } from "../src/render/format.js";
import { renderMarkdown } from "../src/render/markdown.js";
import { renderReport, type Report } from "../src/render/report.js";
import { makeJob, makeReport, makeRun } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setColorEnabled(false);
});

const ESC = String.fromCharCode(27);

/**
 * Job, step and workflow names are whatever the workflow file says, and on a
 * pull request from a fork that file is the fork's. They reach a maintainer's
 * terminal and a comment posted under the bot's name.
 */
function reportNaming(job: string, step: string, workflowName = "CI"): Report {
  const run = makeRun();
  const jobs = [
    makeJob({ name: job, queued: 0, started: 30, completed: 300, steps: [{ name: step, started: 40, completed: 290 }] }),
  ];
  const analysis = analyzeRun(run, jobs, null);
  return makeReport({
    workflowName,
    runs: [analysis],
    stats: summarizeRuns([analysis]),
    focus: analysis,
    insights: buildInsights(analysis),
    cost: estimateCost([analysis]),
  });
}

describe("printable", () => {
  it("shows control and invisible characters instead of emitting them", () => {
    expect(printable(`a${ESC}[2Jb`)).toBe("a\\u001b[2Jb");
    expect(printable(`te${String.fromCharCode(0x200b)}st`)).toBe("te\\u200bst");
    expect(printable("one\ntwo")).toBe("one two");
    expect(printable("build (ubuntu-latest, 20)")).toBe("build (ubuntu-latest, 20)");
  });
});

describe("the terminal report", () => {
  it("never writes an escape sequence a workflow name carried", () => {
    const out = renderReport(reportNaming(`build${ESC}[2J`, `step${ESC}]0;title${String.fromCharCode(7)}`, `CI${ESC}[31m`));

    expect(out).not.toContain(ESC);
    expect(out).not.toContain(String.fromCharCode(7));
    expect(out).toContain("build\\u001b[2J");
  });
});

describe("the markdown report", () => {
  it("cannot be turned into a link, an image, a mention or HTML by a job name", () => {
    const out = renderMarkdown(
      reportNaming("[Approved](https://evil.example) @acme/admins", "![x](https://evil.example/p.png) <img src=x>"),
    );

    expect(out).not.toContain("[Approved](https://evil.example)");
    expect(out).not.toContain("![x](");
    expect(out).not.toMatch(/(^|[^\w])@acme\b/);
    expect(out).not.toContain("<img");
    expect(out).toContain("@&#8203;acme/admins");
    expect(out).not.toContain("&#&#8203;");
  });

  it("leaves an @ alone where no mention can start", () => {
    const out = renderMarkdown(reportNaming("deploy", "Run actions/checkout@v4"));
    expect(out).toContain("Run actions/checkout@v4");
  });

  it("says one job, not one jobs", () => {
    const out = renderMarkdown(reportNaming("deploy", "step"));
    expect(out).toContain("across 1 job ·");
    expect(renderReport(reportNaming("deploy", "step"))).toContain("across 1 job");
    expect(renderReport(reportNaming("deploy", "step"))).not.toContain("1 jobs");
  });

  it("keeps a backtick in a workflow name inside its code span", () => {
    expect(renderMarkdown(reportNaming("build", "step", "odd`name"))).toContain("``odd`name``");
  });
});

describe("parseRepoSlug", () => {
  it("answers a malformed repository with a usage error, exit 2", () => {
    expect(() => parseRepoSlug("next.js")).toThrow(UsageError);
  });

  it("refuses anything that would leave the repository's own path", () => {
    for (const slug of ["../../user", "owner/..", "owner/repo?per_page=1", "owner/re po", "owner/repo#x"]) {
      expect(() => parseRepoSlug(slug), slug).toThrow(UsageError);
    }
  });

  it("keeps every name GitHub allows", () => {
    expect(parseRepoSlug("my-org/my_repo.v2")).toEqual({ owner: "my-org", repo: "my_repo.v2" });
    expect(parseRepoSlug("octocat_acme/api")).toEqual({ owner: "octocat_acme", repo: "api" });
    expect(parseRepoSlug("https://github.com/vercel/next.js/tree/canary")).toEqual({ owner: "vercel", repo: "next.js" });
  });
});

describe("the API client", () => {
  it("does not send the token to a host the API does not live on", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal("fetch", async (url: URL, init: { headers: Record<string, string> }) => {
      seen.push({ url: String(url), auth: init.headers.Authorization });
      if (seen.length === 1) {
        return new Response(JSON.stringify({ items: [1] }), {
          headers: { "content-type": "application/json", link: '<https://elsewhere.example/page/2>; rel="next"' },
        });
      }
      return Response.json({ items: [2] });
    });

    const client = new GitHubClient({ token: "test-token", baseUrl: "https://api.github.com" });
    await client.paginate("/repos/o/r/actions/runs", {}, (page) => (page as { items: number[] }).items);

    expect(seen[0]?.auth).toBe("Bearer test-token");
    expect(seen[1]?.url).toContain("elsewhere.example");
    expect(seen[1]?.auth).toBeUndefined();
  });
});
