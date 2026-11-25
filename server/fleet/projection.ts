import type { AccountInfo, AgentInfo, RoomInfo } from '../../shared/types';
import { providers, providerNames, type Frame, type NodeStatus, type FleetSnapshot } from '../../shared/fleet';
import { hash32 } from '../../shared/hash';
import { pickName } from '../../shared/names';
import { SlotAllocator } from '../model/rooms';

export interface Peer {
  status: NodeStatus;
  frame?: Frame;
}

const statuses = new Set(['working', 'waiting', 'idle', 'shell', 'done', 'offline']);
const key = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{24}$/.test(s);
export function parseFrame(line: string): Frame {
  const v = JSON.parse(line);
  if (
    v?.v !== 1 ||
    !Array.isArray(v.sources) ||
    !Array.isArray(v.sessions) ||
    v.sources.length !== providers.length ||
    !providers.every((p) => v.sources.some((s: Frame['sources'][0]) => s?.provider === p && typeof s.ok === 'boolean'))
  )
    throw new Error('Invalid source frame');
  const ids = new Set<string>();
  for (const s of v.sessions) {
    if (
      !s ||
      !key(s.id) ||
      ids.has(s.id) ||
      (s.parent !== undefined && !key(s.parent)) ||
      !key(s.room) ||
      !providers.includes(s.provider) ||
      !statuses.has(s.status) ||
      typeof s.project !== 'string' ||
      s.project.length > 255 ||
      !Number.isFinite(s.start) ||
      !Number.isFinite(s.at) ||
      (s.action !== undefined && (typeof s.action !== 'string' || s.action.length > 64)) ||
      !['tokensIn', 'tokensOut', 'toolCalls', 'subagents'].every(
        (k) => Number.isFinite(s.stats?.[k]) && s.stats[k] >= 0,
      )
    )
      throw new Error('Invalid session frame');
    ids.add(s.id);
  }
  return v;
}

export class Projection {
  private slots = new SlotAllocator(0);
  private readonly start = Date.now();
  private rev = 0;
  build(peers: Iterable<Peer>): FleetSnapshot {
    const agents: AgentInfo[] = [],
      rooms = new Map<string, RoomInfo>(),
      accounts: AccountInfo[] = [],
      nodes: NodeStatus[] = [];
    const now = Date.now();
    for (const { frame, status } of peers) {
      nodes.push(status);
      if (!frame || status.state !== 'online') continue;
      const host = status.name;
      for (const source of frame.sources) {
        if (!source.ok && !frame.sessions.some((s) => s.provider === source.provider)) continue;
        const p = source.provider;
        accounts.push({
          id: host + ':' + p,
          provider: p,
          short: { claude: 'C', codex: 'X', agy: 'A' }[p],
          name: host + ' · ' + providerNames[p],
          configDir: '',
          color: { claude: '#d69371', codex: '#64b9b2', agy: '#a99be6' }[p],
          sessions: frame.sessions.filter((s) => s.provider === p).length,
          usageStatus: 'disabled',
        });
      }
      for (const s of frame.sessions) {
        const id = host + ':' + s.id,
          roomId = host + ':' + s.room,
          roomName = host + ' · ' + s.project;
        if (!rooms.has(roomId))
          rooms.set(roomId, {
            id: roomId,
            path: roomName,
            name: roomName,
            slot: 0,
            seed: hash32(roomId),
            createdAt: s.start,
          });
        const person = pickName(id, new Set());
        agents.push({
          id,
          roomId,
          kind: s.parent ? 'sub' : 'main',
          parentId: s.parent ? host + ':' + s.parent : undefined,
          provider: s.provider,
          role: providerNames[s.provider],
          account: host + ':' + s.provider,
          name: person.name,
          look: person.look,
          seed: hash32(id),
          sessionId: id,
          startedAt: s.start,
          lastEventAt: s.at,
          statusSince: s.at,
          status: s.status,
          stats: s.stats,
          tasks: [],
          recent: [],
          activity: s.action ? { id: id + ':' + s.at, at: s.at, text: s.action, kind: 'other', icon: '·' } : undefined,
        });
      }
    }
    this.slots.sync(rooms.keys(), now);
    for (const room of rooms.values()) room.slot = this.slots.slotOf(room.id)!;
    return {
      rev: ++this.rev,
      serverTime: now,
      agents,
      accounts,
      rooms: [...rooms.values()],
      nodes,
      meta: {
        startedAt: this.start,
        version: '1.0.3-fleet',
        demo: false,
        terminal: false,
        messages: false,
        sources: nodes.flatMap((n) =>
          n.sources.map((s) => ({
            ...s,
            label: n.name + ' · ' + providerNames[s.provider],
            path: '',
            sessions: agents.filter((a) => a.account === n.name + ':' + s.provider).length,
          })),
        ),
      },
    };
  }
}
