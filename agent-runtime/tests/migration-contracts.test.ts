import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRun,
  RunStatus,
} from '../src/contracts/run.js';
import {
  parseTask,
  TaskStatus,
} from '../src/contracts/task.js';
import {
  parseEvidence,
  parseClaim,
  validateClaimEvidenceIsolation,
} from '../src/contracts/evidence.js';
import {
  parseHostReviewDecision,
  DecisionType,
} from '../src/contracts/review.js';
import {
  parseArtifact,
  parseReportJudgment,
} from '../src/contracts/artifact.js';
import {
  ResearchRole,
  VerificationStatus,
  validateResearchFixture,
} from '../src/contracts/research.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Task 1: TypeScript Migration Contracts and Validation', () => {
  const fixturePath = resolve(__dirname, '../../../contracts/fixtures/research-v1.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

  describe('Run Contract (run.ts)', () => {
    it('should parse and validate a valid research run', () => {
      const run = parseRun(fixture.run);
      assert.equal(run.run_id, 'run-20261001-001');
      assert.equal(run.status, RunStatus.Approved);
      assert.equal(run.current_round, 1);
      assert.equal(run.execution_version, 1);
    });

    it('should reject round exceeding 3', () => {
      const invalid = { ...fixture.run, current_round: 4 };
      assert.throws(() => parseRun(invalid), /Round cannot exceed 3|current_round/);
    });

    it('should provide default execution_version for historical records', () => {
      const legacyRun = { ...fixture.run };
      delete legacyRun.execution_version;
      const parsed = parseRun(legacyRun);
      assert.equal(parsed.execution_version, 1);
    });
  });

  describe('Task Contract (task.ts)', () => {
    it('should parse and validate task list', () => {
      assert.ok(fixture.tasks.length >= 3);
      for (const t of fixture.tasks) {
        const parsed = parseTask(t);
        assert.ok(parsed.task_id);
        assert.ok(Object.values(ResearchRole).includes(parsed.role));
      }
    });

    it('should reject invalid role in task', () => {
      const invalidTask = { ...fixture.tasks[0], role: 'unknown_scout' };
      assert.throws(() => parseTask(invalidTask), /Invalid role|role/);
    });
  });

  describe('Evidence & Claim Contract (evidence.ts)', () => {
    it('should parse evidence and claims', () => {
      const ev = parseEvidence(fixture.results[0].evidence_pool[0]);
      assert.equal(ev.evidence_id, 'E-AUTH-01');

      const claim = parseClaim(fixture.results[0].claims[0]);
      assert.equal(claim.claim_id, 'C-AUTH-01');
    });

    it('should detect cross-run or missing evidence references', () => {
      const claim = parseClaim(fixture.results[0].claims[0]);
      const availableIds = new Set(['E-OTHER-999']);

      const check = validateClaimEvidenceIsolation(claim, availableIds);
      assert.equal(check.valid, false);
      assert.ok(check.missing.includes('E-AUTH-01'));
    });
  });

  describe('Review Contract (review.ts)', () => {
    it('should parse review decision with directives', () => {
      const decision = parseHostReviewDecision(fixture.host_decisions[0]);
      assert.equal(decision.decision, DecisionType.Approve);
      assert.equal(decision.round, 1);
      assert.equal(decision.directives.length, 0);

      const reviseDecision = parseHostReviewDecision({
        task_id: 'task-review-002',
        round: 2,
        decision: 'revise',
        rationale: 'Need more feedback',
        directives: [
          {
            directive_id: 'dir-01',
            target_role: ResearchRole.Feedback,
            related_claim_or_issue: 'issue-1',
            question: 'More samples',
            suggested_action: 'Sample again',
            completion_criteria: 'N >= 5000',
          },
        ],
        unresolved_issues: [],
      });
      assert.equal(reviseDecision.decision, DecisionType.Revise);
      assert.equal(reviseDecision.directives.length, 1);
    });

    it('should prohibit revise decision in round 3 (mandatory convergence)', () => {
      const invalidR3 = {
        ...fixture.host_decisions[0],
        round: 3,
        decision: 'revise',
      };
      assert.throws(
        () => parseHostReviewDecision(invalidR3),
        /Round 3 cannot issue revise|mandatory convergence/
      );
    });
  });

  describe('Artifact & Judgment Contract (artifact.ts)', () => {
    it('should parse report judgment and artifact', () => {
      const judgment = parseReportJudgment(fixture.report_judgment);
      assert.ok(judgment.overall_interpretation);
      assert.equal(judgment.risks.length, 1);

      const artifact = parseArtifact(fixture.artifact);
      assert.equal(artifact.artifact_id, 'art-20261001-001');
      assert.equal(artifact.final_check_passed, true);
    });
  });

  describe('Backward Compatibility in research.ts', () => {
    it('validateResearchFixture should remain backward compatible', () => {
      const bundle = validateResearchFixture(fixture);
      assert.equal(bundle.run.run_id, 'run-20261001-001');
      assert.equal(bundle.results.length, 3);
    });
  });
});
