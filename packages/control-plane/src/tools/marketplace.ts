/**
 * GitHub-based tool marketplace for HonorClaw.
 *
 * Discovers tools by searching GitHub for repositories tagged with the
 * `honorclaw-tool` topic. No hosted index — queries GitHub API directly.
 */

export interface MarketplaceTool {
  /** GitHub repository full name (owner/repo). */
  fullName: string;
  /** Repository URL. */
  url: string;
  /** Repository description. */
  description: string;
  /** Star count. */
  stars: number;
  /** Last release tag, or null if no releases. */
  lastRelease: string | null;
  /** Last release published date, or null. */
  lastReleaseDate: string | null;
  /** Repository topics/tags. */
  topics: string[];
  /** Primary language. */
  language: string | null;
  /** Last updated timestamp. */
  updatedAt: string;
  /** License identifier (e.g., 'MIT'). */
  license: string | null;
}

export interface MarketplaceSearchOptions {
  /** Search query to filter tools (searches in name + description). */
  query?: string;
  /** Sort order. */
  sort?: 'stars' | 'updated' | 'relevance';
  /** Maximum number of results (default: 30, max: 100). */
  limit?: number;
  /** Page number for pagination (1-based). */
  page?: number;
  /** Optional GitHub personal access token for higher rate limits. */
  githubToken?: string;
}

export interface MarketplaceSearchResult {
  tools: MarketplaceTool[];
  totalCount: number;
  page: number;
  hasMore: boolean;
}

/**
 * Search the GitHub-based HonorClaw tool marketplace.
 *
 * Uses the GitHub Search API to find repositories with the `honorclaw-tool` topic.
 */
export async function searchMarketplace(
  options: MarketplaceSearchOptions = {},
): Promise<MarketplaceSearchResult> {
  const {
    query = '',
    sort = 'stars',
    limit = 30,
    page = 1,
    githubToken,
  } = options;

  const perPage = Math.min(limit, 100);

  // Build the GitHub search query
  const searchParts = ['topic:honorclaw-tool'];
  if (query.trim()) {
    searchParts.push(query.trim());
  }
  const searchQuery = searchParts.join(' ');

  // Map our sort options to GitHub API sort parameter
  const githubSort = sort === 'relevance' ? undefined : sort;
  const githubOrder = sort === 'relevance' ? undefined : 'desc';

  const url = new URL('https://api.github.com/search/repositories');
  url.searchParams.set('q', searchQuery);
  if (githubSort) url.searchParams.set('sort', githubSort);
  if (githubOrder) url.searchParams.set('order', githubOrder);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(page));

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'HonorClaw-CLI',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  const response = await fetch(url.toString(), { headers });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `GitHub API error (${response.status}): ${errorBody}`,
    );
  }

  const data = await response.json() as {
    total_count: number;
    items: Array<{
      full_name: string;
      html_url: string;
      description: string | null;
      stargazers_count: number;
      topics: string[];
      language: string | null;
      updated_at: string;
      license: { spdx_id: string } | null;
    }>;
  };

  // Fetch latest release for each tool (in parallel, with error tolerance)
  const tools = await Promise.all(
    data.items.map(async (repo): Promise<MarketplaceTool> => {
      let lastRelease: string | null = null;
      let lastReleaseDate: string | null = null;

      try {
        const releaseRes = await fetch(
          `https://api.github.com/repos/${repo.full_name}/releases/latest`,
          { headers },
        );
        if (releaseRes.ok) {
          const release = await releaseRes.json() as {
            tag_name: string;
            published_at: string;
          };
          lastRelease = release.tag_name;
          lastReleaseDate = release.published_at;
        }
      } catch {
        // No releases or rate limited — skip
      }

      return {
        fullName: repo.full_name,
        url: repo.html_url,
        description: repo.description ?? '',
        stars: repo.stargazers_count,
        lastRelease,
        lastReleaseDate,
        topics: repo.topics,
        language: repo.language,
        updatedAt: repo.updated_at,
        license: repo.license?.spdx_id ?? null,
      };
    }),
  );

  return {
    tools,
    totalCount: data.total_count,
    page,
    hasMore: page * perPage < data.total_count,
  };
}

/**
 * Get details for a specific tool from the marketplace.
 */
export async function getMarketplaceTool(
  fullName: string,
  githubToken?: string,
): Promise<MarketplaceTool | null> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'HonorClaw-CLI',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  const repoRes = await fetch(
    `https://api.github.com/repos/${fullName}`,
    { headers },
  );

  if (!repoRes.ok) {
    if (repoRes.status === 404) return null;
    throw new Error(`GitHub API error (${repoRes.status})`);
  }

  const repo = await repoRes.json() as {
    full_name: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
    topics: string[];
    language: string | null;
    updated_at: string;
    license: { spdx_id: string } | null;
  };

  // Verify it has the honorclaw-tool topic
  if (!repo.topics.includes('honorclaw-tool')) {
    return null;
  }

  let lastRelease: string | null = null;
  let lastReleaseDate: string | null = null;

  try {
    const releaseRes = await fetch(
      `https://api.github.com/repos/${fullName}/releases/latest`,
      { headers },
    );
    if (releaseRes.ok) {
      const release = await releaseRes.json() as {
        tag_name: string;
        published_at: string;
      };
      lastRelease = release.tag_name;
      lastReleaseDate = release.published_at;
    }
  } catch {
    // No releases
  }

  return {
    fullName: repo.full_name,
    url: repo.html_url,
    description: repo.description ?? '',
    stars: repo.stargazers_count,
    lastRelease,
    lastReleaseDate,
    topics: repo.topics,
    language: repo.language,
    updatedAt: repo.updated_at,
    license: repo.license?.spdx_id ?? null,
  };
}
