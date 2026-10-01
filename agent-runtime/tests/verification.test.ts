import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHostAgent } from '../src/agents/host.js';
import { createVerifierComponent } from '../src/agents/verifier.js';
import { createDelegateResearchTool } from '../src/tools/delegate-research.js';
import { createScriptedStreamFn } from '../src/runtime/pi-adapter.js';
import {
  type Claim,
  type Evidence,
  VerificationStatus,
} from '../src/contracts/research.js';

describe('Task 7: HOST Planning and Claim Verification', () => {
  describe('HostAgent Task Planning and Delegation', () => {
    it('should plan and dispatch 3 subagent tasks via delegate_research without busy loop', async () => {
      let delegatedTasks: any[] = [];

      const delegateTool = createDelegateResearchTool(async (tasks) => {
        delegatedTasks = tasks;
        return {
          ok: true,
          handles: tasks.map((t, i) => ({
            taskId: `task-${t.role}-${i + 1}`,
            role: t.role,
            status: 'dispatched',
          })),
        };
      });

      const streamFn = createScriptedStreamFn([
        {
          toolCalls: [
            {
              name: 'delegate_research',
              arguments: {
                tasks: [
                  {
                    role: 'authority',
                    question: '查证官方通报发文字号与定调演化',
                    budget_allocated: 12,
                    completion_criteria: '获取完整通报原文并核对发文字号',
                  },
                  {
                    role: 'evolution',
                    question: '提取发布前后社媒热度曲线与拐点',
                    budget_allocated: 10,
                    completion_criteria: '输出含时间窗口的连续指标离散点',
                  },
                  {
                    role: 'feedback',
                    question: '抽样网民评论并统计情绪诉求分布',
                    budget_allocated: 12,
                    completion_criteria: '样本量不少于100且标明分母说明',
                  },
                ],
              },
            },
          ],
        },
        {
          text: '3项研究任务已全部成功规划并下发，系统正等待三方汇合屏障信号。',
        },
      ]);

      const host = createHostAgent({
        delegateTool,
        streamFn,
      });

      const result = await host.run('启动关于某市强对流暴雨应急通报的多角度研判');

      assert.equal(delegatedTasks.length, 3);
      assert.equal(delegatedTasks[0].role, 'authority');
      assert.equal(delegatedTasks[1].role, 'evolution');
      assert.equal(delegatedTasks[2].role, 'feedback');
      assert.ok(result.finalText.includes('等待三方汇合屏障'));
    });
  });

  describe('VerifierComponent Multi-dimensional Coexistence', () => {
    it('should evaluate official statement, heat drop, and comment skepticism as supported without false contradiction', () => {
      const verifier = createVerifierComponent();

      const evAuth: Evidence = {
        evidence_id: 'E-AUTH-01',
        source_type: 'official_doc',
        source_ref: 'https://gov.example.com/notices/101',
        title: '市应急管理局通报',
        excerpt: '市应急管理局发布通报，称抢险工作平稳有序，未发生人员伤亡。',
        retrieval_time: '2026-10-01T10:00:00Z',
        is_full_text: true,
      };

      const evEvo: Evidence = {
        evidence_id: 'E-EVO-01',
        source_type: 'db_record',
        source_ref: 'db://metrics/hotness_series',
        title: '全网发帖热度走势',
        excerpt: '官方通报发布2小时后，社媒相关发帖热度显著下降，从峰值1.2万条骤降至1800条。',
        retrieval_time: '2026-10-01T10:05:00Z',
        is_full_text: true,
      };

      const evFeed: Evidence = {
        evidence_id: 'E-FEED-01',
        source_type: 'comment_sample',
        source_ref: 'db://comments/sample_300',
        title: '网民评论随机抽样',
        excerpt: '抽样300条评论中，有28%网民对抢修工期与隐患排查细节表达质疑与担忧。',
        retrieval_time: '2026-10-01T10:10:00Z',
        is_full_text: true,
      };

      verifier.loadEvidencePool([evAuth, evEvo, evFeed]);

      const claims: Claim[] = [
        {
          claim_id: 'C-AUTH',
          statement: '市应急管理局通报称抢险有序且未发生人员伤亡',
          evidence_ids: ['E-AUTH-01'],
          limitations: [],
        },
        {
          claim_id: 'C-EVO',
          statement: '通报发布后社媒发帖热度显著下降',
          evidence_ids: ['E-EVO-01'],
          limitations: [],
        },
        {
          claim_id: 'C-FEED',
          statement: '抽样中部分网民对抢修工期与排查细节表达质疑',
          evidence_ids: ['E-FEED-01'],
          limitations: [],
        },
      ];

      const results = verifier.verifyClaims(claims);

      assert.equal(results.length, 3);
      for (const res of results) {
        assert.equal(
          res.status,
          VerificationStatus.Supported,
          `Claim ${res.claim_id} should be supported, but got ${res.status}: ${res.rationale}`
        );
      }
    });

    it('should identify direct factual contradiction on identical dimension', () => {
      const verifier = createVerifierComponent({
        evidencePool: [
          {
            evidence_id: 'E-AUTH-01',
            source_type: 'official_doc',
            source_ref: 'https://gov.example.com/notices/101',
            title: '官方通报',
            excerpt: '经核实，抢险过程中未发生人员伤亡。',
            retrieval_time: '2026-10-01T10:00:00Z',
            is_full_text: true,
          },
        ],
      });

      const conflictingClaim: Claim = {
        claim_id: 'C-CONFLICT',
        statement: '事故已造成重大伤亡，多人死亡',
        evidence_ids: ['E-AUTH-01'],
        limitations: [],
      };

      const result = verifier.verifyClaim(conflictingClaim);
      assert.equal(result.status, VerificationStatus.Contradicted);
      assert.ok(result.rationale.includes('抵触') || result.rationale.includes('冲突'));
    });

    it('should mark claim with missing evidence as Uncertain and claim with empty evidence as Unsupported', () => {
      const verifier = createVerifierComponent({ evidencePool: [] });

      const missingEvidenceClaim: Claim = {
        claim_id: 'C-MISSING',
        statement: '某官方机构声称已排查完毕',
        evidence_ids: ['E-NONEXISTENT'],
        limitations: [],
      };

      const noEvidenceClaim: Claim = {
        claim_id: 'C-NO-EV',
        statement: '没有任何证据的主张',
        evidence_ids: [],
        limitations: [],
      };

      const resMissing = verifier.verifyClaim(missingEvidenceClaim);
      assert.equal(resMissing.status, VerificationStatus.Uncertain);

      const resNo = verifier.verifyClaim(noEvidenceClaim);
      assert.equal(resNo.status, VerificationStatus.Unsupported);
    });
  });
});
