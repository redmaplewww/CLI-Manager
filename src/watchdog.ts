import type { ResolvedButlerConfig } from './types'
import { TaskLedger } from './db'
import { Supervisor } from './supervisor'
import { judgeTaskCompletion, recoveryPromptForIncomplete } from './completionJudge'
import { LlmPlanner } from './llmPlanner'
import { discoverWorkContext } from './workContext'

export class Watchdog {
  private readonly recovering = new Set<string>()
  private readonly planner: LlmPlanner

  constructor(
    private readonly config: ResolvedButlerConfig,
    private readonly ledger: TaskLedger,
    private readonly supervisor?: Supervisor,
  ) {
    this.planner = new LlmPlanner(config)
  }

  scanOnce(): void {
    const now = Date.now()
    for (const task of this.ledger.listTasks()) {
      if (task.taskKind === 'manager') continue
      if (task.userArchivedAt) continue
      if (!task.inspectionEnabled) continue
      if (task.status !== 'running') {
        void this.recoverIfIncomplete(task.id)
        continue
      }
      const lastOutputAt = task.lastOutputAt
        ? Date.parse(task.lastOutputAt)
        : Date.parse(task.startedAt ?? task.createdAt)
      const startedAt = Date.parse(task.startedAt ?? task.createdAt)
      const noOutputMs = now - lastOutputAt
      const runtimeMs = now - startedAt

      if (runtimeMs > this.config.execution.taskTimeoutMinutes * 60_000) {
        this.ledger.addEvent(task.id, 'task_failed', { reason: 'task_timeout' })
        this.ledger.updateTask(task.id, {
          status: 'stuck',
          errorMessage: 'Task timed out',
        })
        void this.recoverIfIncomplete(task.id)
        continue
      }

      if (noOutputMs > this.config.execution.stuckAfterMinutes * 60_000) {
        this.ledger.addEvent(task.id, 'watchdog_stuck', { noOutputMs })
        this.ledger.updateTask(task.id, {
          status: 'stuck',
          errorMessage: `No output for ${Math.round(noOutputMs / 60000)} minutes`,
        })
        void this.recoverIfIncomplete(task.id)
      }
    }
  }

  private async recoverIfIncomplete(taskId: string): Promise<void> {
    if (!this.supervisor || this.recovering.has(taskId)) return
    const task = this.ledger.getTask(taskId)
    if (!task || task.taskKind === 'manager' || task.userArchivedAt) return
    if (!['stuck', 'failed', 'cancelled'].includes(task.status)) return
    if (task.retryCount >= this.config.retry.maxRetries) return
    const output = [
      task.resultSummary ?? '',
      task.errorMessage ?? '',
      ...this.ledger.listEvents(task.id, 80).map(event => event.text ?? ''),
    ].join('\n')
    const judgement = judgeTaskCompletion(task, output)
    if (judgement.done) return
    const workContext = discoverWorkContext(task)
    const llmJudgement = await this.planner.judgeTaskCompletionWithContext({
      task,
      ruleJudgement: judgement.reason,
      sessionSummary: output,
      workContext: {
        filePath: workContext.filePath,
        content: workContext.content,
      },
    })
    if (llmJudgement?.verdict === 'done') {
      this.ledger.updateTask(taskId, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        completionVerdict: 'done',
        completionReason: `LLM PROJECT judgement: ${llmJudgement.reason}`,
      })
      this.ledger.addEvent(
        taskId,
        'task_completed',
        { llmProjectJudgement: true, workContextFile: workContext.filePath },
        llmJudgement.reason,
      )
      return
    }
    if (llmJudgement?.verdict === 'uncertain' && llmJudgement.question) {
      const questionPrompt = [
        'Butler needs a concise clarification to decide whether the task is complete.',
        `Question: ${llmJudgement.question}`,
        'Answer based on your current session state only. Do not read full logs unless necessary; summarize evidence from existing outputs.',
      ].join('\n\n')
      this.ledger.addEvent(
        taskId,
        'question',
        { llmProjectJudgement: true, workContextFile: workContext.filePath },
        questionPrompt,
      )
      if (this.config.retry.resumeOnRetry && task.cliSessionId)
        this.supervisor.resumeTaskWithMessage(taskId, questionPrompt)
      return
    }
    const prompt =
      (await this.planner.draftTaskContinuationPrompt({
        task,
        judgement: judgement.reason,
        workContext: {
          filePath: workContext.filePath,
          content: workContext.content,
        },
      })) ?? recoveryPromptForIncomplete(task, judgement.reason)
    this.recovering.add(taskId)
    try {
      this.ledger.addEvent(
        taskId,
        'retry_started',
        {
          autoRecovery: true,
          verdict: judgement.verdict,
          workContextFile: workContext.filePath,
        },
        prompt,
      )
      if (this.config.retry.resumeOnRetry && task.cliSessionId)
        this.supervisor.resumeTaskWithMessage(taskId, prompt)
      else {
        this.ledger.updateTask(taskId, {
          status: 'queued',
          retryCount: task.retryCount + 1,
          errorMessage: null,
        })
        this.supervisor.startTaskNow(taskId, prompt, false)
      }
    } finally {
      setTimeout(() => this.recovering.delete(taskId), 60_000).unref()
    }
  }
}
