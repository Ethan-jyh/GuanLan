import { createHash } from 'node:crypto';
import { ResearchDatabase } from './database.js';
import { Evidence } from '../contracts/evidence.js';

export interface AddEvidenceParams {
  run_id: string;
  source_type: string;
  source_ref: string;
  title: string;
  excerpt: string;
  retrieval_time?: string;
  source_date?: string | null;
  is_full_text?: boolean;
  coverage_scope?: Record<string, unknown>;
}

export class EvidenceStore {
  constructor(private db: ResearchDatabase) {}

  public static computeFingerprint(source_ref: string, excerpt: string): string {
    const raw = `${source_ref.trim()}::${excerpt.trim()}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  public addEvidence(params: AddEvidenceParams): Evidence {
    const nowIso = new Date().toISOString();
    const retrievalTime = params.retrieval_time || nowIso;
    const fp = EvidenceStore.computeFingerprint(params.source_ref, params.excerpt);

    // 1. Check existing by fingerprint in this run
    const existing = this.db.raw
      .prepare('SELECT * FROM evidence WHERE run_id = ? AND fingerprint = ?')
      .get(params.run_id, fp) as any;

    if (existing) {
      let scope: Record<string, unknown> | undefined;
      try {
        if (existing.coverage_scope) scope = JSON.parse(existing.coverage_scope);
      } catch {}
      return {
        evidence_id: existing.evidence_id,
        source_type: existing.source_type,
        source_ref: existing.source_ref,
        title: existing.title,
        excerpt: existing.excerpt,
        retrieval_time: existing.retrieval_time,
        source_date: existing.source_date,
        is_full_text: Boolean(existing.is_full_text),
        coverage_scope: scope,
      };
    }

    // 2. Generate new sequential evidence_id for this run: E-001, E-002, etc.
    const countRow = this.db.raw
      .prepare('SELECT COUNT(*) AS cnt FROM evidence WHERE run_id = ?')
      .get(params.run_id) as any;
    const nextNum = (countRow?.cnt || 0) + 1;
    const evidenceId = `E-${String(nextNum).padStart(3, '0')}`;
    const scopeJson = params.coverage_scope ? JSON.stringify(params.coverage_scope) : null;

    this.db.raw
      .prepare(
        `INSERT INTO evidence (
          evidence_id, run_id, fingerprint, source_type, source_ref,
          title, excerpt, retrieval_time, source_date, is_full_text,
          coverage_scope, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidenceId,
        params.run_id,
        fp,
        params.source_type,
        params.source_ref,
        params.title,
        params.excerpt,
        retrievalTime,
        params.source_date || null,
        params.is_full_text ? 1 : 0,
        scopeJson,
        nowIso
      );

    return {
      evidence_id: evidenceId,
      source_type: params.source_type,
      source_ref: params.source_ref,
      title: params.title,
      excerpt: params.excerpt,
      retrieval_time: retrievalTime,
      source_date: params.source_date || null,
      is_full_text: Boolean(params.is_full_text),
      coverage_scope: params.coverage_scope,
    };
  }

  public listEvidence(run_id: string): Evidence[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM evidence WHERE run_id = ? ORDER BY evidence_id ASC')
      .all(run_id) as any[];

    return rows.map((r) => {
      let scope: Record<string, unknown> | undefined;
      try {
        if (r.coverage_scope) scope = JSON.parse(r.coverage_scope);
      } catch {}
      return {
        evidence_id: r.evidence_id,
        source_type: r.source_type,
        source_ref: r.source_ref,
        title: r.title,
        excerpt: r.excerpt,
        retrieval_time: r.retrieval_time,
        source_date: r.source_date,
        is_full_text: Boolean(r.is_full_text),
        coverage_scope: scope,
      };
    });
  }

  public getEvidence(run_id: string, evidence_id: string): Evidence | null {
    const r = this.db.raw
      .prepare('SELECT * FROM evidence WHERE run_id = ? AND evidence_id = ?')
      .get(run_id, evidence_id) as any;

    if (!r) return null;
    let scope: Record<string, unknown> | undefined;
    try {
      if (r.coverage_scope) scope = JSON.parse(r.coverage_scope);
    } catch {}
    return {
      evidence_id: r.evidence_id,
      source_type: r.source_type,
      source_ref: r.source_ref,
      title: r.title,
      excerpt: r.excerpt,
      retrieval_time: r.retrieval_time,
      source_date: r.source_date,
      is_full_text: Boolean(r.is_full_text),
      coverage_scope: scope,
    };
  }
}
