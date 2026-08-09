import { execFileSync } from "node:child_process";

/**
 * Resolve a GitHub token without asking the user to configure anything:
 * explicit flag -> environment -> the `gh` CLI's stored credentials.
 */
export function resolveToken(explicit?: string): string | null {
  if (explicit?.trim()) return explicit.trim();

  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv?.trim()) return fromEnv.trim();

  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    if (out.trim()) return out.trim();
  } catch {
    // gh is not installed, or the user is not logged in. Fall through.
  }

  return null;
}

export const TOKEN_HINT =
  "No GitHub token found — running unauthenticated (60 requests/hour, public repos only). " +
  "Set GITHUB_TOKEN or run `gh auth login` for the full 5000/hour.";
