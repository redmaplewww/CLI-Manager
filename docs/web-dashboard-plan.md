# Web Dashboard Plan

## Goal

Replace the fragile terminal UI with a browser-based Butler control center.

The web page must provide three core areas:

1. Chat with the Butler manager agent.
2. Observe task/project assignment and progress.
3. Monitor each CLI worker's process, events, logs, and result.

## Architecture

```text
Browser Dashboard
  | HTTP JSON APIs
  v
Bun Web Server
  | ButlerAgent / TaskLedger / ProjectStore
  v
Butler Daemon
  | child processes
  v
Aura CLI workers
```

The server stays external to Aura CLI. It reads Butler's SQLite database and
project store, sends control requests to the daemon, and uses ButlerAgent for
manager conversation.

## Routes

- `GET /` static dashboard HTML
- `GET /api/state` tasks, projects, workers, daemon state, latest task events
- `GET /api/tasks/:id/events` formatted and raw task events
- `GET /api/tasks/:id/result` formatted result
- `POST /api/chat` user message -> ButlerAgent reply/actions
- `POST /api/tasks/:id/stop`
- `POST /api/tasks/:id/retry`
- `POST /api/tasks/:id/answer`
- `POST /api/daemon/start`
- `POST /api/daemon/stop`

## UI Layout

```text
Top bar: daemon status, LLM status, refresh indicator

Left: Butler Chat
  - scrollable conversation
  - input box
  - send button

Center: Tasks / Projects
  - task cards with status, title, pid, session id
  - project cards with iteration and latest notification

Right: Worker Inspector
  - selected task details
  - worker command/cwd/stdout/stderr path
  - formatted event stream
  - stderr tail
  - result summary
```

## Polling

MVP uses polling every 2 seconds. SSE/WebSocket can be added later.

## Styling

Use browser Unicode rendering, so Chinese output is allowed and preferred.
Avoid terminal encoding issues entirely.
