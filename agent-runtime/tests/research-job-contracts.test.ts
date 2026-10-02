import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ResearchRole,
  TaskStatus,
  TaskSchema,
  parseTask,
} from '../src/contracts/task.js';
import {
  ResearchJobParamsSchema,
  TaskReceiptSchema,
  ResearchOutcomeSchema,
  HostInboxEventSchema,
  ReleaseRequestSchema,
  parseResearchJobParams,
  parseTaskReceipt,
  parseResearchOutcome,
  parseHostInboxEvent,
  parseReleaseRequest,
} from '../src/contracts/research-job.js';

describe('Task 1: Research Job, Receipt, Outcome & Host Event Contracts', () => {
  describe('ResearchJobParamsSchema', () => {
    it('should validate valid parameters with all fields', () => {
      const valid = {
        question: '核对地铁恢复运营通告和退票安排的正式原文',
        scope: { region: '示例城市', time_window: '最近48小时' },
        completion_criteria: '提供通告正文来源，并列出已明确和未明确的退票事项',
        requested_budget_units: 12,
        required_for_report: true,
      };

      const parsed = parseResearchJobParams(valid);
      assert.equal(parsed.question, valid.question);
      assert.deepEqual(parsed.scope, valid.scope);
      assert.equal(parsed.completion_criteria, valid.completion_criteria);
      assert.equal(parsed.requested_budget_units, 12);
      assert.equal(parsed.required_for_report, true);
    });

    it('should provide default values for optional fields', () => {
      const minimal = {
        question: '验证公众关切与情绪分布',
        completion_criteria: '完成抽样并输出极性统计',
      };

      const parsed = parseResearchJobParams(minimal);
      assert.equal(parsed.question, minimal.question);
      assert.deepEqual(parsed.scope, {});
      assert.equal(parsed.required_for_report, true);
      assert.ok(typeof parsed.requested_budget_units === 'number');
    });

    it('should reject missing question', () => {
      const invalid = {
        completion_criteria: '完成标准',
      };
      assert.throws(() => parseResearchJobParams(invalid), /question/i);
    });

    it('should reject empty question', () => {
      const invalid = {
        question: '',
        completion_criteria: '完成标准',
      };
      assert.throws(() => parseResearchJobParams(invalid), /question/i);
    });

    it('should reject missing completion_criteria', () => {
      const invalid = {
        question: '有效问题',
      };
      assert.throws(() => parseResearchJobParams(invalid), /completion_criteria/i);
    });

    it('should reject negative requested_budget_units', () => {
      const invalid = {
        question: '有效问题',
        completion_criteria: '完成标准',
        requested_budget_units: -5,
      };
      assert.throws(() => parseResearchJobParams(invalid));
    });
  });

  describe('TaskReceiptSchema', () => {
    it('should validate accepted receipt with task_id, attempt_id, role, result_pending: true', () => {
      const accepted = {
        status: 'accepted',
        task_id: 'task-auth-001',
        attempt_id: 'attempt-auth-001-1',
        role: ResearchRole.Authority,
        result_pending: true,
      };

      const parsed = parseTaskReceipt(accepted);
      assert.equal(parsed.status, 'accepted');
      if (parsed.status === 'accepted') {
        assert.equal(parsed.task_id, 'task-auth-001');
        assert.equal(parsed.attempt_id, 'attempt-auth-001-1');
        assert.equal(parsed.role, ResearchRole.Authority);
        assert.equal(parsed.result_pending, true);
      }
    });

    it('should validate rejected receipt with reason and result_pending: false', () => {
      const rejected = {
        status: 'rejected',
        reason: 'Budget quota exceeded for run',
        result_pending: false,
      };

      const parsed = parseTaskReceipt(rejected);
      assert.equal(parsed.status, 'rejected');
      if (parsed.status === 'rejected') {
        assert.equal(parsed.reason, 'Budget quota exceeded for run');
        assert.equal(parsed.result_pending, false);
      }
    });

    it('should strictly reject status "succeeded" to prevent premature completion claims', () => {
      const fakeReceipt = {
        status: 'succeeded',
        task_id: 'task-auth-001',
        attempt_id: 'attempt-1',
        role: 'authority',
        result_pending: false,
      };

      assert.throws(() => parseTaskReceipt(fakeReceipt));
    });

    it('should reject accepted receipt with missing task_id or attempt_id', () => {
      const missingAttempt = {
        status: 'accepted',
        task_id: 'task-auth-001',
        role: 'authority',
        result_pending: true,
      };
      assert.throws(() => parseTaskReceipt(missingAttempt));
    });

    it('should reject accepted receipt if result_pending is false', () => {
      const invalidPending = {
        status: 'accepted',
        task_id: 'task-auth-001',
        attempt_id: 'attempt-1',
        role: 'authority',
        result_pending: false,
      };
      assert.throws(() => parseTaskReceipt(invalidPending));
    });
  });

  describe('ResearchOutcomeSchema', () => {
    it('should support succeeded, partial, failed, timed_out, cancelled statuses', () => {
      const statuses = ['succeeded', 'partial', 'failed', 'timed_out', 'cancelled'] as const;

      for (const status of statuses) {
        const outcome = {
          run_id: 'run-001',
          task_id: 'task-001',
          attempt_id: 'attempt-001-1',
          execution_version: 1,
          role: ResearchRole.Evolution,
          status,
          summary: `Task ended with ${status}`,
          usage: {
            tool_attempts: 2,
            model_tokens: 1500,
          },
          completed_at: new Date().toISOString(),
        };

        const parsed = parseResearchOutcome(outcome);
        assert.equal(parsed.status, status);
        assert.equal(parsed.execution_version, 1);
        assert.equal(parsed.attempt_id, 'attempt-001-1');
        assert.equal(parsed.usage.tool_attempts, 2);
      }
    });

    it('should require immutable execution_version, attempt_id, and usage', () => {
      const base = {
        run_id: 'run-001',
        task_id: 'task-001',
        role: ResearchRole.Feedback,
        status: 'succeeded',
        completed_at: new Date().toISOString(),
      };

      // Missing execution_version
      assert.throws(() => parseResearchOutcome({ ...base, attempt_id: 'att-1', usage: { tool_attempts: 1 } }));

      // Missing attempt_id
      assert.throws(() => parseResearchOutcome({ ...base, execution_version: 1, usage: { tool_attempts: 1 } }));

      // Missing usage
      assert.throws(() => parseResearchOutcome({ ...base, execution_version: 1, attempt_id: 'att-1' }));
    });

    it('should validate error details when outcome is failed or timed_out', () => {
      const failedOutcome = {
        run_id: 'run-001',
        task_id: 'task-001',
        attempt_id: 'att-01',
        execution_version: 1,
        role: ResearchRole.Authority,
        status: 'failed',
        error: {
          code: 'SOURCE_UNREACHABLE',
          message: 'Target government portal returned 503',
          retryable: true,
        },
        usage: { tool_attempts: 3 },
        completed_at: new Date().toISOString(),
      };

      const parsed = parseResearchOutcome(failedOutcome);
      assert.equal(parsed.status, 'failed');
      assert.ok(parsed.error);
      assert.equal(parsed.error.code, 'SOURCE_UNREACHABLE');
      assert.equal(parsed.error.retryable, true);
    });

    it('should reject invalid status such as queued or pending in outcome', () => {
      const invalid = {
        run_id: 'run-001',
        task_id: 'task-001',
        attempt_id: 'att-01',
        execution_version: 1,
        role: ResearchRole.Authority,
        status: 'queued',
        usage: { tool_attempts: 0 },
        completed_at: new Date().toISOString(),
      };

      assert.throws(() => parseResearchOutcome(invalid));
    });
  });

  describe('HostInboxEventSchema', () => {
    it('should validate all valid event types: research_outcome, task_timeout, host_help_requested, release_requested', () => {
      const validTypes = [
        'research_outcome',
        'task_timeout',
        'host_help_requested',
        'release_requested',
      ] as const;

      for (const event_type of validTypes) {
        const evt = {
          event_id: `evt-${event_type}-001`,
          run_id: 'run-001',
          task_id: 'task-001',
          event_type,
          payload: { detail: 'test-payload' },
          created_at: new Date().toISOString(),
        };

        const parsed = parseHostInboxEvent(evt);
        assert.equal(parsed.event_type, event_type);
        assert.equal(parsed.run_id, 'run-001');
        assert.equal(parsed.event_id, `evt-${event_type}-001`);
      }
    });

    it('should reject invalid event types', () => {
      const invalid = {
        event_id: 'evt-invalid',
        run_id: 'run-001',
        event_type: 'unknown_event_type',
        payload: {},
      };

      assert.throws(() => parseHostInboxEvent(invalid));
    });

    it('should reject missing event_id or run_id', () => {
      assert.throws(() =>
        parseHostInboxEvent({
          run_id: 'run-001',
          event_type: 'research_outcome',
        })
      );
      assert.throws(() =>
        parseHostInboxEvent({
          event_id: 'evt-001',
          event_type: 'research_outcome',
        })
      );
    });
  });

  describe('ReleaseRequestSchema', () => {
    it('should validate valid release request and provide defaults', () => {
      const req = {
        rationale: '所有必要三方研究结论均已形成不可变快照，可以放行',
        allowed_gaps: ['evolution missing 2026-09-29 data point due to API limit'],
        restricted: true,
      };

      const parsed = parseReleaseRequest(req);
      assert.equal(parsed.rationale, req.rationale);
      assert.deepEqual(parsed.allowed_gaps, req.allowed_gaps);
      assert.equal(parsed.restricted, true);
      assert.deepEqual(parsed.unresolved_issues, []);
      assert.equal(parsed.target_format, 'docx');
    });

    it('should accept empty object and populate defaults', () => {
      const parsed = parseReleaseRequest({});
      assert.equal(parsed.restricted, false);
      assert.deepEqual(parsed.allowed_gaps, []);
      assert.deepEqual(parsed.unresolved_issues, []);
      assert.equal(parsed.target_format, 'docx');
    });
  });

  describe('TaskStatus and TaskSchema Extensions in task.ts', () => {
    it('should support new TaskStatus values (queued, running, succeeded, partial, failed, timed_out, cancelled)', () => {
      assert.equal(TaskStatus.Queued, 'queued');
      assert.equal(TaskStatus.Running, 'running');
      assert.equal(TaskStatus.Succeeded, 'succeeded');
      assert.equal(TaskStatus.Partial, 'partial');
      assert.equal(TaskStatus.Failed, 'failed');
      assert.equal(TaskStatus.TimedOut, 'timed_out');
      assert.equal(TaskStatus.Cancelled, 'cancelled');
    });

    it('should maintain backward compatibility with legacy TaskStatus values (pending, submitted)', () => {
      assert.equal(TaskStatus.Pending, 'pending');
      assert.equal(TaskStatus.Submitted, 'submitted');
    });

    it('should validate TaskSchema with generation, completion_criteria, required_for_report, dependencies, superseded_by', () => {
      const taskData = {
        task_id: 'task-gen-002',
        run_id: 'run-001',
        role: ResearchRole.Authority,
        round: 1,
        question: '核查官方通报',
        generation: 2,
        completion_criteria: '必须包含省级以上官方通报',
        required_for_report: true,
        dependencies: ['task-gen-001'],
        superseded_by: null,
        status: TaskStatus.Queued,
        created_at: new Date().toISOString(),
      };

      const parsed = parseTask(taskData);
      assert.equal(parsed.generation, 2);
      assert.equal(parsed.completion_criteria, '必须包含省级以上官方通报');
      assert.equal(parsed.required_for_report, true);
      assert.deepEqual(parsed.dependencies, ['task-gen-001']);
      assert.equal(parsed.superseded_by, null);
      assert.equal(parsed.status, TaskStatus.Queued);
    });

    it('should provide sensible defaults for new fields on legacy task payloads', () => {
      const legacyPayload = {
        task_id: 'task-legacy-001',
        run_id: 'run-001',
        role: ResearchRole.Feedback,
        round: 1,
        question: '公众反馈调研',
        status: TaskStatus.Pending,
        created_at: new Date().toISOString(),
      };

      const parsed = parseTask(legacyPayload);
      assert.equal(parsed.generation, 1);
      assert.equal(parsed.completion_criteria, '');
      assert.equal(parsed.required_for_report, true);
      assert.deepEqual(parsed.dependencies, []);
      assert.equal(parsed.superseded_by, undefined);
    });
  });
});
