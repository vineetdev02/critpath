#!/usr/bin/env node
import { createRequire } from "node:module";

import { parseArgs, UsageError } from "./args.js";
import { ANALYZE_FLAGS, analyzeCommand } from "./commands/analyze.js";
import { GitHubError } from "./github/client.js";
import { c } from "./render/ansi.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const GLOBAL_FLAGS = { help: "boolean", version: "boolean" } as const;

const HELP = `${c.bold("critpath")} — find out why your CI is slow

${c.bold("Usage")}
  critpath [owner/repo] [options]

  With no repository, critpath reads the GitHub remote of the current directory.

${c.bold("Options")}
  --branch <name>     Branch to analyze            (default: repo default branch)
  --all-branches      Analyze runs from every branch
  --workflow <name>   Workflow file or name        (default: the busiest one)
  --runs <n>          How many runs to sample      (default: 20, max 100)
  --run <id>          Analyze one specific run id
  --event <name>      Filter by trigger, e.g. push, pull_request
  --all               Show every job in the waterfall, not just the slowest
  --json              Machine-readable output
  --no-color          Disable colour
  --token <token>     GitHub token (default: $GITHUB_TOKEN, $GH_TOKEN, or gh CLI)
  --help, --version

${c.bold("Examples")}
  critpath                                  ${c.dim("# this repo, default branch")}
  critpath vercel/next.js --runs 50
  critpath my-org/api --branch develop --workflow ci.yml
  critpath my-org/api --json > ci.json
`;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { ...GLOBAL_FLAGS, ...ANALYZE_FLAGS });

  if (args.flags.get("version") === true) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (args.flags.get("help") === true) {
    process.stdout.write(HELP);
    return 0;
  }

  return analyzeCommand(args);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof GitHubError) {
      process.stderr.write(`${c.red("GitHub:")} ${error.message}\n`);
      process.exitCode = 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${c.red("Error:")} ${message}\n`);
    if (process.env.CRITPATH_DEBUG && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  });
