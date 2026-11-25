import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FileTail } from '../sources/tail';
import type { Office } from '../model/office';
import type { SourceInfo, AgentStatus } from '../../shared/types';

const ACTIVE_WINDOW = 30 * 60_000;
const EVENTS = new Set(['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop']);

// The existing agy bridge records turn lifecycle, but has neither a project path nor a session-end event.
export class AgyBridge {
  private readonly tail: FileTail;
  private readonly seen = new Map<string, number>();
  private readonly recent = new Map<string, number>();
  private scanAt = -Infinity;
  private brainAvailable = false;
  constructor(
    path: string,
    private readonly brain: string,
    private readonly office: Office,
  ) {
    this.tail = new FileTail(path);
    this.tail.seekTail(2 * 1024 * 1024);
  }

  poll(now: number): SourceInfo {
    let ok = false;
    let error: string | undefined;
    try {
      const result = this.tail.read();
      ok = !result.missing;
      if (!ok) error = 'Bridge log missing';
      for (const [index, line] of result.lines.entries()) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (!ev || !EVENTS.has(ev.event) || typeof ev.conv !== 'string' || !ev.conv || ev.conv.length > 200) continue;
        const at = Date.parse(ev.ts);
        if (!Number.isFinite(at) || at < now - ACTIVE_WINDOW || at > now + 60_000) continue;
        const id = 'agy:' + ev.conv;
        if (at < (this.seen.get(id) ?? 0)) continue;
        const working =
          ['PreInvocation', 'PreToolUse', 'PostToolUse'].includes(ev.event) ||
          (ev.event === 'Stop' && ev.decision === 'continue');
        const status: AgentStatus = working && !ev.blocked ? 'working' : 'idle';
        if (!this.seen.has(id) || this.recent.has(id)) {
          this.office.addMain({
            id,
            account: 'agy',
            provider: 'agy',
            sessionId: ev.conv,
            role: 'agy',
            cwd: '/agy',
            startedAt: at,
            status,
          });
        }
        this.recent.delete(id);
        this.seen.set(id, at);
        this.office.setStatus(id, status);
        this.office.addActivity(
          id,
          {
            id: id + ':' + this.tail.offset + ':' + index + ':' + ev.event + ':' + at,
            kind: ev.error ? 'error' : 'other',
            icon: ev.error ? '!' : '·',
            text: ev.event,
            at,
          },
          true,
        );
      }
    } catch {
      error = 'Bridge log unreadable';
    }
    for (const [id, at] of this.seen) {
      if (at < now - ACTIVE_WINDOW || !ok) {
        this.office.closeMain(id);
        this.seen.delete(id);
      }
    }
    if (now - this.scanAt >= 15_000) {
      this.scanAt = now;
      this.scanBrain(now);
    }
    return {
      label: 'agy',
      provider: 'agy',
      path: '',
      sessions: this.seen.size + this.recent.size,
      ok: ok || this.brainAvailable,
      error: ok || this.brainAvailable ? undefined : error,
    };
  }

  // An uninstrumented installation exposes recent writes, but no reliable busy/idle signal.
  // Read timestamps only. Neither the transcript nor its prompt text is opened here.
  private scanBrain(now: number) {
    const active = new Map<string, number>();
    try {
      for (const ent of readdirSync(this.brain, { withFileTypes: true })) {
        if (!ent.isDirectory() || !/^[a-f0-9-]{36}$/i.test(ent.name)) continue;
        const id = 'agy:' + ent.name;
        if (this.seen.has(id)) continue;
        const path = join(this.brain, ent.name, '.system_generated', 'logs', 'transcript_full.jsonl');
        const stat = statSync(path, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.mtimeMs < now - ACTIVE_WINDOW || stat.mtimeMs > now + 60_000) continue;
        active.set(id, stat.mtimeMs);
        if (this.recent.get(id) === stat.mtimeMs) continue;
        this.office.addMain({
          id,
          account: 'agy',
          provider: 'agy',
          sessionId: ent.name,
          role: 'agy',
          cwd: '/agy',
          startedAt: stat.mtimeMs,
          status: 'idle',
        });
        this.office.addActivity(
          id,
          { id: id + ':' + stat.mtimeMs, kind: 'other', icon: '·', text: 'recent-file', at: stat.mtimeMs },
          true,
        );
      }
      this.brainAvailable = true;
    } catch {
      this.brainAvailable = false;
    }
    for (const id of this.recent.keys()) if (!active.has(id) && !this.seen.has(id)) this.office.closeMain(id);
    this.recent.clear();
    for (const [id, at] of active) this.recent.set(id, at);
  }
}
