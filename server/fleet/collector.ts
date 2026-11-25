// This entry point is bundled and streamed to node via SSH stdin. It opens no listener.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { AccountsService } from '../accounts/service';
import { ClaudeWatcher } from '../sources/watcher';
import { CodexSource } from '../sources/codex/source';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { setQuiet } from '../log';
import { AgyBridge } from './agy';

setQuiet(true);
process.stdout.on('error', () => process.exit(1));
const home = homedir();
const paths = JSON.parse(Buffer.from(process.argv[2] || 'e30=', 'base64').toString());
const claudeDir = paths.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
const codexDir = paths.codexHome || process.env.CODEX_HOME || join(home, '.codex');
const office: Office = new Office({
  names: new NameStore(null),
  version: 'fleet',
  startedAt: Date.now(),
  accounts: (s) => accounts.list(s),
  sources: () => [],
  accountName: (id) => id,
});
const accounts = new AccountsService({ dirs: [claudeDir], home, env: process.env, onChange: () => office.markDirty() });
const claude = new ClaudeWatcher({ accounts, office, inDocker: false });
const codex = new CodexSource({ accounts, office, dirs: [codexDir], env: process.env, home });
const agy = new AgyBridge(
  paths.agyLog || process.env.AGY_HOOK_LOG || join(claudeDir, 'logs', 'agy-hook-bridge.jsonl'),
  paths.agyBrain || join(home, '.gemini', 'antigravity-cli', 'brain'),
  office,
);
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

async function start() {
  claude.start();
  await codex.start();
  function emit() {
    const agySource = agy.poll(Date.now());
    office.tick();
    const snap = office.commit().snapshot;
    const sources = [
      { provider: 'claude', ok: existsSync(claudeDir) && claude.sources().some((s) => s.ok) },
      { provider: 'codex', ok: existsSync(codexDir) && codex.sources().some((s) => s.ok) },
      { provider: 'agy', ok: agySource.ok },
    ];
    // Allowlist metadata before it leaves the node. Raw IDs, paths, tool inputs and conversation text stay local.
    const sessions = snap.agents
      .filter((a) => a.status !== 'offline')
      .map((a) => ({
        id: hash(a.id),
        parent: a.parentId ? hash(a.parentId) : undefined,
        provider: a.provider ?? 'claude',
        project: basename(a.roomId) || '/',
        room: hash(a.roomId),
        start: a.startedAt,
        stats: {
          toolCalls: a.stats.toolCalls,
          tokensIn: a.stats.tokensIn,
          tokensOut: a.stats.tokensOut,
          subagents: a.stats.subagents,
        },
        status: a.status,
        at: a.lastEventAt,
        action: a.provider === 'agy' ? a.activity?.text : a.activity?.kind,
      }));
    if (!process.stdout.writableNeedDrain) process.stdout.write(JSON.stringify({ v: 1, sources, sessions }) + '\n');
  }
  emit();
  setInterval(emit, 3500);
}
void start().catch(() => process.exit(1));
