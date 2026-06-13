# Aura Butler Implementation Plan

## 1. Product Definition

Aura Butler is a completely external manager for the Aura CLI repository at
`F:/opencode/CLI-self`. The Butler owns all orchestration state. Aura remains a
black-box worker process launched in development mode.

The user's target workflow is:

```text
User talks to Butler only
Butler creates tasks
Butler starts multiple Aura CLI workers
Butler tracks progress, stuck states, questions, failures, and results
Butler reports one consolidated status back to the user
```

## 2. Hard Boundary

The Butler may call Aura only through public process behavior. In development
mode this is:

```bash
bun run src/entrypoints/cli.tsx -p --output-format=stream-json --verbose
```

Optional continuation:

```bash
bun run src/entrypoints/cli.tsx -p --output-format=stream-json --verbose --resume <cliSessionId>
```

The Butler must not:

- import Aura TypeScript modules
- write files inside `F:/opencode/CLI-self`
- depend on Aura daemon/bg/RCS/pipe internals for MVP
- parse interactive terminal screen output as the primary protocol

For portable deployment, Aura discovery uses this order:

1. Explicit `aura.command` + `aura.args` + `aura.cwd` in `butler.config.json`
2. `AURA_CLI_ROOT` environment variable
3. `CLI_SELF_ROOT` environment variable
4. `workspace.root`, `aura.cwd`, and configured `aura.searchRoots`
5. Common sibling directories such as `CLI-self` and `claude-code-main`

Discovery looks for `src/entrypoints/cli.tsx` first and launches development
mode with `bun run src/entrypoints/cli.tsx`. If only `dist/cli-node.js` exists,
it launches distribution mode with `node dist/cli-node.js`.

## 3. Architecture

```text
Butler CLI / future TUI
  |
  v
Control Plane
  - ConfigLoader
  - TaskLedger
  - Scheduler
  - Supervisor
  - Watchdog
  - ResultCollector
  |
  v
AuraHeadlessAdapter
  - spawn Aura dev entrypoint
  - send prompt over stdin or argv
  - parse stream-json stdout
  - collect stderr
  - save cliSessionId
  - write events to ledger
  |
  v
Aura CLI worker processes
```

## 4. Data Model

### Task

```ts
type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'stuck'
  | 'failed'
  | 'completed'
  | 'cancelled'
  | 'summarized'
```

Fields:

- `id`: stable human id, e.g. `T001`
- `title`: short display title
- `prompt`: full prompt sent to Aura
- `projectRoot`: default `F:/opencode/CLI-self`
- `category`: coding/review/test/research/doc/other
- `priority`: low/medium/high
- `status`: task status
- `pid`: current child process pid, if running
- `cliSessionId`: Aura session id for `--resume`
- `retryCount`: retry counter
- `createdAt`, `startedAt`, `updatedAt`, `finishedAt`
- `lastOutputAt`: watchdog signal
- `waitingQuestion`: question requiring user input
- `resultSummary`: final summary
- `resultArtifact`: path to result JSON/markdown
- `errorMessage`: final failure reason

### Event

Every meaningful worker observation becomes an event:

- `task_queued`
- `task_started`
- `stdout_json`
- `raw_stdout`
- `stderr`
- `assistant_text`
- `tool_use`
- `tool_result`
- `question`
- `session_id`
- `done`
- `exit`
- `watchdog_stuck`
- `task_failed`
- `task_completed`

### Worker

For MVP, one task equals one child process. `workers` are process records, not
long-lived agents. Long-lived worker pools are a phase-2 feature.

## 5. Storage Strategy

MVP uses SQLite because task state must survive terminal exits and Butler
crashes. Each task also gets file artifacts:

```text
data/
  butler.sqlite
  logs/
    T001.stdout.jsonl
    T001.stderr.log
  artifacts/
    T001.result.json
    T001.summary.md
```

All stdout lines are append-only. Parsed events are duplicated into SQLite for
querying. This makes recovery reliable even when parsing code changes later.

## 6. Process Contract

### Start Task

Use stdin for prompt by default:

```text
command = bun
args = ["run", "src/entrypoints/cli.tsx", "-p", "--output-format=stream-json", "--verbose"]
cwd = F:/opencode/CLI-self
stdin = prompt + "\n"
```

### Resume Task

If `cliSessionId` exists:

```text
args += ["--resume", cliSessionId]
stdin = resumePrompt + "\n"
```

