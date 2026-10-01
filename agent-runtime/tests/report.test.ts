import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReportAgent, createSubmitJudgmentTool } from '../src/agents/report.js';
import { createScriptedStreamFn } from '../src/runtime/pi-adapter.js';
import type { ReportJudgment } from '../src/contracts/research.js';

describe('Task 9: Report Agent Synthesis and Judgment', () => {
  it('should synthesize multi-role research and submit a valid ReportJudgment', async () => {
    let submittedJudgment: ReportJudgment | null = null;

    const submitJudgmentTool = createSubmitJudgmentTool(async (judgment) => {
      submittedJudgment = judgment;
      return { ok: true };
    });

    const streamFn = createScriptedStreamFn([
      {
        toolCalls: [
          {
            name: 'submit_judgment',
            arguments: {
              judgment: {
                overall_interpretation:
                  '本次极端天气应急处置总体迅速，官方权威定调明确，全网热度快速回落，但受影响区域群众对复工复课及抢险工期透明度仍有集中诉求。',
                risks: [
                  {
                    risk_id: 'R1',
                    title: '次生排期透明度风险',
                    description: '抢修工期若不透明可能引发第二轮舆情次生发酵',
                    severity: '中',
                  },
                ],
                recommendations: [
                  {
                    rec_id: 'A1',
                    title: '每日定时公布抢修进度日历',
                    action: '应急管理部门联动交通部门每日9点与17点公布分路段抢通预计时间',
                    target_risk: 'R1',
                  },
                ],
                linked_claim_ids: ['C-AUTH-01', 'C-EVO-01', 'C-FEED-01'],
                linked_evidence_ids: ['E-AUTH-01', 'E-EVO-01', 'E-FEED-01'],
                applicability_conditions: ['暴雨核心影响区与沿线交通网'],
                alternative_explanations: [],
                uncertainties: ['后续强对流天气持续时间尚存在气象观测不确定性'],
              },
            },
          },
        ],
      },
      {
        text: '综合研判结论已生成并成功提交，专报章节已完成装订。',
      },
    ]);

    const reportAgent = createReportAgent({
      submitJudgmentTool,
      streamFn,
    });

    const result = await reportAgent.run('基于三方已核验成果开展综合情报研判');

    assert.ok(submittedJudgment, 'Judgment must be submitted');
    const j = submittedJudgment as ReportJudgment;
    assert.equal(j.risks.length, 1);
    assert.equal(j.recommendations.length, 1);
    assert.equal(j.linked_claim_ids.length, 3);
    assert.equal(j.linked_evidence_ids.length, 3);
    assert.ok(result.finalText.includes('专报章节已完成装订'));
  });
});
