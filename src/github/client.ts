export class GitHubError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.url = url;
  }
}

export interface ClientOptions {
  token: string | null;
  baseUrl?: string;
  /** Max concurrent in-flight requests. */
  concurrency?: number;
}

type Params = Record<string, string | number | undefined>;

export class GitHubClient {
  private readonly token: string | null;
  private readonly baseUrl: string;
  private readonly concurrency: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: ClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
    this.concurrency = options.concurrency ?? 6;
  }

  async request<T>(path: string, params: Params = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await this.fetchWithLimit(url);
    if (!response.ok) throw await this.toError(response, url.toString());
    return (await response.json()) as T;
  }

  /**
   * Follow `Link: rel="next"` until `limit` items are collected. The Actions
   * list endpoints wrap their payload in an envelope, so `extract` pulls the
   * array out of each page.
   */
  async paginate<T>(
    path: string,
    params: Params,
    extract: (page: unknown) => T[],
    limit = Infinity,
  ): Promise<T[]> {
    const perPage = Math.min(100, limit === Infinity ? 100 : Math.max(1, limit));
    let url: URL | null = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set("per_page", String(perPage));

    const collected: T[] = [];
    while (url && collected.length < limit) {
      const response: Response = await this.fetchWithLimit(url);
      if (!response.ok) throw await this.toError(response, url.toString());

      collected.push(...extract(await response.json()));
      url = nextPageUrl(response.headers.get("link"));
    }

    return collected.length > limit ? collected.slice(0, limit) : collected;
  }

  private async fetchWithLimit(url: URL): Promise<Response> {
    await this.acquire();
    try {
      return await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "whyslow",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      });
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  private async toError(response: Response, url: string): Promise<GitHubError> {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if ((response.status === 403 || response.status === 429) && remaining === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const minutes = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60_000)) : null;
      return new GitHubError(
        response.status,
        url,
        `GitHub API rate limit exhausted${minutes ? `, resets in ~${minutes}m` : ""}.` +
          (this.token ? "" : " Set GITHUB_TOKEN to get 5000 requests/hour instead of 60."),
      );
    }

    let detail = "";
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) detail = ` — ${body.message}`;
    } catch {
      // Non-JSON error body; the status alone will have to do.
    }

    if (response.status === 404) {
      return new GitHubError(
        404,
        url,
        `Not found${detail}. Check the repo name, and that your token can read it.`,
      );
    }
    if (response.status === 401) {
      return new GitHubError(401, url, `Token rejected${detail}. It may be expired or missing scopes.`);
    }

    return new GitHubError(response.status, url, `GitHub API returned ${response.status}${detail}`);
  }
}

/** Parse the `next` target out of a GitHub `Link` header. */
export function nextPageUrl(linkHeader: string | null): URL | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match?.[1]) return new URL(match[1]);
  }
  return null;
}