### Stop Task

Send SIGTERM first, wait for grace period, then SIGKILL if necessary. Mark task
as `cancelled` only for user stop, otherwise `failed` or `stuck`.

## 7. Stream Parser Plan

The parser must be tolerant. Every stdout line is first persisted. Then parsing
attempts JSON. If JSON parsing fails, store `raw_stdout` and continue.

Event extraction rules:

- assistant text block -> `assistant_text`
- content block `tool_use` -> `tool_use`
- content block `tool_result` -> `tool_result`
- tool name `AskUserQuestion` -> `question`, task becomes `waiting_user`
- session id field, if present -> save `cliSessionId`
- final result/done event -> `done`

Because the exact stream format may evolve, parser functions should return a
list of normalized events rather than directly mutating DB state.

## 8. Watchdog Plan

The watchdog runs periodically and inspects persisted task/worker state.

Rules for MVP:

- `running` and no output for `stuckAfterMinutes` -> `stuck`
- child process no longer alive and task not completed -> `failed`
- `waiting_user` is never auto-killed
- task runtime over `taskTimeoutMinutes` -> stop process and mark failed timeout
- known stderr auth/rate-limit phrases -> mark `failed` or `waiting_user` with reason

Watchdog actions must always write an event before changing task status.

## 9. Result Collection

When a task exits successfully, result collector creates:

- `Txxx.result.json`
- `Txxx.summary.md`

Initial summary strategy:

1. Use final assistant text from events.
2. Include observed tools and commands.
3. Include stderr tail if non-empty.
4. Include `cliSessionId` for future resume/debug.

Phase 2 may run a separate Aura summary task over the event log, but MVP should
avoid recursive task spawning until process supervision is stable.

## 10. CLI Commands

MVP commands:

```bash
butler inspect
butler add "prompt"
butler status
butler logs <taskId>
butler events <taskId>
butler result <taskId>
butler stop <taskId>
butler retry <taskId> [--resume]
butler answer <taskId> "answer"
butler workers
```

`inspect` must validate:

- Butler config loads
- Aura root exists
- `bun` is available
- Aura `--version` executes
- Aura `-p --output-format=stream-json` can produce parseable output

## 11. Implementation Phases

### Phase 1: External Task Runner

- create independent project
- add config loader
- add SQLite schema
- add task create/list/read/update operations
- add `AuraHeadlessAdapter.startTask`
- persist stdout/stderr logs
- parse basic stream-json events
- implement `add/status/logs/result`

Exit criteria:

- one task can run to completion
- status survives Butler process restart
- logs can be read from disk

### Phase 2: Reliability

- implement process registry
- implement watchdog
- implement stop/retry
- save and use `cliSessionId`
- handle `AskUserQuestion` and stdin answer
- add stuck/crashed/timeout state transitions

Exit criteria:

- crashed task is marked failed
- stuck task is visible in status
- retry can resume an earlier session when possible
- user question is surfaced and answerable

### Phase 3: Multi-task Management

- add scheduler loop
- enforce `maxParallelTasks`
- add task categories and priorities
- add simple `butler chat` or batch add command
- add consolidated report command

Exit criteria:

- three concurrent Aura tasks can be started and tracked
- queued tasks start when capacity is available
- completed and failed tasks are summarized

### Phase 4: Operator Experience

- Textual/Ink TUI or Web dashboard
- notifications
- daily project report
- long-running task checkpoints
- optional persistent worker pool through Aura pipe IPC after MVP is proven

## 12. Reliability Rules

- All state transitions are persisted before user output.
- Every process start creates a worker row and log files before spawn.
- Every stdout/stderr chunk is written to disk before parsing.
- Parser errors never kill the task runner.
- A retry creates events linking old attempt and new attempt.
- `--resume` is used only when `cliSessionId` is known.
- User stop is `cancelled`; process failure is `failed`; no-output detection is `stuck`.
- Butler never auto-commits code.
- Butler never deletes files in the Aura repository.

## 13. Immediate Code Order

1. `types.ts`
2. `config.ts`
3. `db.ts`
4. `streamJsonParser.ts`
5. `auraHeadlessAdapter.ts`
6. `resultCollector.ts`
7. `watchdog.ts`
8. command files
9. `cli.ts`

This order keeps future work continuous: storage and types stabilize first,
then the risky child-process adapter, then user commands.
