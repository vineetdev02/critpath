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

/** Split `owner/repo`, or a full GitHub URL, into its parts. */
export function parseRepoSlug(input: string): { owner: string; repo: string } {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`Expected a repository as "owner/repo", got "${input}"`);
  }
  return { owner: parts[0], repo: parts[1] };
}
