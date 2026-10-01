import { ReportJudgment, Artifact } from '../contracts/artifact.js';

export class FinalChecker {
  public static readonly GENERIC_SLOGANS = [
    '加强舆论引导',
    '提高思想认识',
    '提高防范意识',
    '高度重视',
    '认真对待',
  ];

  public checkReportQuality(
    judgment: ReportJudgment,
    available_claims: string[],
    available_evidences: string[]
  ): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    const knownClaims = new Set(available_claims);
    const knownEvidences = new Set(available_evidences);

    // 1. Claim provenance check
    for (const cid of judgment.linked_claim_ids || []) {
      if (!knownClaims.has(cid)) {
        issues.push(
          `研判引用的主张编号 '${cid}' 未在三方研究主张库中，推断缺乏明确事实依据。`
        );
      }
    }

    // 2. Evidence provenance check
    for (const eid of judgment.linked_evidence_ids || []) {
      if (!knownEvidences.has(eid)) {
        issues.push(
          `研判引用的证据编号 '${eid}' 未在三方研究证据池中，溯源链条断裂。`
        );
      }
    }

    // 3. Block generic empty slogans in recommendations
    for (const rec of judgment.recommendations || []) {
      const target = rec.target || '';
      const action = rec.action || rec.measure || '';
      const combined = `${target} ${action}`.trim();

      for (const slogan of FinalChecker.GENERIC_SLOGANS) {
        if (combined.includes(slogan) && combined.length < 25) {
          issues.push(
            `应对建议包含空泛口号 '${slogan}' 且缺乏具体执行主体与量化动作，未达专报交付标准。`
          );
        }
      }
    }

    // 4. Applicability boundary check
    if (
      (!judgment.applicability_conditions || judgment.applicability_conditions.length === 0) &&
      (!judgment.uncertainties || judgment.uncertainties.length === 0)
    ) {
      issues.push(
        '综合研判未标明适用范围条件或不确定性限制，可能导致决策层泛化理解。'
      );
    }

    return {
      ok: issues.length === 0,
      issues,
    };
  }
}
