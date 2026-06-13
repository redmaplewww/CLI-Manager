import { spawn, spawnSync } from 'child_process'
import { mkdirSync, openSync, closeSync } from 'fs'
import { join } from 'path'
import type { MuxEngine, MuxSessionRecord, ResolvedButlerConfig } from './types'
import { MuxStore } from './muxStore'

export class MuxManager {
  private readonly store: MuxStore

  constructor(private readonly config: ResolvedButlerConfig) {
    this.store = new MuxStore(config)
  }

  availableEngines(): Array<{
    engine: MuxEngine
    available: boolean
    note: string
  }> {
    return [
      {
        engine: 'tmux',
        available: commandAvailable('tmux', ['-V']),
        note: 'Best experience; recommended in WSL/Linux/macOS.',
      },
      {
        engine: 'windows-terminal',
        available:
          process.platform === 'win32' && commandAvailable('wt', ['--version']),
        note: 'Opens real Windows Terminal tabs/windows.',
      },
      {
        engine: 'detached',
        available: true,
        note: 'Fallback; no interactive attach, logs only.',
      },
    ]
  }

  chooseEngine(preferred?: MuxEngine): MuxEngine {
    if (preferred) {
      const found = this.availableEngines().find(e => e.engine === preferred)
      if (!found?.available)
        throw new Error(`Mux engine is not available: ${preferred}`)
      return preferred
    }
    if (commandAvailable('tmux', ['-V'])) return 'tmux'
    if (process.platform === 'win32' && commandAvailable('wt', ['--version']))
      return 'windows-terminal'
    return 'detached'
  }

  start(options: {
    name?: string
    engine?: MuxEngine
    prompt?: string
    interactive?: boolean
  }): MuxSessionRecord {
    const id = `M${Date.now().toString(36)}`
    const name = sanitizeName(options.name ?? `aura-${id}`)
    const engine = this.chooseEngine(options.engine)
    const command = this.buildAuraCommand(
      options.prompt,
      options.interactive ?? true,
    )
    const now = new Date().toISOString()
    mkdirSync(this.config.storage.logsDir, { recursive: true })
    const logPath = join(this.config.storage.logsDir, `${name}.mux.log`)

    let pid: number | null = null
    let tmuxSession: string | null = null

    if (engine === 'tmux') {
      tmuxSession = name
      const result = spawnSync(
        'tmux',
        ['new-session', '-d', '-s', tmuxSession, command],
        {
          cwd: this.config.aura.cwd,
          shell: false,
          stdio: 'pipe',
        },
      )
      if (result.status !== 0)
        throw new Error(
          result.stderr.toString() || 'Failed to create tmux session',
        )
    } else if (engine === 'windows-terminal') {
      const result = spawn(
        'wt',
        [
          'new-tab',
          '--title',
          name,
          '-d',
          this.config.aura.cwd,
          'cmd',
          '/k',
          command,
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        },
      )
      pid = result.pid ?? null
      result.unref()
    } else {
      const fd = openSync(logPath, 'a')
      const child = spawn(command, {
        cwd: this.config.aura.cwd,
        detached: true,
        shell: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
      pid = child.pid ?? null
      child.unref()
      closeSync(fd)
    }

    const record: MuxSessionRecord = {
      id,
      name,
      engine,
      command,
      cwd: this.config.aura.cwd,
      pid,
      tmuxSession,
      logPath,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    }
    this.store.save(record)
    return record
  }

  list(): MuxSessionRecord[] {
    return this.store.list().map(session => ({
      ...session,
      status: this.detectStatus(session),
      updatedAt: new Date().toISOString(),
    }))
  }

  attach(target: string): void {
    const session = this.store.get(target)
    if (!session) throw new Error(`Mux session not found: ${target}`)
    if (session.engine === 'tmux') {
      const result = spawnSync(
        'tmux',
        ['attach-session', '-t', session.tmuxSession ?? session.name],
        { stdio: 'inherit' },
      )
      if (result.status !== 0)
        throw new Error(`Failed to attach tmux session: ${session.name}`)
      return
    }
    if (session.engine === 'windows-terminal') {
      console.log(
        'This session is already running in Windows Terminal. Switch to that tab/window manually.',
      )
      return
    }
    console.log(
      `Detached session has no interactive attach. Log: ${session.logPath ?? '(none)'}`,
    )
  }

  stop(target: string): void {
    const session = this.store.get(target)
    if (!session) throw new Error(`Mux session not found: ${target}`)
    if (session.engine === 'tmux') {
      spawnSync(
        'tmux',
        ['kill-session', '-t', session.tmuxSession ?? session.name],
        { stdio: 'ignore' },
      )
    } else if (session.pid) {
      try {
        process.kill(session.pid, 'SIGTERM')
      } catch {
        // already stopped
      }
    }
    this.store.remove(target)
  }

  private buildAuraCommand(
    prompt: string | undefined,
    interactive: boolean,
  ): string {
    const quoted = [this.config.aura.command, ...this.config.aura.args]
      .map(shellQuote)
      .join(' ')
    if (interactive && !prompt) return quoted
    const args = ['-p', `--output-format=${this.config.execution.outputFormat}`]
    if (this.config.execution.verbose) args.push('--verbose')
    if (prompt) args.push(prompt)
    return `${quoted} ${args.map(shellQuote).join(' ')}`
  }

  private detectStatus(session: MuxSessionRecord): MuxSessionRecord['status'] {
    if (session.engine === 'tmux') {
      const result = spawnSync(
        'tmux',
        ['has-session', '-t', session.tmuxSession ?? session.name],
        { stdio: 'ignore' },
      )
      return result.status === 0 ? 'running' : 'stopped'
    }
    if (session.pid) {
      try {
        process.kill(session.pid, 0)
        return 'running'
      } catch {
        return 'stopped'
      }
    }
    return 'unknown'
  }
}

function commandAvailable(command: string, args: string[]): boolean {
  try {
    return spawnSync(command, args, { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)
}

function shellQuote(value: string): string {
  if (process.platform === 'win32')
    return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
