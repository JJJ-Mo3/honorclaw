// HonorClaw Tool: Web Search — search the web via Brave Search API
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  query: z.string(),
  max_results: z.number().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface WebSearchCreds {
  api_key: string;
  provider?: string;
  base_url?: string;
}

function getCredentials(): WebSearchCreds {
  const raw = process.env.WEB_SEARCH_CREDENTIALS;
  if (!raw) throw new Error('WEB_SEARCH_CREDENTIALS env var is required');
  return JSON.parse(raw) as WebSearchCreds;
}

createTool(InputSchema, async (input: Input) => {
  const creds = getCredentials();
  const provider = creds.provider ?? 'brave';
  const count = Math.min(input.max_results ?? 10, 20);

  if (provider === 'brave') {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', input.query);
    url.searchParams.set('count', String(count));
    url.searchParams.set('text_decorations', 'false');

    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': creds.api_key,
      },
    });

    if (!res.ok) {
      throw new Error(`Brave Search API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
      query?: { original: string };
    };

    const results = (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));

    return { results, query: data.query?.original ?? input.query };
  }

  // Generic search provider (custom base_url)
  if (creds.base_url) {
    const url = new URL(creds.base_url);
    url.searchParams.set('q', input.query);
    url.searchParams.set('count', String(count));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${creds.api_key}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Search API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      results?: Array<{ title: string; url: string; snippet: string }>;
    };

    return { results: data.results ?? [], query: input.query };
  }

  throw new Error(`Unsupported search provider: ${provider}`);
});
