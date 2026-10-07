import { UsageError } from "../args.js";
import type { GitHubClient } from "./client.js";
import { GitHubError } from "./client.js";
import type { ContentFile, Repo, WorkflowJob, WorkflowRun } from "./types.js";

export interface RunQuery {
  branch?: string;
  event?: string;
  /** Workflow file name (`ci.yml`) or numeric id, when filtering server-side. */
  workflow?: string;
  status?: string;
  limit?: number;
}

export async function getRepo(client: GitHubClient, owner: string, repo: string): Promise<Repo> {
  return client.request<Repo>(`/repos/${owner}/${repo}`);
}

export async function listWorkflowRuns(
  client: GitHubClient,
  owner: string,
  repo: string,
  query: RunQuery = {},
): Promise<WorkflowRun[]> {
  const base = query.workflow
    ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(query.workflow)}/runs`
    : `/repos/${owner}/${repo}/actions/runs`;

  return client.paginate<WorkflowRun>(
    base,
    { branch: query.branch, event: query.event, status: query.status ?? "completed" },
    (page) => (page as { workflow_runs?: WorkflowRun[] }).workflow_runs ?? [],
    query.limit ?? 20,
  );
}

export async function getRun(
  client: GitHubClient,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowRun> {
  return client.request<WorkflowRun>(`/repos/${owner}/${repo}/actions/runs/${runId}`);
}

export async function listRunJobs(
  client: GitHubClient,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowJob[]> {
  return client.paginate<WorkflowJob>(
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
    { filter: "latest" },
    (page) => (page as { jobs?: WorkflowJob[] }).jobs ?? [],
  );
}

/**
 * Fetch a workflow file at a specific commit. Returns null when the file no
 * longer exists at that ref, which happens routinely on older runs.
 */
export async function getWorkflowSource(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const file = await client.request<ContentFile>(
      `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
      { ref },
    );
    if (file.encoding !== "base64") return null;
    return Buffer.from(file.content, "base64").toString("utf8");
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The characters GitHub allows in an account or repository name — underscores
 * included, which enterprise-managed accounts use — and never a name that is
 * only dots, which a URL would resolve as a path segment.
 */
const NAME = /^(?!\.+$)[A-Za-z0-9_.-]+$/;

/**
 * Split `owner/repo`, or a full GitHub URL, into its parts.
 *
 * A malformed repository is the caller's typo, so it is a usage error (exit 2)
 * rather than a failure to run. And both parts are checked before they go
 * anywhere near a URL: `../..` or `repo?x=` would otherwise be resolved into a
 * different request, carrying the token with it.
 */
export function parseRepoSlug(input: string): { owner: string; repo: string } {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const [owner, repo] = cleaned.split("/").filter(Boolean);
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) {
    throw new UsageError(`Expected a repository as "owner/repo", got "${input}".`);
  }
  return { owner, repo };
}
