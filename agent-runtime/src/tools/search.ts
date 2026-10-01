import { EvidenceStore } from '../storage/evidence-store.js';

export interface SearchWebParams {
  query: string;
  count?: number;
  freshness?: string;
  run_id?: string;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  published_date?: string;
}

export interface SearchWebResult {
  status: 'success' | 'not_found' | 'error';
  query?: string;
  count?: number;
  results: SearchResultItem[];
  message?: string;
  error?: string;
}

export type SearchBackendFn = (
  query: string,
  count: number,
  freshness?: string
) => Promise<SearchResultItem[]> | SearchResultItem[];

export async function searchWeb(
  params: SearchWebParams,
  evidenceStore?: EvidenceStore,
  searchBackend?: SearchBackendFn
): Promise<SearchWebResult> {
  const query = params.query?.trim();
  if (!query) {
    return {
      status: 'error',
      error: 'Query cannot be empty',
      results: [],
    };
  }

  const count = params.count ?? 5;

  try {
    let rawResults: SearchResultItem[] = [];
    if (searchBackend) {
      rawResults = await searchBackend(query, count, params.freshness);
    } else {
      // Default: check if TAVILY_API_KEY is available in process.env
      const apiKey = process.env.TAVILY_API_KEY;
      if (apiKey) {
        const resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: count,
            topic: 'news',
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as any;
          rawResults = (data.results || []).map((r: any) => ({
            title: r.title || '',
            url: r.url || '',
            snippet: r.content || '',
            published_date: r.published_date,
          }));
        }
      }
    }

    if (!rawResults || rawResults.length === 0) {
      return {
        status: 'not_found',
        query,
        count: 0,
        results: [],
        message: 'No relevant records found for query',
      };
    }

    const normalizedResults: SearchResultItem[] = rawResults.map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.snippet || '',
      published_date: item.published_date,
    }));

    if (params.run_id && evidenceStore) {
      for (const item of normalizedResults) {
        evidenceStore.addEvidence({
          run_id: params.run_id,
          source_type: 'webpage_snippet',
          source_ref: item.url,
          title: item.title,
          excerpt: item.snippet,
          source_date: item.published_date,
          is_full_text: false,
        });
      }
    }

    return {
      status: 'success',
      query,
      count: normalizedResults.length,
      results: normalizedResults,
    };
  } catch (err: any) {
    return {
      status: 'error',
      error: err.message,
      results: [],
    };
  }
}
