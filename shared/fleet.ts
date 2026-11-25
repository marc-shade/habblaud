import type { AgentInfo, AgentStatus, OfficeSnapshot, Provider } from './types';

export const providers: Provider[] = ['claude', 'codex', 'agy'];
export const providerNames: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'agy' };
export interface ObservedSession {
  id: string;
  parent?: string;
  provider: Provider;
  project: string;
  room: string;
  start: number;
  at: number;
  status: AgentStatus;
  action?: string;
  stats: AgentInfo['stats'];
}
export interface Frame {
  v: 1;
  sources: { provider: Provider; ok: boolean }[];
  sessions: ObservedSession[];
}
export interface NodeStatus {
  name: string;
  state: 'connecting' | 'online' | 'offline';
  lastSeen: number | null;
  sources: Frame['sources'];
}
export interface FleetSnapshot extends OfficeSnapshot {
  nodes: NodeStatus[];
}
