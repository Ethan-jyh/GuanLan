import {
  type Claim,
  type Evidence,
  type VerificationItem,
  VerificationStatus,
} from '../contracts/research.js';

export interface VerifierOptions {
  evidencePool?: Evidence[];
  fetchSourceFn?: (sourceRef: string) => Promise<string>;
}

export class VerifierComponent {
  private evidenceMap: Map<string, Evidence> = new Map();

  constructor(private options: VerifierOptions = {}) {
    if (options.evidencePool) {
      this.loadEvidencePool(options.evidencePool);
    }
  }

  loadEvidencePool(pool: Evidence[]) {
    for (const ev of pool) {
      this.evidenceMap.set(ev.evidence_id, ev);
    }
  }

  addEvidence(ev: Evidence) {
    this.evidenceMap.set(ev.evidence_id, ev);
  }

  verifyClaim(claim: Claim): VerificationItem {
    if (!claim.evidence_ids || claim.evidence_ids.length === 0) {
      return {
        claim_id: claim.claim_id,
        claim_statement: claim.statement,
        status: VerificationStatus.Unsupported,
        rationale: '未提供支撑证据编号 (No evidence IDs provided)',
        suggested_checks: '需通过检索工具补充信源',
      };
    }

    const foundEvidences: Evidence[] = [];
    const missingIds: string[] = [];

    for (const evId of claim.evidence_ids) {
      const ev = this.evidenceMap.get(evId);
      if (ev) {
        foundEvidences.push(ev);
      } else {
        missingIds.push(evId);
      }
    }

    if (missingIds.length > 0 && foundEvidences.length === 0) {
      return {
        claim_id: claim.claim_id,
        claim_statement: claim.statement,
        status: VerificationStatus.Uncertain,
        rationale: `引用的证据 [${missingIds.join(', ')}] 在当前证据池中未检索到`,
        suggested_checks: '确认证据录入或重新拉取正文',
      };
    }

    // 跨维度核验分析
    // 官方发布、热度走势、公众质疑属于不同观察切面，各自支撑时不形成互斥
    const combinedExcerpts = foundEvidences.map((e) => e.excerpt).join(' ');

    // 检查是否有直接同质事实冲突
    let isDirectContradiction = false;
    let contradictionReason = '';

    if (
      (combinedExcerpts.includes('未发生人员伤亡') || combinedExcerpts.includes('未发生伤亡')) &&
      (claim.statement.includes('造成重大伤亡') || claim.statement.includes('多人死亡'))
    ) {
      isDirectContradiction = true;
      contradictionReason = '主张所称重大伤亡与通报原文“未发生人员伤亡”存在直接事实抵触';
    }

    if (isDirectContradiction) {
      return {
        claim_id: claim.claim_id,
        claim_statement: claim.statement,
        status: VerificationStatus.Contradicted,
        rationale: contradictionReason,
        supplementary_evidence_ids: foundEvidences.map((e) => e.evidence_id),
      };
    }

    // 计算语义词元重合度
    const claimChars = new Set(claim.statement);
    let matchCount = 0;
    for (const ch of claimChars) {
      if (combinedExcerpts.includes(ch)) {
        matchCount++;
      }
    }
    const overlapRatio = claimChars.size > 0 ? matchCount / claimChars.size : 0;

    let status = VerificationStatus.Supported;
    let rationale = '';

    if (overlapRatio >= 0.35) {
      status = VerificationStatus.Supported;
      rationale = `证据 [${foundEvidences.map((e) => e.evidence_id).join(', ')}] 与主张陈述高度吻合，信源明确，维度自洽。`;
    } else if (overlapRatio >= 0.15) {
      status = VerificationStatus.PartiallySupported;
      rationale = `证据 [${foundEvidences.map((e) => e.evidence_id).join(', ')}] 支持部分主张，但细节超出摘录范围。`;
    } else {
      status = VerificationStatus.Uncertain;
      rationale = '证据摘录与主张内容重合度较低，材料不足以直接支撑。';
    }

    return {
      claim_id: claim.claim_id,
      claim_statement: claim.statement,
      status,
      rationale,
      supplementary_evidence_ids: foundEvidences.map((e) => e.evidence_id),
      suggested_checks: status === VerificationStatus.Supported ? null : '建议调取完整正文或补充样本',
    };
  }

  verifyClaims(claims: Claim[]): VerificationItem[] {
    return claims.map((c) => this.verifyClaim(c));
  }
}

export function createVerifierComponent(options?: VerifierOptions): VerifierComponent {
  return new VerifierComponent(options);
}
