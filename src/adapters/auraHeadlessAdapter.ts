import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, mkdirSync } from 'fs'
import { join } from 'path'
import type {
  NormalizedStreamEvent,
  ResolvedButlerConfig,
  StartTaskOptions,
  StartTaskResult,
  WorkerRecord,
} from '../types'
import { TaskLedger } from '../db'
import { parseStreamJsonLine } from './streamJsonParser'
import { ResultCollector } from '../resultCollector'
import { judgeTaskCompletion } from '../completionJudge'

export class AuraHeadlessAdapter {
  private processes = new Map<string, ChildProcess>()

  constructor(
    private readonly config: ResolvedButlerConfig,
    private readonly ledger: TaskLedger,
  ) {}

  startTask(options: StartTaskOptions): StartTaskResult {
    const task = options.task
    mkdirSync(this.config.storage.logsDir, { recursive: true })
    const workerId = `${task.id}-attempt-${task.retryCount + 1}`
    const stdoutPath = join(
      this.config.storage.logsDir,
      `${task.id}.stdout.jsonl`,
    )
    const stderrPath = join(
      this.config.storage.logsDir,
      `${task.id}.stderr.log`,
    )
    const args = this.buildArgs(options.resumeSessionId, options.prompt)
    const now = new Date().toISOString()

    const command = this.resolveCommand(this.config.aura.command)
    const cwd = this.config.aura.cwd
    const child: ChildProcess = spawn(command, args, {
      cwd: this.config.aura.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const pid = child.pid ?? 0
    const worker: WorkerRecord = {
      id: workerId,
      taskId: task.id,
      pid,
      status: 'running',
      command: [command, ...args].join(' '),
      cwd,
      stdoutPath,
      stderrPath,
      startedAt: now,
      lastOutputAt: now,
      exitCode: null,
      signal: null,
    }
    this.ledger.addWorker(worker)
    this.ledger.updateTask(task.id, {
      status: 'running',
      pid,
      startedAt: now,
      lastOutputAt: now,
      errorMessage: null,
    })
    this.ledger.addEvent(task.id, 'task_started', {
      pid,
      command: worker.command,
    })

    const stdoutLog = createWriteStream(stdoutPath, { flags: 'a' })
    const stderrLog = createWriteStream(stderrPath, { flags: 'a' })
    let lineBuffer = ''
    let finalAssistantText = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdoutLog.write(text)
      lineBuffer += text
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const events = parseStreamJsonLine(line)
        finalAssistantText = this.applyEvents(
          task.id,
          workerId,
          events,
          finalAssistantText,
        )
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrLog.write(text)
      const at = new Date().toISOString()
      this.ledger.addEvent(task.id, 'stderr', undefined, text)
      this.ledger.updateTask(task.id, { lastOutputAt: at })
      this.ledger.updateWorker(workerId, { lastOutputAt: at })
    })

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      stdoutLog.end()
      stderrLog.end()
      if (lineBuffer.trim()) {
        finalAssistantText = this.applyEvents(
          task.id,
          workerId,
          parseStreamJsonLine(lineBuffer),
          finalAssistantText,
        )
      }
      this.processes.delete(task.id)
      const finishedAt = new Date().toISOString()
      this.ledger.addEvent(task.id, 'exit', { code, signal })
      this.ledger.updateWorker(workerId, {
        exitCode: code,
        signal,
        status: code === 0 ? 'completed' : 'failed',
      })
      if (code === 0) {
        const completionOutput = [
          finalAssistantText,
          `Process exited with code=0 signal=${signal ?? ''}`,
        ].join('\n')
        const artifact = new ResultCollector(this.config, this.ledger).collect(
          task.id,
          completionOutput,
        )
        this.ledger.updateTask(task.id, {
          status: 'completed',
          pid: null,
          finishedAt,
          resultSummary: finalAssistantText,
          resultArtifact: artifact,
          errorMessage: null,
        })
        const latestTask = this.ledger.getTask(task.id) ?? task
        const judgement = judgeTaskCompletion(latestTask, completionOutput)
        if (!judgement.done && judgement.verdict === 'not_done') {
          this.ledger.updateTask(task.id, {
            status: 'stuck',
            pid: null,
            finishedAt,
            resultSummary: finalAssistantText,
            resultArtifact: artifact,
            errorMessage: `Completion criteria not satisfied: ${judgement.verdict}`,
          })
          this.ledger.addEvent(
            task.id,
            'watchdog_stuck',
            { artifact, completionJudgement: judgement },
            judgement.reason,
          )
          return
        }
        this.ledger.addEvent(
          task.id,
          'task_completed',
          { artifact, reviewNeeded: !judgement.done, completionJudgement: judgement },
          finalAssistantText,
        )
      } else {
        this.ledger.updateTask(task.id, {
          status: 'failed',
          pid: null,
          finishedAt,
          errorMessage: `Aura exited with code=${code} signal=${signal ?? ''}`,
        })
        this.ledger.addEvent(task.id, 'task_failed', { code, signal })
      }
    })

    child.on('error', (err: Error) => {
      this.ledger.updateTask(task.id, {
        status: 'failed',
        pid: null,
        errorMessage: err.message,
        finishedAt: new Date().toISOString(),
      })
      this.ledger.addEvent(task.id, 'task_failed', { error: err.message })
    })

    if (this.config.execution.useStdinForPrompt)
      child.stdin?.write(options.prompt + '\n')
    child.stdin?.end()
    this.processes.set(task.id, child)

    return { pid, workerId, stdoutPath, stderrPath }
  }

  answer(taskId: string, answer: string): boolean {
    const child = this.processes.get(taskId)
    if (!child || child.killed) return false
    child.stdin?.write(answer + '\n')
    this.ledger.updateTask(taskId, { status: 'running', waitingQuestion: null })
    this.ledger.addEvent(taskId, 'answer_sent', undefined, answer)
    return true
  }

  stop(taskId: string): boolean {
    const child = this.processes.get(taskId)
    if (!child || child.killed) return false
    child.kill('SIGTERM')
    this.ledger.updateTask(taskId, {
      status: 'cancelled',
      pid: null,
      finishedAt: new Date().toISOString(),
    })
    this.ledger.addEvent(taskId, 'task_cancelled')
    return true
  }

  private buildArgs(
    resumeSessionId: string | undefined,
    prompt: string,
  ): string[] {
    const baseArgs = this.config.aura.args ?? []
    const args = [
      ...baseArgs,
      '-p',
      `--output-format=${this.config.execution.outputFormat}`,
    ]
    if (this.config.execution.verbose) args.push('--verbose')
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    if (!this.config.execution.useStdinForPrompt) args.push(prompt)
    return args
  }

  private resolveCommand(command: string): string {
    if (command === 'bun') return process.execPath
    return command
  }

  private applyEvents(
    taskId: string,
    workerId: string,
    events: NormalizedStreamEvent[],
    finalAssistantText: string,
  ): string {
    const at = new Date().toISOString()
    this.ledger.updateTask(taskId, { lastOutputAt: at })
    this.ledger.updateWorker(workerId, { lastOutputAt: at })
    let assistantText = finalAssistantText
    for (const event of events) {
      this.ledger.addEvent(taskId, event.type, event.payload, event.text)
      if (event.type === 'assistant_text' && event.text)
        assistantText += event.text
      if (event.type === 'session_id' && event.cliSessionId)
        this.ledger.updateTask(taskId, { cliSessionId: event.cliSessionId })
      if (event.type === 'question' && event.question)
        this.ledger.updateTask(taskId, {
          status: 'waiting_user',
          waitingQuestion: event.question,
        })
    }
    return assistantText
  }
}
