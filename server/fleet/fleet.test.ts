import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyBridge } from './agy';
import { Office } from '../model/office';
import { NameStore } from '../model/names';
import { parseFrame, Projection } from './projection';
import { providers, type Frame } from '../../shared/fleet';

describe('fleet observation', () => {
  it('recognizes native file timestamps, upgrades to lifecycle events and expires old activity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-agy-'));
    const id = '359b595c-cc50-4169-81f2-92b7211bcde0';
    const logs = join(dir, id, '.system_generated', 'logs');
    try {
      mkdirSync(logs, { recursive: true });
      const file = join(logs, 'transcript_full.jsonl');
      writeFileSync(file, 'private transcript fixture');
      const now = statSync(file).mtimeMs + 20;
      const office = new Office({
        names: new NameStore(null),
        accountName: (s) => s,
        accounts: () => [],
        sources: () => [],
        version: 'test',
        startedAt: now,
      });
      const log = join(dir, 'bridge.jsonl');
      const bridge = new AgyBridge(log, dir, office);
      expect(bridge.poll(now)).toMatchObject({ ok: true, sessions: 1 });
      expect(office.commit().snapshot.agents[0]?.activity?.text).toBe('recent-file');
      appendFileSync(log, JSON.stringify({ conv: id, event: 'PreInvocation', ts: new Date(now).toISOString() }) + '\n');
      expect(bridge.poll(now + 100).sessions).toBe(1);
      expect(office.commit().snapshot.agents).toMatchObject([{ provider: 'agy', status: 'working' }]);
      appendFileSync(
        log,
        JSON.stringify({ conv: id, event: 'Stop', ts: new Date(now + 200).toISOString(), decision: 'allow' }) + '\n',
      );
      bridge.poll(now + 201);
      expect(office.commit().snapshot.agents[0]?.status).toBe('idle');
      expect(bridge.poll(now + 31 * 60_000).sessions).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('separates identical session and room IDs across nodes, removes a disconnected node from the office', () => {
    const frame: Frame = {
      v: 1,
      sources: providers.map((provider) => ({ provider, ok: true })),
      sessions: [
        {
          id: '1'.repeat(24),
          start: 5,
          at: 7,
          room: '2'.repeat(24),
          project: 'harness',
          provider: 'codex',
          stats: { tokensIn: 3, tokensOut: 2, toolCalls: 1, subagents: 0 },
          status: 'working',
        },
      ],
    };
    expect(parseFrame(JSON.stringify(frame))).toEqual(frame);
    expect(() => parseFrame(JSON.stringify({ ...frame, sessions: [...frame.sessions, ...frame.sessions] }))).toThrow();
    const peers = ['a', 'b'].map((name) => ({
      frame,
      status: { name, state: 'online' as const, lastSeen: 10, sources: frame.sources },
    }));
    const view = new Projection();
    const snap = view.build(peers);
    expect(new Set(snap.agents.map((a) => a.id)).size).toBe(2);
    expect(new Set(snap.rooms.map((r) => r.slot)).size).toBe(2);
    expect(
      view.build([peers[0], { ...peers[1], status: { ...peers[1].status, state: 'offline', sources: [] } }]).agents,
    ).toHaveLength(1);
  });
});
