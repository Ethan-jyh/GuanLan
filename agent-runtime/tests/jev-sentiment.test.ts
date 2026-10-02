import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSentiment } from '../src/tools/feedback.js';
import { verifySentimentConservation } from '../src/contracts/sentiment.js';

describe('Task 3: Jev Batch Sentiment Aggregation', () => {
  it('should return error when target is missing', async () => {
    const res = await analyzeSentiment({
      texts: ['服务很赞'],
      // target omitted
    });
    assert.equal(res.status, 'error');
    assert.ok(res.error?.includes('target'));
  });

  it('should return error without silent keyword fallback when no API key or provider is present', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const res = await analyzeSentiment({
      texts: ['好评', '差评'],
      target: '某服务',
    });
    assert.equal(res.status, 'error');
    assert.ok(res.error?.includes('TYPESAFE_API_KEY'));
    assert.equal(res.counts.error, 2);
  });

  it('should classify batch items and maintain original index order and total conservation', async () => {
    const mockProvider = async (params: { text: string; target: string }) => {
      if (params.text.includes('悲喜交加')) {
        return {
          ok: true,
          choice: 'mixed' as const,
          confidence: 0.8,
          actualModel: 'jev-test',
          questionVersion: 'q1',
          attempts: 1,
        };
      } else if (params.text.includes('满意')) {
        return {
          ok: true,
          choice: 'positive' as const,
          confidence: 0.9,
          actualModel: 'jev-test',
          questionVersion: 'q1',
          attempts: 1,
        };
      } else if (params.text.includes('慢')) {
        return {
          ok: true,
          choice: 'negative' as const,
          confidence: 0.85,
          actualModel: 'jev-test',
          questionVersion: 'q1',
          attempts: 1,
        };
      } else if (params.text.includes('无关话题')) {
        return {
          ok: true,
          choice: 'insufficient' as const,
          confidence: 0.9,
          actualModel: 'jev-test',
          questionVersion: 'q1',
          attempts: 1,
        };
      } else {
        return {
          ok: true,
          choice: 'neutral' as const,
          confidence: 0.75,
          actualModel: 'jev-test',
          questionVersion: 'q1',
          attempts: 1,
        };
      }
    };

    const inputTexts = [
      '整体服务非常满意', // 0: positive
      '排队速度太慢了',   // 1: negative
      '态度好但效率慢，悲喜交加', // 2: mixed
      '今天星期五，无关话题',   // 3: insufficient -> uncertain
      '正常办理了业务',   // 4: neutral
      '   ',             // 5: skipped
    ];

    const res = await analyzeSentiment(
      { texts: inputTexts, target: '窗口政务服务' },
      { provider: mockProvider }
    );

    assert.equal(res.count, 6);
    assert.equal(res.denominator, 6);
    assert.equal(verifySentimentConservation(res), true);

    // Verify index alignment
    assert.equal(res.items[0].index, 0);
    assert.equal(res.items[0].predicted_label, 'positive');
    assert.equal(res.items[0].final_status, 'classified');

    assert.equal(res.items[1].index, 1);
    assert.equal(res.items[1].predicted_label, 'negative');

    assert.equal(res.items[2].index, 2);
    assert.equal(res.items[2].predicted_label, 'mixed');
    assert.equal(res.items[2].final_status, 'classified');

    assert.equal(res.items[3].index, 3);
    assert.equal(res.items[3].predicted_label, 'insufficient');
    assert.equal(res.items[3].final_status, 'uncertain');

    assert.equal(res.items[4].index, 4);
    assert.equal(res.items[4].predicted_label, 'neutral');

    assert.equal(res.items[5].index, 5);
    assert.equal(res.items[5].final_status, 'skipped');

    // Counts
    assert.equal(res.counts.positive, 1);
    assert.equal(res.counts.negative, 1);
    assert.equal(res.counts.mixed, 1);
    assert.equal(res.counts.neutral, 1);
    assert.equal(res.counts.uncertain, 1);
    assert.equal(res.counts.skipped, 1);
  });

  it('should map low confidence predictions to uncertain rather than neutral', async () => {
    const mockProvider = async () => ({
      ok: true,
      choice: 'positive' as const,
      confidence: 0.45, // < threshold 0.65
      actualModel: 'jev-test',
      questionVersion: 'q1',
      attempts: 1,
    });

    const res = await analyzeSentiment(
      { texts: ['模棱两可的话'], target: '某提案' },
      { provider: mockProvider, confidenceThreshold: 0.65 }
    );

    assert.equal(res.counts.positive, 0);
    assert.equal(res.counts.neutral, 0);
    assert.equal(res.counts.uncertain, 1);
    assert.equal(res.items[0].final_status, 'uncertain');
    assert.equal(res.items[0].predicted_label, 'positive');
  });

  it('should handle partial provider failure and report error item without crashing', async () => {
    let callIdx = 0;
    const mockProvider = async (p: { text: string }) => {
      callIdx++;
      if (p.text === '故障文本') {
        throw new Error('Jev API 500 error');
      }
      return {
        ok: true,
        choice: 'positive' as const,
        confidence: 0.9,
        actualModel: 'jev-test',
        questionVersion: 'q1',
        attempts: 1,
      };
    };

    const res = await analyzeSentiment(
      { texts: ['好评', '故障文本'], target: '测试目标' },
      { provider: mockProvider }
    );

    assert.equal(res.status, 'partial');
    assert.equal(res.counts.positive, 1);
    assert.equal(res.counts.error, 1);
    assert.equal(res.items[1].final_status, 'error');
    assert.ok(res.items[1].reason?.includes('Jev API 500 error'));
    assert.equal(verifySentimentConservation(res), true);
  });
});
