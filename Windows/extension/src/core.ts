export const events = ['completed', 'attention', 'blocked', 'error'] as const;
export type Event = typeof events[number];
export const sources = ['codex', 'claude', 'grok', 'gemini', 'copilot', 'test', 'hook'] as const;
export interface Message {
  token: string;
  action: 'notify' | 'focus';
  sessionId: string;
  source?: string;
  event?: Event;
  eventId?: string;
  cwd?: string;
}

export function validMessage(value: unknown, token: string): value is Message {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  if (m.token !== token || typeof m.sessionId !== 'string' || m.sessionId.length > 100) return false;
  if (m.action === 'focus') return true;
  return m.action === 'notify' && events.includes(m.event as Event) &&
    sources.includes(m.source as typeof sources[number]) &&
    (m.cwd === undefined || (typeof m.cwd === 'string' && m.cwd.length < 4096)) &&
    (m.eventId === undefined || (typeof m.eventId === 'string' && m.eventId.length < 256));
}

export class Deduplicator {
  private recent = new Map<string, number>();
  accept(m: Message, now = Date.now()): boolean {
    for (const [key, time] of this.recent) if (now - time > 10000) this.recent.delete(key);
    const key = JSON.stringify([m.sessionId, m.source, m.event, m.eventId || '']);
    if (this.recent.has(key)) return false;
    this.recent.set(key, now);
    return true;
  }
}
