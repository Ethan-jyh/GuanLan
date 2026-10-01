export interface QueryCommentsParams {
  post_id_or_keyword: string;
  sample_size?: number;
  sentiment_filter?: string;
}

export interface QueryCommentsResult {
  status: 'success' | 'not_found' | 'error';
  target?: string;
  sample_size: number;
  denominator_info: string;
  comments: any[];
  error?: string;
}

export async function queryComments(
  params: QueryCommentsParams,
  commentsBackend?: (params: QueryCommentsParams) => Promise<any[]> | any[]
): Promise<QueryCommentsResult> {
  const target = params.post_id_or_keyword?.trim();
  if (!target) {
    return {
      status: 'error',
      sample_size: 0,
      denominator_info: '',
      comments: [],
      error: 'post_id_or_keyword cannot be empty',
    };
  }

  const sampleSize = params.sample_size ?? 100;
  let comments: any[] = [];
  if (commentsBackend) {
    comments = await commentsBackend(params);
  }

  return {
    status: 'success',
    target,
    sample_size: sampleSize,
    denominator_info: `抽样于关联的帖子评论池（最高限制 ${sampleSize} 条）`,
    comments,
  };
}

export interface AnalyzeSentimentParams {
  texts: string[];
}

export interface SentimentDistribution {
  positive: number;
  neutral: number;
  negative: number;
}

export interface AnalyzeSentimentResult {
  status: 'success' | 'error';
  count: number;
  distribution: SentimentDistribution;
  error?: string;
}

export async function analyzeSentiment(
  params: AnalyzeSentimentParams
): Promise<AnalyzeSentimentResult> {
  const texts = params.texts || [];
  if (texts.length === 0) {
    return {
      status: 'success',
      count: 0,
      distribution: { positive: 0.0, neutral: 0.0, negative: 0.0 },
    };
  }

  // Heuristic / rule-based or model distribution
  let pos = 0;
  let neg = 0;
  let neu = 0;

  const posWords = ['赞', '好', '支持', '快', '到位', '平稳', '恢复', '给力', '感谢'];
  const negWords = ['慢', '堵', '水灾', '失联', '困', '抱怨', '伤亡', '迟到', '险情', '急'];

  for (const text of texts) {
    const hasPos = posWords.some((w) => text.includes(w));
    const hasNeg = negWords.some((w) => text.includes(w));
    if (hasPos && !hasNeg) pos++;
    else if (hasNeg && !hasPos) neg++;
    else neu++;
  }

  const total = texts.length;
  return {
    status: 'success',
    count: total,
    distribution: {
      positive: Number((pos / total).toFixed(2)),
      neutral: Number((neu / total).toFixed(2)),
      negative: Number((neg / total).toFixed(2)),
    },
  };
}
