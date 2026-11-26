# Fleet office

Run `npm ci`, `npm run build` and `npm run fleet` at the root of this checkout, then open http://127.0.0.1:4749. The viewer groups project rooms by node. Select an agent in the sidebar to focus its character. A check beside a provider indicates that its source is available, including when there are zero sessions. A cross indicates an unavailable source. A disconnected node leaves the office until it reconnects.

## Herdr on mbp-max

In the **SDLC/ADLC Orchestrator** workspace, choose **Control Center → Habblaud · Live office**. The native Habblaud tab refreshes every five seconds. Select a node to see its session sources, agents, projects and Herdr workspaces. Select a session to focus that character on the fleet canvas. Local requests that need an operator link to their agent in the full office.

| Surface | What the operator can do |
| --- | --- |
| [Fleet canvas](http://127.0.0.1:4749/?lang=en) | Follow Claude Code, Codex and Antigravity across the six nodes. |
| [Full local office](http://127.0.0.1:4747/?lang=en) | Inspect the orchestrator's sessions, open the terminal, review requests, write messages, use English dictation and replay local history. |
| Herdr workspace buttons | Enter the selected machine's existing workspace to work directly on that node. |

English is the default for a fresh browser. Opening either office from Herdr also selects English for that browser. Settings can save a different language. The orchestrator's office process uses `HABBLAUD_LANG=en` for server activity and status messages.

macOS starts the full office using the user LaunchAgent `com.2acrestudios.habblaud.office`. The `com.2acrestudios.habblaud.fleet` agent checks for the existing `habblaud-fleet` tmux session at login and every minute, and starts it if absent. Service logs are under `~/Library/Logs/Habblaud/`. The native panel source lives in [herdr/](herdr/). To refresh it after editing this checkout:

```sh
cp herdr/main.js herdr/mod.json ~/.config/herdr-app/mods/habblaud/
herdr-app check ~/.config/herdr-app/mods/habblaud
```

The local Claude plugins provide plan usage, permission requests, and incoming messages. The nine local Codex hooks use Codex's native trust store. Existing Claude sessions can load the plugins with `/reload-plugins`. Fleet observation continues over the existing SSH connections. When working on a peer, use its Herdr workspace for interactive control.

## Node setup

The coordinator uses Node 22.12 or newer. Each remote node needs a compatible Node executable on its noninteractive SSH path and an existing trusted SSH alias. The six aliases are in [fleet.json](fleet.json). The short hostname identifies the local node. Use `npm run fleet -- --local mac-studio` when a machine's hostname differs from its inventory name. Use `--config /absolute/path/to/nodes.json` to select another inventory and `--port 4750` to choose a different local port.

Each inventory entry requires a unique `name`. The optional `node` field accepts an absolute executable path. The optional `claudeHome`, `codexHome`, `agyLog` and `agyBrain` fields accept absolute paths on that node. Otherwise the collector uses the node's home and its native CLI environment. The agy defaults are the Claude log directory's `agy-hook-bridge.jsonl` and `~/.gemini/antigravity-cli/brain`.

A peer can specify an `sshFallbackInterface` map keyed by coordinator name. On mbp-max, the ai-laptop entry uses `en0` as its alternate route. The first connection uses the normal SSH route. After a failed attempt the collector alternates routes, and after a working connection drops it retries the last successful route first. Both routes require the same trusted SSH host key.

The coordinator streams a bundled collector over each SSH connection. The collector runs in memory, reads native files locally and sends session metadata over SSH. The projection includes the provider, project basename, status, activity category, counters and hashed identifiers. The service listens on loopback and exposes the office canvas, snapshots, source health and a live event stream. Stop it with Ctrl+C. No peer package installation or hook registration is required.

## Interpreting agy activity

The bridge reports recorded lifecycle events. A completed turn appears idle and a continuation remains working. When only the native conversation directory has recent activity, the office displays **Recent activity** based on the transcript file’s modification time. It does not open that transcript. Both inputs share the same conversation identity. agy sessions age out after 30 minutes without evidence. The bridge does not supply a project path, so agy has its own room on each node.

## Verification on November 25, 2026

The production build and TypeScript checks exited 0. The full suite passed 1,884 tests with zero failures. Two Windows-only checks for executable discovery and Git Bash selection were skipped on macOS. The World theme regression explicitly starts with no theme, switches to Christmas and verifies both transmitted values.

A live browser check against port 4749 required all six nodes online and all three sources readable on each. It saw 17 sessions in ten rooms, matched a labeled agy turn on mbp-max, focused its character and returned to the overview. A permission write returned HTTP 405. The browser reported zero uncaught page errors. The live ai-laptop SSH process used the configured en0 interface and strict host-key checking. After native Google authorization on Fedora, a fresh headless agy turn returned its exact per-run marker. The live office snapshot contained the matching Fedora agy conversation ID, with all six nodes online.

Fedora subsequently renewed an expired access token without another interactive sign-in. Its native agy diagnostic `cli-20261125_170854.log` marked the loaded token expired at line 75, recorded a refresh with a new expiry at line 76, and reported successful OAuth authentication at line 79. The subsequent `match-fedora-live.py` gate exited 0 after matching a fresh exact-reply turn to its Fedora agy session in the live snapshot. All six nodes were online.

## Orchestrator verification on November 26, 2026

The live acceptance check found six online nodes with three readable session sources each, both local account usage feeds healthy, three enabled Claude plugins and all nine Habblaud Codex hooks trusted. Herdr's Control Center opened the native tab and selecting AI Lab showed that node's agents and workspace. Both office pages rendered in English. Chrome exercised Help, Settings, My day, Session history, New agent, Timelapse and the World entry point.

A local Codex turn returned the requested marker through Ollama and its session ID appeared in the full office. The installed Claude `/habblaud` command returned the live English summary. The local office also opened a real Claude PTY, resized it, streamed its startup screen and closed it. The dictation API transcribed the installed Whisper JFK audio sample in English. The production build, typecheck and native Herdr check exited 0. The English translation audit covered 2,989 of 2,989 registered keys; the project suite passed 1,884 tests with two Windows-specific skips. The Claude plugin suites passed 35 tests.

## Gaps / not covered

The passive Codex reader can lag tool execution and miss approval waits. Recent agy file activity cannot establish whether a process is still running. Hashes are stable identifiers, not anonymization. Anyone with access to the coordinator's loopback interface can read the displayed project names and activity. The fleet viewer has no approval, messaging or command endpoints.

The November 26 checks did not exercise signed-in World social activity, phone access, a real human approval or message to an ongoing work session, or recovery following a Mac reboot. Office and fleet listeners are loopback-only.
