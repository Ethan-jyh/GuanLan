import { EvidenceStore } from '../storage/evidence-store.js';
import type { ResearchToolDefinition } from '../runtime/pi-adapter.js';

import { searchWeb, SearchBackendFn } from './search.js';
import { readSource, FetchBackendFn } from './read-source.js';
import { queryPosts, QueryPostsBackendFn } from './database.js';
import { queryComments, analyzeSentiment, SentimentClassificationProvider } from './feedback.js';
import { getTimeline, TimelineBackendFn } from './timeline.js';

export interface ExecutionContext {
  run_id?: string;
  call_id?: string;
}

export class LocalToolRegistry {
  private searchBackend?: SearchBackendFn;
  private fetchBackend?: FetchBackendFn;
  private queryBackend?: QueryPostsBackendFn;
  private timelineBackend?: TimelineBackendFn;
  private sentimentProvider?: SentimentClassificationProvider;

  constructor(private evidenceStore?: EvidenceStore) {}

  public setSearchBackend(fn: SearchBackendFn) {
    this.searchBackend = fn;
  }

  public setFetchBackend(fn: FetchBackendFn) {
    this.fetchBackend = fn;
  }

  public setQueryBackend(fn: QueryPostsBackendFn) {
    this.queryBackend = fn;
  }

  public setTimelineBackend(fn: TimelineBackendFn) {
    this.timelineBackend = fn;
  }

  public setSentimentProvider(fn: SentimentClassificationProvider) {
    this.sentimentProvider = fn;
  }

  public async executeTool(
    name: string,
    args: any,
    context?: ExecutionContext
  ): Promise<any> {
    const runId = context?.run_id;

    switch (name) {
      case 'search_web':
        return await searchWeb(
          { ...args, run_id: runId },
          this.evidenceStore,
          this.searchBackend
        );
      case 'read_source':
        return await readSource(
          { ...args, run_id: runId },
          this.evidenceStore,
          this.fetchBackend
        );
      case 'query_posts':
        return await queryPosts(args, this.queryBackend);
      case 'query_comments':
        return await queryComments(args);
      case 'analyze_sentiment':
        return await analyzeSentiment(args, {
          provider: this.sentimentProvider,
          parentCallId: context?.call_id,
          runId,
        });
      case 'get_timeline':
        return await getTimeline(args, this.timelineBackend);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  public getToolDefinitions(): ResearchToolDefinition[] {
    return [
      {
        name: 'search_web',
        description: '检索互联网最新新闻、通报及公开网页信息，返回包含标题、链接与摘要的结构化结果',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            count: { type: 'number', description: '返回结果数量，默认 5' },
            freshness: { type: 'string', description: '时间新鲜度' },
          },
          required: ['query'],
        },
        execute: async (args: any, context?: any) => {
          return await this.executeTool('search_web', args, context);
        },
      },
      {
        name: 'read_source',
        description: '深度抓取并阅读目标网页或通报的完整正文，保留证据溯源',
        parameters: {
          type: 'object',
          properties: {
            url_or_ref: { type: 'string', description: '目标来源 URL 或材料引用地址' },
            extract_summary: { type: 'boolean', description: '是否提取摘要' },
          },
          required: ['url_or_ref'],
        },
        execute: async (args: any, context?: any) => {
          return await this.executeTool('read_source', args, context);
        },
      },
      {
        name: 'query_posts',
        description: '按关键词与时间窗口安全检索社媒发帖，输出分母基数与去重抽样',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '检索关键词' },
            platform: { type: 'string', description: '社交平台名称' },
            start_time: { type: 'string', description: '起始时间' },
            end_time: { type: 'string', description: '截止时间' },
            limit: { type: 'number', description: '抽样上限' },
          },
          required: ['keyword'],
        },
        execute: async (args: any, context?: any) => {
          return await this.executeTool('query_posts', args, context);
        },
      },
      {
        name: 'query_comments',
        description: '抽样查询关联评论并返回分母说明，支持分层情感分析',
        parameters: {
          type: 'object',
          properties: {
            post_id_or_keyword: { type: 'string', description: '帖子ID或话题' },
            sample_size: { type: 'number', description: '抽样数量' },
            sentiment_filter: { type: 'string', description: '情感极性过滤' },
          },
          required: ['post_id_or_keyword'],
        },
        execute: async (args: any, context?: any) => {
          return await this.executeTool('query_comments', args, context);
        },
      },
      {
        name: 'analyze_sentiment',
        description: '对批量文本集合执行针对指定评价目标（target）的情感分类统计（支持 positive, neutral, negative, mixed, uncertain），并返回置信度与严格样本分母',
        parameters: {
          type: 'object',
          properties: {
            texts: {
              type: 'array',
              items: { type: 'string' },
              description: '待分析文本列表',
            },
            target: {
              type: 'string',
              description: '明确的评价对象/实体（如特定政策、官方通报、涉事主体等）',
            },
            context: {
              type: 'string',
              description: '可选的事件背景信息，辅助消除指代歧义',
            },
          },
          required: ['texts', 'target'],
        },
        execute: async (args: any, context?: any) => {
          return await this.executeTool('analyze_sentiment', args, context);
        },
      },
      {
        name: 'get_timeline',
        description: '获取话题的时间序列热度趋势与拐点；无数据时返回 data_unavailable 而不捏造',
        parameters: {
          type: 'object',
          properties: {
            topic_keyword: { type: 'string', description: '话题或事件关键词' },
            interval: { type: 'string', description: '时间步长，如 1h, 1d' },
            window: { type: 'string', description: '观测窗口，如 24h, 48h, 7d' },
          },
          required: ['topic_keyword'],
        },
        execute: async (args: any, context?: any) => {
          return await this.executeTool('get_timeline', args, context);
        },
      },
    ];
  }
}
