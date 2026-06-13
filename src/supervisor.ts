import type { ResolvedButlerConfig } from './types'
import { TaskLedger } from './db'
import { AuraHeadlessAdapter } from './adapters/auraHeadlessAdapter'
import { normalizeCliPrompt } from './promptNormalizer'

export class Supervisor {
  readonly adapter: AuraHeadlessAdapter

  constructor(
    readonly config: ResolvedButlerConfig,
    readonly ledger: TaskLedger,
  ) {
    this.adapter = new AuraHeadlessAdapter(config, ledger)
  }

  startTaskNow(taskId: string, prompt?: string, resume = false): void {
    const task = this.ledger.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    const options = {
      task,
      prompt: normalizeCliPrompt(prompt ?? task.prompt),
      ...(resume && task.cliSessionId
        ? { resumeSessionId: task.cliSessionId }
        : {}),
    }
    this.adapter.startTask(options)
  }

  resumeTaskWithMessage(taskId: string, message: string): void {
    const task = this.ledger.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    if (!task.cliSessionId)
      throw new Error(`Task ${taskId} has no CLI session to resume`)
    this.ledger.updateTask(task.id, {
      status: 'queued',
      retryCount: task.retryCount + 1,
      errorMessage: null,
    })
    const normalizedMessage = normalizeCliPrompt(message)
    this.ledger.addEvent(task.id, 'retry_started', {
      resume: true,
      interactiveMessage: true,
    }, normalizedMessage)
    this.adapter.startTask({
      task: this.ledger.getTask(task.id) ?? task,
      prompt: normalizedMessage,
      resumeSessionId: task.cliSessionId,
    })
  }
}
