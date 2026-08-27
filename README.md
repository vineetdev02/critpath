# critpath

[![npm version](https://img.shields.io/npm/v/critpath?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/critpath)
[![CI](https://github.com/vineetdev02/critpath/actions/workflows/ci.yml/badge.svg)](https://github.com/vineetdev02/critpath/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/critpath?color=5fa04e&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/critpath?color=blue)](./LICENSE)

**Find out why your CI is slow.** Waterfall, critical path, queue time and cost for GitHub Actions — in your terminal, in about five seconds, with no signup and no server.

Everyone knows CI takes 22 minutes. Almost nobody knows *which* 22 minutes. The Actions tab shows you a list of jobs and their durations, which is the one view that cannot answer the question — because a job that takes 6 minutes in parallel with an 8-minute job costs you nothing.

`critpath` answers it directly: here is the chain of jobs that decided your wall time, here is how much of it was spent waiting rather than running, and here is the work you are paying for twenty times over.

```
npx critpath
```

## What you get

```
critpath  vitest-dev/vitest   CI  ·  main  ·  last 2 runs
  also in this repo: Lock Closed Issues, CR, Knip — use --workflow to switch

  Wall time       p50 7m 32s     p90 8m 13s
  Compute         p50 1h 14m     9.8× parallel across 21 jobs
  Critical path   p50 5m 43s     76% of wall time
  Waiting         p50 1m 49s     queueing for runners and `needs:` hops
  Billable        85 min / run   free — public repo on GitHub-hosted runners

Critical path  run #23782  ·  7m 19s running + 1m 04s waiting = 8m 23s
   1  Diff: node-latest, ubuntu-latest        7s  ░ 31s waiting
   2  Test: e2e, node-24, macos-latest    6m 08s  ░ 30s waiting
   3  Merge Reports                       1m 04s

Waterfall  run #23782  ·  8m 23s  ·  failure  ·  2d ago
  ░ queued   █ running   ▸ on critical path

  Lint: node-latest, ubuntu-lat…    █████████████                                             1m 57s
▸ Diff: node-latest, ubuntu-lat…    █                                                             7s
  Browsers: shard 2/2, node-24,…     ██████████████████████                                   3m 16s
  Test: e2e, node-26, ubuntu-la…     ███████████████████████████████                          4m 30s
  Test: unit, node-26, ubuntu-l…     ███████████████████                                      2m 48s
  Browsers: shard 1/2, node-24,…     ░█████████████████████████                               3m 51s
  Browsers: runner, node-24, wi…     ░█████████████████████████████                           4m 24s
  Test: vite@7, browser, node-2…     ░███████████████████                                     2m 51s
  Browsers: rest 1/2, node-24, …     ░███████████████████████████████████                     5m 15s
  Test: coverage, node-26, ubun…     ░██████████████████████████                              4m 00s
  Test: e2e, node-24, windows-l…     ░███████████████████████████████████████████             6m 32s
  Browsers: rest 2/2, node-24, …     ░█████████████████████████████████████████               6m 10s
  Test: unit, node-24, windows-…     ░██████████████                                          2m 10s
  Test: vite@7, e2e, node-24, u…     ░████████████████████████████████████                    5m 30s
  Test: coverage, node-24, wind…     ░█████████████████████████████████████                   5m 35s
  Test: coverage, node-24, ubun…     ░██████████████████████                                  3m 19s
  Test: e2e, node-22, ubuntu-la…     ░█████████████████████████████████                       4m 58s
  Test: e2e, node-24, ubuntu-la…     ░███████████████████████████████                         4m 33s
  Test: unit, node-24, ubuntu-l…     ░█████████████████████                                   3m 09s
▸ Test: e2e, node-24, macos-lat…     ░░░░█████████████████████████████████████████            6m 08s
▸ Merge Reports                                                                   ███████     1m 04s
                                 0s────────────────────────────────────────────────8m 23s

Slowest steps  across all jobs in this run
  Test                         5m 20s   Test: e2e, node-24, win…
  Test                         5m 04s   Test: e2e, node-24, mac…
  Test Browser (playwright)    4m 45s   Browsers: rest 2/2, nod…

What to fix
  ● "Build" repeats in 20 jobs
    5m 14s of compute across the run. If the output is the same everywhere, do it once and
    pass it downstream with upload-artifact — or check that actions/cache is hitting.
    ~4m 53s of compute
  ● "Test" is 69% of the critical path
    5m 04s in job "Test: e2e, node-24, macos-latest". This one step is the single biggest
    lever on wall time.
  ● 13% of wall time is waiting, not running
    1m 04s on the critical path was spent queueing for a runner or waiting on `needs:`.
    More concurrency or fewer dependency hops fixes this, not faster code.
    ~1m 04s off wall time
  ● 18 jobs finish with time to spare
    74m 48s of compute that ends well before the run does. Speeding these up costs effort
    and saves zero wall time — they are already free.
```

## Install

Nothing to install:

```bash
npx critpath                       # this repo, from its git remote
npx critpath vitest-dev/vitest     # any public repo
```

Or keep it around:

```bash
npm install -g critpath
```

Requires Node 20+.

### Token

Public repos work with no token at all (GitHub allows 60 requests/hour). For private repos, or to get the full 5000 requests/hour, `critpath` picks up a token from — in order — `--token`, `$GITHUB_TOKEN`, `$GH_TOKEN`, or the `gh` CLI if you are already logged in. Nothing is stored, and no data leaves your machine: `critpath` talks to `api.github.com` and nothing else.

## The four numbers that matter

|                   | what it means                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| **Wall time**     | How long a developer actually waits. The only number your team feels.                            |
| **Compute**       | Sum of every job's runtime. What you are billed for. Usually 5-10× wall time, and that is fine.  |
| **Critical path** | The chain of jobs that determined wall time. Optimising anything else changes nothing.           |
| **Waiting**       | Time on that chain when nothing was running — runner queue, `needs:` hops. Free to reclaim.      |

The gap between *compute* and *critical path* is the useful one. In the run above, 1h 14m of compute produced 8m 23s of wall time, of which only 7m 19s was real work on the blocking chain. Eighteen of the twenty-one jobs could get 30% slower without a developer noticing.

## Options

```
critpath [owner/repo] [options]

  --branch <name>     Branch to analyze            (default: repo default branch)
  --all-branches      Analyze runs from every branch
  --workflow <name>   Workflow file or name        (default: the busiest one)
  --runs <n>          How many runs to sample      (default: 20, max 100)
  --run <id>          Analyze one specific run id
  --event <name>      Filter by trigger, e.g. push, pull_request
  --all               Show every job in the waterfall, not just the slowest
  --budget <time>     Wall-time budget, e.g. 10m, 90s, 1h30m
  --check             Exit 1 when p50 wall time is over --budget
  --markdown          GitHub-flavoured markdown, for a pull request comment
  --json              Machine-readable output
  --no-color          Disable colour
  --token <token>     GitHub token
  --help, --version
```

Repos usually have several workflows, so `critpath` picks the one consuming the most time and names the rest. Percentiles come from the sampled runs; the waterfall and the fix list come from the most recent one.

```bash
critpath my-org/api --branch develop --runs 50
critpath my-org/api --workflow ci.yml --event pull_request
critpath my-org/api --json | jq '.stats.wallP50'
critpath my-org/api --markdown >> "$GITHUB_STEP_SUMMARY"
```

## Budgets

Reading a waterfall is a thing you do once. A budget is a thing that runs forever:

```yaml
- run: npx critpath --check --budget 10m
```

`--budget` accepts `10m`, `90s`, `1h30m`, `250ms`, or a bare number, which reads as minutes. It is checked against **p50 wall time across the sampled runs**, not the newest run — one unlucky build should not turn a pipeline red, and "CI takes 22 minutes" was always a claim about the middle of the distribution.

`--budget` on its own prints the verdict and exits 0. `--check` is what makes it a gate.

```
  OVER BUDGET  p50 wall time 12m 14s is 2m 14s over 10m 00s
```

| code | meaning |
| --- | --- |
| `0` | clean |
| `1` | over budget, with `--check` |
| `2` | bad usage |
| `3` | could not run — no repo, no runs, API error |

## In CI

`--check --budget` decides whether the build goes red. `--markdown` is what makes the number
visible to whoever has to fix it — the critical path, the slowest steps and the fix list, as a
pull request comment that updates itself instead of stacking up:

```yaml
name: critpath

on:
  schedule:
    - cron: "0 6 * * 1" # Monday morning, on the week's runs
  workflow_dispatch:

permissions:
  contents: read
  actions: read # critpath reads the runs and jobs of this repo
  pull-requests: write

jobs:
  critpath:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx critpath ${{ github.repository }} --markdown > critpath.md
        env:
          GITHUB_TOKEN: ${{ github.token }}
      - run: cat critpath.md >> "$GITHUB_STEP_SUMMARY"
```

The markdown carries a `<!-- critpath -->` marker, so `gh pr comment --edit-last` finds the
previous comment and replaces it rather than posting a new one on every push.

`--markdown` leaves out the waterfall on purpose: it is an ANSI bar chart that needs a known
terminal width, and a table of the jobs that actually decided wall time says the same thing in
a comment without pretending to be a picture.

## How the critical path is found

The GitHub API gives you jobs and timings but never the dependency graph, so `critpath` reads the workflow file at the commit each run was built from and parses its `needs:` declarations. Matching API job names back to workflow jobs is the fiddly part — a matrix job arrives as `Test (20, ubuntu-latest)` and a reusable-workflow job as `Release / build` — so matching narrows from exact, to de-decorated, to longest literal prefix, which keeps `Test: vite@7, …` from being confused with `Test: …`.

From there it walks back from the last job to finish, always taking the upstream job that finished latest, and splits each hop into *running* and *waiting*.

When the workflow file is unreadable at that commit — deleted, renamed, private submodule — it falls back to inferring blockers from timings and says so in the output. That fallback is a guess; the `needs:`-based path is not.

## Cost estimates

Private repos get a dollar figure using GitHub's published standard-runner rates ($0.008/min Linux, $0.016 Windows, $0.08 macOS), with each job rounded up to a whole minute the way GitHub bills. Runner platform is read from job labels. Larger runners cost more than this assumes, so treat the number as a floor. Public repos show billable minutes and no dollars, because GitHub-hosted minutes are free there.

## Why not just read the Actions tab

The Actions tab is a list. Lists are the wrong shape for a parallel graph: they invite you to optimise the slowest job, which is usually not the blocking one, and they hide queue time entirely. `critpath` is the same data arranged so the answer is visible.

Hosted products (Depot, Trunk, BuildPulse) do this and much more, behind a signup and a bill. `critpath` does the one thing, locally, free, and prints it.

## Roadmap

- A packaged GitHub Action, so the workflow above is one line instead of ten
- Comparing a pull request against its base branch ("this PR added 3m to CI")
- Per-job budgets, not just a whole-pipeline one
- Cache hit-rate analysis from run logs
- Trend history across weeks, not just the sampled window
- Suggested `needs:` graph rewrites with predicted wall-time savings

Issues and PRs welcome — especially real workflows where the critical path comes out wrong. That is the part worth getting exactly right.

## Development

```bash
npm install
npm test          # 32 tests, no network
npm run build
node dist/cli.js owner/repo
```

No runtime dependencies beyond a YAML parser.

## License

MIT
