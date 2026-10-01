import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import { EvidenceStore } from '../src/storage/evidence-store.js';
import { LocalToolRegistry } from '../src/tools/registry.js';
import { searchWeb } from '../src/tools/search.js';
import { readSource } from '../src/tools/read-source.js';
import { queryPosts } from '../src/tools/database.js';
import { queryComments, analyzeSentiment } from '../src/tools/feedback.js';
import { getTimeline } from '../src/tools/timeline.js';

describe('Task 5: Local Research Tools & Registry Migration', () => {
  let rawDb: DatabaseSync;
  let db: ResearchDatabase;
  let evidenceStore: EvidenceStore;
  let registry: LocalToolRegistry;

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    evidenceStore = new EvidenceStore(db);
    registry = new LocalToolRegistry(evidenceStore);
  });

  describe('search_web Tool', () => {
    it('should return normalized results and automatically register snippet evidence', async () => {
      const mockSearchBackend = async (query: string, count: number) => {
        return [
          {
            title: '汛情通报：水势平稳',
            url: 'https://gov.example.com/news/1',
            snippet: '最新通报显示水位已回落。',
            published_date: '2026-10-01',
          },
        ];
      };

      const res = await searchWeb(
        { query: '汛情通报', count: 3, run_id: 'run-t5-1' },
        evidenceStore,
        mockSearchBackend
      );

      assert.equal(res.status, 'success');
      assert.equal(res.count, 1);
      assert.equal(res.results[0].title, '汛情通报：水势平稳');

      // Evidence should have been registered as snippet (is_full_text = false)
      const evidence = evidenceStore.listEvidence('run-t5-1');
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].is_full_text, false);
      assert.equal(evidence[0].source_ref, 'https://gov.example.com/news/1');
    });

    it('should return not_found when no results match', async () => {
      const emptyBackend = async () => [];
      const res = await searchWeb(
        { query: '生僻词不可能匹配' },
        evidenceStore,
        emptyBackend
      );
      assert.equal(res.status, 'not_found');
      assert.equal(res.results.length, 0);
    });

    it('should reject empty query with error', async () => {
      const res = await searchWeb({ query: '   ' });
      assert.equal(res.status, 'error');
    });
  });

  describe('read_source Tool', () => {
    it('should fetch full text and mark evidence as full_text', async () => {
      const mockFetchBackend = async (url: string) => {
        return '【通告正文】经各部门抢险，辖区内所有受阻干道已全部恢复通车。';
      };

      const res = await readSource(
        { url_or_ref: 'https://gov.example.com/notice/1', run_id: 'run-t5-2' },
        evidenceStore,
        mockFetchBackend
      );

      assert.equal(res.status, 'success');
      assert.equal(res.is_full_text, true);
      assert.ok(res.content?.includes('恢复通车'));

      // Check evidence stored with is_full_text = true
      const evidence = evidenceStore.listEvidence('run-t5-2');
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].is_full_text, true);
    });

    it('should return not_found if content cannot be fetched', async () => {
      const mockFetch = async () => null;
      const res = await readSource(
        { url_or_ref: 'https://broken.example.com/404' },
        evidenceStore,
        mockFetch
      );
      assert.equal(res.status, 'not_found');
    });
  });

  describe('database & query_posts Tool', () => {
    it('should query posts with parameterized filtering and return denominator', async () => {
      const mockQueryBackend = async () => ({
        total_matched: 1200,
        sampled_count: 2,
        posts: [
          { id: 'p1', text: '早高峰路面积水严重', created_at: '2026-10-01' },
          { id: 'p2', text: '排涝队伍到了', created_at: '2026-10-01' },
        ],
      });

      const res = await queryPosts(
        { keyword: '路面积水', platform: 'weibo', limit: 20 },
        mockQueryBackend
      );

      assert.equal(res.status, 'success');
      assert.equal(res.denominator, 1200);
      assert.equal(res.sampled_count, 2);
      assert.equal(res.items.length, 2);
    });
  });

  describe('feedback: query_comments & analyze_sentiment Tools', () => {
    it('should query comments with sample size and denominator info', async () => {
      const res = await queryComments({
        post_id_or_keyword: 'post-1001',
        sample_size: 50,
      });

      assert.equal(res.status, 'success');
      assert.equal(res.sample_size, 50);
      assert.ok(res.denominator_info.includes('50'));
    });

    it('should analyze sentiment distribution', async () => {
      const res = await analyzeSentiment({
        texts: ['抢险迅速点赞', '路面积水什么时候退', '上班迟到了'],
      });

      assert.equal(res.status, 'success');
      assert.equal(res.count, 3);
      assert.ok(res.distribution.positive >= 0);
      assert.ok(res.distribution.neutral >= 0);
      assert.ok(res.distribution.negative >= 0);
    });
  });

  describe('timeline: get_timeline Tool', () => {
    it('should return data_unavailable instead of fabricating timeline when no data exists', async () => {
      const nullBackend = async () => null;
      const res = await getTimeline(
        { topic_keyword: '未监测生僻事件', window: '48h' },
        nullBackend
      );

      assert.equal(res.status, 'data_unavailable');
      assert.ok(res.reason);
    });

    it('should return timeline series when available', async () => {
      const mockSeriesBackend = async () => [
        { time: '2026-09-30T12:00:00Z', index: 1200 },
        { time: '2026-09-30T21:00:00Z', index: 8500 },
      ];

      const res = await getTimeline(
        { topic_keyword: '暴雨', window: '24h' },
        mockSeriesBackend
      );

      assert.equal(res.status, 'success');
      assert.equal(res.series?.length, 2);
    });
  });

  describe('LocalToolRegistry Integration', () => {
    it('should expose tool definitions and execute registered tools locally', async () => {
      const definitions = registry.getToolDefinitions();
      const toolNames = new Set(definitions.map((d) => d.name));

      assert.ok(toolNames.has('search_web'));
      assert.ok(toolNames.has('read_source'));
      assert.ok(toolNames.has('query_posts'));
      assert.ok(toolNames.has('query_comments'));
      assert.ok(toolNames.has('analyze_sentiment'));
      assert.ok(toolNames.has('get_timeline'));

      // Execute via registry
      registry.setSearchBackend(async () => [
        { title: '本地测试标题', url: 'https://test.com', snippet: '正文摘要' },
      ]);

      const result = await registry.executeTool(
        'search_web',
        { query: '测试' },
        { run_id: 'run-reg-1' }
      );

      assert.equal(result.status, 'success');
      assert.equal(result.results[0].title, '本地测试标题');
    });
  });
});
