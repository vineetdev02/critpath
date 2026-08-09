/** Subset of the GitHub Actions REST API we actually consume. */

export interface Repo {
  full_name: string;
  default_branch: string;
  /** Public repos get unlimited free Actions minutes, so cost is reported differently. */
  private: boolean;
}

export interface WorkflowRun {
  id: number;
  name: string | null;
  workflow_id: number;
  /** Path of the workflow file, e.g. `.github/workflows/ci.yml`. */
  path: string;
  head_branch: string | null;
  head_sha: string;
  event: string;
  status: string | null;
  conclusion: string | null;
  run_number: number;
  run_attempt: number;
  created_at: string;
  /** Present on most runs; falls back to `created_at` when absent. */
  run_started_at?: string;
  updated_at: string;
  html_url: string;
}

export interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkflowJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** When the job entered the queue. */
  created_at: string;
  /** When a runner actually picked the job up. */
  started_at: string;
  completed_at: string | null;
  steps?: WorkflowStep[];
  labels: string[];
  runner_name: string | null;
  html_url: string | null;
}

export interface ContentFile {
  content: string;
  encoding: string;
}
