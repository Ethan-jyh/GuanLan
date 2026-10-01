import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildReportInput } from '../src/reporting/input.js';
import { IRValidator } from '../src/reporting/ir-validator.js';
import { FinalChecker } from '../src/reporting/artifacts.js';
import { ResearchRole, DecisionType } from '../src/contracts/research.js';

describe('Task 6A: Report Input Building, Quality Final-Check, and IR Validation', () => {
  describe('buildReportInput: Explicit Versioning & Cross-run Isolation', () => {
    it('should build report input with explicit research versions and aggregated claims', () => {
      const submissions = {
        [ResearchRole.Authority]: {
          run_id: 'run-rep-1',
          role: ResearchRole.Authority,
          round: 1,
          claims: [{ claim_id: 'c-auth-1', statement: 'Statement 1', evidence_ids: ['e1'], limitations: [] }],
          evidence_pool: [{ evidence_id: 'e1', source_type: 'doc', source_ref: 'ref1', title: 'T', excerpt: 'E', retrieval_time: '2026-10-01', is_full_text: true }],
          authority_finding: { entity_name: 'Gov' },
        },
        [ResearchRole.Feedback]: {
          run_id: 'run-rep-1',
          role: ResearchRole.Feedback,
          round: 2, // Follow-up round 2
          claims: [{ claim_id: 'c-feed-2', statement: 'Statement 2', evidence_ids: ['e2'], limitations: [] }],
          evidence_pool: [{ evidence_id: 'e2', source_type: 'comment', source_ref: 'ref2', title: 'C', excerpt: 'E', retrieval_time: '2026-10-01', is_full_text: false }],
          feedback_finding: { sample_size: 5000 },
        },
      };

      const input = buildReportInput(
        'run-rep-1',
        '汛情应急处置',
        { region: 'City' },
        submissions,
        [{ claim_id: 'c-auth-1', status: 'supported' } as any],
        ['Unresolved issue 1']
      );

      assert.equal(input.run_id, 'run-rep-1');
      assert.equal(input.topic, '汛情应急处置');
      assert.equal(input.research_versions.authority, 1);
      assert.equal(input.research_versions.feedback, 2);
      assert.equal(input.claims.length, 2);
      assert.equal(input.evidence_pool.length, 2);
      assert.equal(input.verifications.length, 1);
    });

    it('should reject foreign run submission if run_id does not match', () => {
      const mismatchedSubmissions = {
        [ResearchRole.Authority]: {
          run_id: 'run-FOREIGN-999',
          role: ResearchRole.Authority,
          round: 1,
          claims: [],
          evidence_pool: [],
        },
      };

      assert.throws(
        () => buildReportInput('run-rep-2', 'Topic', {}, mismatchedSubmissions),
        /foreign run|mismatched run_id/i
      );
    });
  });

  describe('FinalChecker: Provenance Verification & Anti-Slogan Protection', () => {
    const checker = new FinalChecker();

    it('should pass valid judgment with verified provenance', () => {
      const validJudgment = {
        overall_interpretation: '汛情态势平稳可控',
        linked_claim_ids: ['c-1'],
        linked_evidence_ids: ['e-1'],
        risks: [{ point: '早高峰积水', level: '中' }],
        recommendations: [
          {
            target: '交管局',
            action: '于10月1日早6点前统一发布积水路段绕行指引',
          },
        ],
        applicability_conditions: ['降雨不再突增'],
        uncertainties: ['山区地质隐患排查中'],
        alternative_explanations: [],
      };

      const res = checker.checkReportQuality(validJudgment, ['c-1'], ['e-1']);
      assert.equal(res.ok, true);
      assert.equal(res.issues.length, 0);
    });

    it('should detect unverified claims and evidences', () => {
      const unverifiedJudgment = {
        overall_interpretation: '汛情态势',
        linked_claim_ids: ['c-unverified-999'],
        linked_evidence_ids: ['e-unverified-999'],
        risks: [],
        recommendations: [],
        applicability_conditions: ['condition'],
        uncertainties: [],
        alternative_explanations: [],
      };

      const res = checker.checkReportQuality(unverifiedJudgment, ['c-1'], ['e-1']);
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes('c-unverified-999')));
      assert.ok(res.issues.some((i) => i.includes('e-unverified-999')));
    });

    it('should block generic empty slogans in recommendations', () => {
      const sloganJudgment = {
        overall_interpretation: '汛情',
        linked_claim_ids: ['c-1'],
        linked_evidence_ids: ['e-1'],
        risks: [],
        recommendations: [
          {
            target: '部门',
            action: '高度重视，提高思想认识',
          },
        ],
        applicability_conditions: ['condition'],
        uncertainties: [],
        alternative_explanations: [],
      };

      const res = checker.checkReportQuality(sloganJudgment, ['c-1'], ['e-1']);
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes('提高思想认识') || i.includes('口号')));
    });
  });

  describe('IRValidator: Document and Chapter Structure Validation', () => {
    const validator = new IRValidator();

    it('should validate valid chapter IR', () => {
      const validChapter = {
        chapterId: 'ch-01',
        title: '一、基本研判与态势',
        anchor: 'sec-1',
        order: 1,
        blocks: [
          {
            type: 'heading',
            level: 2,
            text: '1. 总体定调',
            anchor: 'sec-1-1',
          },
          {
            type: 'paragraph',
            inlines: [{ text: '根据市应急局发布通报，全市响应有序。', marks: ['bold'] }],
          },
          {
            type: 'table',
            rows: [
              {
                cells: [
                  { blocks: [{ type: 'paragraph', inlines: [{ text: '指标' }] }] },
                  { blocks: [{ type: 'paragraph', inlines: [{ text: '数值' }] }] },
                ],
              },
              {
                cells: [
                  { blocks: [{ type: 'paragraph', inlines: [{ text: '降雨量' }] }] },
                  { blocks: [{ type: 'paragraph', inlines: [{ text: '128mm' }] }] },
                ],
              },
            ],
          },
        ],
      };

      const res = validator.validateChapter(validChapter);
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
    });

    it('should catch missing blocks and invalid block types', () => {
      const invalidChapter = {
        chapterId: 'ch-02',
        title: '二、分析',
        anchor: 'sec-2',
        order: 2,
        blocks: [
          {
            type: 'unknown_block_type_xyz',
          },
        ],
      };

      const res = validator.validateChapter(invalidChapter);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('unknown_block_type_xyz')));
    });
  });
});
