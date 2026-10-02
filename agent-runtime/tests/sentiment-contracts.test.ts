import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnalyzeSentimentParamsSchema,
  AnalyzeSentimentResultSchema,
  JevSystemOneResponseSchema,
  verifySentimentConservation,
} from '../src/contracts/sentiment.js';

describe('Task 1: Jev Sentiment Contracts & Validation', () => {
  describe('AnalyzeSentimentParamsSchema', () => {
    it('should validate valid params with target', () => {
      const valid = {
        texts: ['学校应对很迅速', '通报语焉不详'],
        target: '某高校9月30日通报',
        context: '某高校近日发生宿舍事件',
      };
      const parsed = AnalyzeSentimentParamsSchema.parse(valid);
      assert.equal(parsed.target, '某高校9月30日通报');
      assert.equal(parsed.texts.length, 2);
    });

    it('should reject missing target', () => {
      const invalid = {
        texts: ['学校应对很迅速'],
      };
      assert.throws(() => AnalyzeSentimentParamsSchema.parse(invalid), /target/);
    });

    it('should reject empty target string', () => {
      const invalid = {
        texts: ['学校应对很迅速'],
        target: '',
      };
      assert.throws(() => AnalyzeSentimentParamsSchema.parse(invalid), /target/);
    });
  });

  describe('JevSystemOneResponseSchema', () => {
    it('should parse valid Jev systemone response with probabilities', () => {
      const jevResp = {
        model: 'jev-2026-09-preview',
        answers: {
          sentiment: {
            choice: 'positive',
            probabilities: {
              positive: 0.92,
              neutral: 0.05,
              negative: 0.01,
              mixed: 0.01,
              insufficient: 0.01,
            },
            confidence: 0.92,
            rationale: '对通报明确赞同并支持',
          },
        },
        usage: { input_tokens: 120, output_tokens: 35, total_tokens: 155 },
      };

      const parsed = JevSystemOneResponseSchema.parse(jevResp);
      assert.equal(parsed.model, 'jev-2026-09-preview');
      assert.equal(parsed.answers.sentiment.choice, 'positive');
      assert.equal(parsed.answers.sentiment.confidence, 0.92);
    });

    it('should reject invalid choice value', () => {
      const badChoice = {
        model: 'jev-test',
        answers: {
          sentiment: {
            choice: 'somewhat_good',
          },
        },
      };
      assert.throws(() => JevSystemOneResponseSchema.parse(badChoice));
    });
  });

  describe('AnalyzeSentimentResultSchema & Conservation', () => {
    it('should validate complete result and satisfy total conservation', () => {
      const result = {
        status: 'success' as const,
        count: 5,
        denominator: 5,
        classified_count: 3,
        counts: {
          positive: 1,
          neutral: 1,
          negative: 1,
          mixed: 0,
          uncertain: 1,
          error: 0,
          skipped: 1,
        },
        distribution: {
          positive: 0.2,
          neutral: 0.2,
          negative: 0.2,
          mixed: 0.0,
          uncertain: 0.2,
          error: 0.0,
          skipped: 0.2,
        },
        items: [
          { index: 0, text: '赞成', predicted_label: 'positive' as const, final_status: 'classified' as const, confidence: 0.9 },
          { index: 1, text: '已知晓', predicted_label: 'neutral' as const, final_status: 'classified' as const, confidence: 0.8 },
          { index: 2, text: '强烈反对', predicted_label: 'negative' as const, final_status: 'classified' as const, confidence: 0.95 },
          { index: 3, text: '有点难评', predicted_label: 'insufficient' as const, final_status: 'uncertain' as const, confidence: 0.4 },
          { index: 4, text: '', final_status: 'skipped' as const, reason: 'empty text' },
        ],
        model_version: 'jev-latest',
        question_version: 'q-sentiment-v1',
        threshold_version: 'th-default-v1',
        confidence_threshold: 0.65,
      };

      const parsed = AnalyzeSentimentResultSchema.parse(result);
      assert.equal(parsed.count, 5);
      assert.equal(verifySentimentConservation(parsed), true);
      // Backward compatibility: original positive, neutral, negative fields exist
      assert.equal(parsed.distribution.positive, 0.2);
      assert.equal(parsed.distribution.neutral, 0.2);
      assert.equal(parsed.distribution.negative, 0.2);
    });

    it('verifySentimentConservation should detect non-conserved counts', () => {
      const invalidCounts = {
        count: 5,
        counts: {
          positive: 1,
          neutral: 1,
          negative: 1,
          mixed: 0,
          uncertain: 0,
          error: 0,
          skipped: 0, // Sum = 3 != 5
        },
      };
      assert.equal(verifySentimentConservation(invalidCounts as any), false);
    });
  });
});
