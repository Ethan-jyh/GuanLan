import { ResearchDatabase } from './database.js';

export interface ResearchEventRecord {
  event_id: number;
  run_id: string;
  event_seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export class EventStore {
  constructor(private db: ResearchDatabase) {}

  public publishEvent(
    run_id: string,
    event_type: string,
    payload: Record<string, unknown>
  ): number {
    const nowIso = new Date().toISOString();
    const payloadJson = JSON.stringify(payload);

    return this.db.transaction(() => {
      const maxRow = this.db.raw
        .prepare('SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM research_events WHERE run_id = ?')
        .get(run_id) as any;
      const nextSeq = maxRow.next_seq as number;

      this.db.raw
        .prepare(
          `INSERT INTO research_events (run_id, event_seq, event_type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(run_id, nextSeq, event_type, payloadJson, nowIso);

      return nextSeq;
    });
  }

  public getEvents(run_id: string, after_seq = 0): ResearchEventRecord[] {
    const rows = this.db.raw
      .prepare(
        `SELECT event_id, run_id, event_seq, event_type, payload_json, created_at
         FROM research_events
         WHERE run_id = ? AND event_seq > ?
         ORDER BY event_seq ASC`
      )
      .all(run_id, after_seq) as any[];

    return rows.map((r) => ({
      event_id: r.event_id,
      run_id: r.run_id,
      event_seq: r.event_seq,
      event_type: r.event_type,
      payload: JSON.parse(r.payload_json),
      created_at: r.created_at,
    }));
  }
}
