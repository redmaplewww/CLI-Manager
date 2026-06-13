# Aura Butler

Aura Butler is an external control plane for a locally developed Aura CLI. It
does not modify or import Aura internals. It manages Aura as a child process
through the development entrypoint when a source checkout is discovered:

```bash
bun run src/entrypoints/cli.tsx -p --output-format=stream-json --verbose
```

On another machine, set `AURA_CLI_ROOT` to the Aura CLI checkout or configure
`butler.config.json`. If no explicit command is configured, Butler searches for
`src/entrypoints/cli.tsx` and falls back to `dist/cli-node.js` when available.

The goal is to provide one manager interface for multiple Aura CLI tasks:

- create and classify tasks
- launch concurrent Aura workers
- persist task state, logs, events, and results
- detect stuck or crashed workers
- answer worker questions through stdin when possible
- retry or resume work through `--resume <cliSessionId>`

## Non-goals

- No changes to `F:/opencode/CLI-self` source code.
- No dependency on Aura internal daemon/bg/RCS/pipe implementations for MVP.
- No terminal screen scraping as the primary protocol.
- No automatic commits or destructive git operations.

## Recommended First Run

Linux one-command setup after clone:

```bash
git clone https://github.com/redmaplewww/CLI-Manager.git
cd CLI-Manager
bash scripts/install-linux.sh
```

Then open `http://127.0.0.1:8800`.

If your CLI checkout has a custom directory name, set it before install/start:

```bash
export AURA_CLI_ROOT="$HOME/CLI-self-deploy-src"
bash scripts/install-linux.sh
```

After dependencies are implemented and installed:

```bash
bun install
bun run src/cli.ts inspect
bun run src/cli.ts add "Use one sentence to explain the current project"
bun run src/cli.ts status
bun run src/cli.ts logs T001
```

## Chat Mode

Use the Butler through one conversational entrypoint instead of manually calling
manager commands:

```bash
bun run src/cli.ts chat
```

Then type natural-language instructions:

```text
帮我检查当前项目的 package.json，总结启动方式
现在进度
看 T001 结果
停止 T001
开一个 CLI 窗口 name worker-a
```

Chat mode auto-starts the daemon, asks the LLM planner to create one or more
manager actions, executes them, and can automatically monitor created tasks
until completion. If the LLM is disabled or unavailable, it falls back to the
local router.

By default, chat mode uses a local rule-based router. To enable a real LLM
planner, set `llm.enabled` to `true` in `butler.config.json` and provide an
OpenAI-compatible API key:

```json
"llm": {
  "enabled": true,
  "provider": "openai-compatible",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "model": "gpt-4o-mini",
  "timeoutMs": 20000
}
```

PowerShell:

```powershell
$env:OPENAI_API_KEY="your-key"
bun run src/cli.ts chat
```

Any OpenAI-compatible provider can be used by changing `baseUrl`, `model`, and
`apiKeyEnv`.

The LLM planner can split broad requests into multiple tasks. For example:

```text
帮我处理当前项目：检查测试、review 当前 diff、总结风险，全程自动跟进
```

The expected behavior is:

1. create multiple concrete task prompts
2. submit them to the daemon
3. monitor their status periodically
4. summarize progress and blockers without requiring manual `status` commands

## Mux Windows

Butler can also open multiple Aura CLI windows, similar to a tmux-style fleet:

```bash
bun run src/cli.ts mux engines
bun run src/cli.ts mux start --name worker-a
bun run src/cli.ts mux list
bun run src/cli.ts mux attach --target worker-a
bun run src/cli.ts mux stop --target worker-a
```

Engine behavior:

- `tmux`: best interactive experience, available in WSL/Linux/macOS with tmux installed.
- `windows-terminal`: opens Windows Terminal tabs/windows when `wt` is available.
- `detached`: fallback process with logs only, no interactive attach.

On native Windows, install Windows Terminal or run Butler inside WSL for tmux.

## Project Layout

```text
aura-butler/
  butler.config.json
  docs/
    implementation-plan.md
  src/
    cli.ts
    config.ts
    db.ts
    types.ts
    scheduler.ts
    supervisor.ts
    watchdog.ts
    resultCollector.ts
    adapters/
      auraHeadlessAdapter.ts
      streamJsonParser.ts
    commands/
      add.ts
      answer.ts
      inspect.ts
      logs.ts
      result.ts
      retry.ts
      status.ts
      stop.ts
      workers.ts
  data/
    logs/
    artifacts/
```
