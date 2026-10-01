export interface QueryPostsParams {
  keyword: string;
  platform?: string;
  start_time?: string;
  end_time?: string;
  limit?: number;
}

export interface QueryPostsResult {
  status: 'success' | 'not_found' | 'error';
  keyword?: string;
  denominator: number;
  sampled_count: number;
  items: any[];
  error?: string;
}

export type QueryPostsBackendFn = (
  params: QueryPostsParams
) => Promise<{ total_matched: number; sampled_count: number; posts: any[] } | null> | {
  total_matched: number;
  sampled_count: number;
  posts: any[];
} | null;

export async function queryPosts(
  params: QueryPostsParams,
  queryBackend?: QueryPostsBackendFn
): Promise<QueryPostsResult> {
  const keyword = params.keyword?.trim();
  if (!keyword) {
    return {
      status: 'error',
      denominator: 0,
      sampled_count: 0,
      items: [],
      error: 'Keyword cannot be empty',
    };
  }

  try {
    let data = null;
    if (queryBackend) {
      data = await queryBackend(params);
    }

    if (!data || data.total_matched === 0) {
      return {
        status: 'not_found',
        keyword,
        denominator: 0,
        sampled_count: 0,
        items: [],
      };
    }

    return {
      status: 'success',
      keyword,
      denominator: data.total_matched,
      sampled_count: data.sampled_count ?? (data.posts || []).length,
      items: data.posts || [],
    };
  } catch (err: any) {
    return {
      status: 'error',
      keyword,
      denominator: 0,
      sampled_count: 0,
      items: [],
      error: err.message,
    };
  }
}
