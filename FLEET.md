# Fleet office

Run `npm ci`, `npm run build` and `npm run fleet` at the root of this checkout, then open http://127.0.0.1:4749. The viewer groups project rooms by node. Select an agent in the sidebar to focus its character. A check beside a provider indicates that its source is available, including when there are zero sessions. A cross indicates an unavailable source. A disconnected node leaves the office until it reconnects.

## Node setup

The coordinator uses Node 22.12 or newer. Each remote node needs a compatible Node executable on its noninteractive SSH path and an existing trusted SSH alias. The six aliases are in [fleet.json](fleet.json). The short hostname identifies the local node. Use `npm run fleet -- --local mac-studio` when a machine's hostname differs from its inventory name. Use `--config /absolute/path/to/nodes.json` to select another inventory and `--port 4750` to choose a different local port.

Each inventory entry requires a unique `name`. The optional `node` field accepts an absolute executable path. The optional `claudeHome`, `codexHome`, `agyLog` and `agyBrain` fields accept absolute paths on that node. Otherwise the collector uses the node's home and its native CLI environment. The agy defaults are the Claude log directory's `agy-hook-bridge.jsonl` and `~/.gemini/antigravity-cli/brain`.

The coordinator streams a bundled collector over each SSH connection. The collector runs in memory, reads native files locally and sends session metadata over SSH. The projection includes the provider, project basename, status, activity category, counters and hashed identifiers. The service listens on loopback and exposes the office canvas, snapshots, source health and a live event stream. Stop it with Ctrl+C. No peer package installation or hook registration is required.

## Interpreting agy activity

The bridge reports recorded lifecycle events. A completed turn appears idle and a continuation remains working. When only the native conversation directory has recent activity, the office displays **Recent activity** based on the transcript file’s modification time. It does not open that transcript. Both inputs share the same conversation identity. agy sessions age out after 30 minutes without evidence. The bridge does not supply a project path, so agy has its own room on each node.

## Verification on November 25, 2026

The production build, TypeScript and translation checks exited 0. Both fleet regression tests passed. A live browser check of `npm run fleet -- --local mbp-max` showed five connected hosts, six project rooms and 14 observed sessions across Claude Code, Codex and agy. The check matched a labeled agy turn to its conversation hash, focused its character, returned to the overview and received HTTP 405 for a permission write. The headless browser reported zero uncaught page errors during the check.

Fedora's timestamp adapter recognized a real previously recorded agy session when evaluated at its recording time. A fresh Fedora agy turn requested sign-in. ai-laptop timed out at its configured SSH address and the viewer showed it offline. The full regression suite recorded 1,883 passes, two skips and one failure. The same World theme test timed out on the unmodified v1.0.3 checkout.

## Gaps / not covered

The passive Codex reader can lag tool execution and miss approval waits. Recent agy file activity cannot establish whether a process is still running. Hashes are stable identifiers, not anonymization. Anyone with access to the coordinator's loopback interface can read the displayed project names and activity. The fleet viewer has no approval, messaging or command endpoints.
