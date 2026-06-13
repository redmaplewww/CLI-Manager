import type { ResolvedButlerConfig } from './types'
import { TaskLedger } from './db'
import { AuraHeadlessAdapter } from './adapters/auraHeadlessAdapter'

export class Scheduler {
  constructor(
    private readonly config: ResolvedButlerConfig,
    private readonly ledger: TaskLedger,
    private readonly adapter: AuraHeadlessAdapter,
  ) {}

  runQueuedOnce(): void {
    const running =
      this.ledger.listTasks('running').length +
      this.ledger.listTasks('waiting_user').length
    const capacity = Math.max(
      0,
      this.config.execution.maxParallelTasks - running,
    )
    if (capacity <= 0) return
    const queued = this.ledger.listTasks('queued').slice(0, capacity)
    for (const task of queued) {
      this.adapter.startTask({ task, prompt: task.prompt })
    }
  }
}
