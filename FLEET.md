# Fleet office

Run `npm ci`, `npm run build` and `npm run fleet` at the root of this checkout, then open http://127.0.0.1:4749. The viewer groups project rooms by node. Select an agent in the sidebar to focus its character. A check beside a provider indicates that its source is available, including when there are zero sessions. A cross indicates an unavailable source. A disconnected node leaves the office until it reconnects.

## Node setup

The coordinator uses Node 22.12 or newer. Each remote node needs a compatible Node executable on its noninteractive SSH path and an existing trusted SSH alias. The six aliases are in [fleet.json](fleet.json). The short hostname identifies the local node. Use `npm run fleet -- --local mac-studio` when a machine's hostname differs from its inventory name. Use `--config /absolute/path/to/nodes.json` to select another inventory and `--port 4750` to choose a different local port.

Each inventory entry requires a unique `name`. The optional `node` field accepts an absolute executable path. The optional `claudeHome`, `codexHome`, `agyLog` and `agyBrain` fields accept absolute paths on that node. Otherwise the collector uses the node's home and its native CLI environment. The agy defaults are the Claude log directory's `agy-hook-bridge.jsonl` and `~/.gemini/antigravity-cli/brain`.

A peer can specify an `sshFallbackInterface` map keyed by coordinator name. On mbp-max, the ai-laptop entry uses `en0` as its alternate route. The first connection uses the normal SSH route. After a failed attempt the collector alternates routes, and after a working connection drops it retries the last successful route first. Both routes require the same trusted SSH host key.

The coordinator streams a bundled collector over each SSH connection. The collector runs in memory, reads native files locally and sends session metadata over SSH. The projection includes the provider, project basename, status, activity category, counters and hashed identifiers. The service listens on loopback and exposes the office canvas, snapshots, source health and a live event stream. Stop it with Ctrl+C. No peer package installation or hook registration is required.

## Interpreting agy activity

The bridge reports recorded lifecycle events. A completed turn appears idle and a continuation remains working. When only the native conversation directory has recent activity, the office displays **Recent activity** based on the transcript file’s modification time. It does not open that transcript. Both inputs share the same conversation identity. agy sessions age out after 30 minutes without evidence. The bridge does not supply a project path, so agy has its own room on each node.

## Verification on November 25, 2026

The production build and TypeScript checks exited 0. The full suite passed 1,884 tests with zero failures. Two Windows-only checks for executable discovery and Git Bash selection were skipped on macOS. The World theme regression explicitly starts with no theme, switches to Christmas and verifies both transmitted values.

A live browser check against port 4749 required all six nodes online and all three sources readable on each. It saw 17 sessions in ten rooms, matched a labeled agy turn on mbp-max, focused its character and returned to the overview. A permission write returned HTTP 405. The browser reported zero uncaught page errors. The live ai-laptop SSH process used the configured en0 interface and strict host-key checking. Fedora's timestamp reader also recognized an actual prior conversation during historical replay.

## Gaps / not covered

A new Fedora agy turn still needs completion of the native Google OAuth prompt. Source readability is independently verified. The passive Codex reader can lag tool execution and miss approval waits. Recent agy file activity cannot establish whether a process is still running. Hashes are stable identifiers, not anonymization. Anyone with access to the coordinator's loopback interface can read the displayed project names and activity. The fleet viewer has no approval, messaging or command endpoints.
