import { ServerResponse } from 'node:http';
import { EventStore } from '../storage/event-store.js';

export interface SseClient {
  res: ServerResponse;
  run_id: string;
}

export class SseManager {
  private clients = new Set<SseClient>();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(private eventStore?: EventStore) {
    this.startHeartbeat();
  }

  public handleSseConnection(
    run_id: string,
    res: ServerResponse,
    after_seq = 0
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const client: SseClient = { res, run_id };
    this.clients.add(client);

    // 1. Send backlog events
    if (this.eventStore) {
      const pastEvents = this.eventStore.getEvents(run_id, after_seq);
      for (const ev of pastEvents) {
        this.writeSseEvent(res, ev.event_seq, ev.event_type, ev.payload);
      }
    }

    // 2. Initial heartbeat
    res.write(': connected\n\n');

    res.on('close', () => {
      this.clients.delete(client);
    });
  }

  public broadcast(run_id: string, event_seq: number, event_type: string, payload: any): void {
    for (const client of this.clients) {
      if (client.run_id === run_id) {
        this.writeSseEvent(client.res, event_seq, event_type, payload);
      }
    }
  }

  private writeSseEvent(res: ServerResponse, id: number, event: string, data: any): void {
    res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.res.write(': heartbeat\n\n');
        } catch {
          this.clients.delete(client);
        }
      }
    }, 15000);
    // Do not hold process open
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  public close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {}
    }
    this.clients.clear();
  }
}
