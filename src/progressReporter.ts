import type { ResolvedButlerConfig, TaskRecord } from './types'
import { TaskLedger } from './db'
import { LlmPlanner } from './llmPlanner'
import { judgeTaskCompletion } from './completionJudge'
import { discoverWorkContext } from './workContext'

const REPORT_INTERVAL_MS = 15 * 60_000

export class ProgressReporter {
  private readonly planner: LlmPlanner
  private running = false

  constructor(
    private readonly config: ResolvedButlerConfig,
    private readonly ledger: TaskLedger,
  ) {
    this.planner = new LlmPlanner(config)
  }

  async scanOnce(force = false): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const tasks = this.ledger.listTasks()
      for (const task of tasks) {
        if (task.userArchivedAt) continue
        if (!task.inspectionEnabled) continue
        if (task.status === 'completed') continue
        if (!force && !this.shouldReport(task)) continue
        await this.reportTask(task, tasks, force)
      }
    } finally {
      this.running = false
    }
  }

  private shouldReport(task: TaskRecord): boolean {
    if (task.taskKind === 'manager') {
      const children = this.ledger.listChildTasks(task.id)
      if (children.length === 0) return false
      const childChanged = children.some(child =>
        changedSince(child.updatedAt, task.progressUpdatedAt),
      )
      return childChanged || stale(task.progressUpdatedAt, REPORT_INTERVAL_MS)
    }
    if (['queued', 'running', 'waiting_user', 'stuck', 'failed', 'cancelled'].includes(task.status)) {
      if (changedSince(task.updatedAt, task.progressUpdatedAt)) return true
      return stale(task.progressUpdatedAt, REPORT_INTERVAL_MS)
    }
    return false
  }

  private async reportTask(
    task: TaskRecord,
    allTasks: TaskRecord[],
    force: boolean,
  ): Promise<void> {
    const now = new Date().toISOString()
    const children = allTasks.filter(child => child.parentTaskId === task.id)
    const output = this.outputFor(task, children)
    const ruleJudgement = judgeTaskCompletion(task, output)
    const workContext = discoverWorkContext(task)

    const needsLlm = force
      || task.status === 'stuck'
      || task.status === 'failed'
      || (task.status === 'running' && ruleJudgement.negativeSignals.length > 0)
      || (task.status === 'running' && ruleJudgement.verdict === 'needs_review')

    if (!needsLlm) {
      const summary = this.lightweightSummary(task, children, ruleJudgement)
      this.ledger.updateTask(task.id, {
        progressSummary: summary,
        progressUpdatedAt: now,
        completionVerdict: ruleJudgement.verdict,
        completionReason: ruleJudgement.reason,
        lastProgressNotifiedAt: now,
      })
      this.ledger.addEvent(
        task.id,
        'watchdog_observation',
        { progressReport: true, verdict: ruleJudgement.verdict, lightweight: true },
        summary,
      )
      return
    }

    const llmJudgement = await this.planner.judgeTaskCompletionWithContext({
      task,
      ruleJudgement: ruleJudgement.reason,
      sessionSummary: output,
      workContext: {
        filePath: workContext.filePath,
        content: workContext.content,
      },
    })

    let verdict = ruleJudgement.verdict
    let reason = ruleJudgement.reason
    if (llmJudgement) {
      verdict = llmJudgement.verdict
      reason = `LLM: ${llmJudgement.reason}${llmJudgement.question ? `\nQuestion: ${llmJudgement.question}` : ''}\n\n规则:\n${ruleJudgement.reason}`
    }

    const summary =
      (await this.planner.summarizeProgress({
        tasks: task.taskKind === 'manager' ? [task, ...children] : [task],
        workContext: {
          filePath: workContext.filePath,
          content: workContext.content,
        },
      })) ?? this.lightweightSummary(task, children, { verdict, reason })

    this.ledger.updateTask(task.id, {
      progressSummary: summary,
      progressUpdatedAt: now,
      completionVerdict: verdict,
      completionReason: reason,
      lastProgressNotifiedAt: now,
    })
    this.ledger.addEvent(
      task.id,
      'assistant_text',
      { progressReport: true, verdict, llmBased: true },
      summary,
    )
  }

  private lightweightSummary(
    task: TaskRecord,
    children: TaskRecord[],
    judgement: { verdict: string; reason: string },
  ): string {
    const lastOutputAge = task.lastOutputAt
      ? `${Math.round((Date.now() - Date.parse(task.lastOutputAt)) / 1000)}s前`
      : '无'

    if (children.length > 0) {
      const counts = new Map<string, number>()
      for (const child of children)
        counts.set(child.status, (counts.get(child.status) ?? 0) + 1)
      return [
        `[轻量巡检] ${task.id} | ${task.status} | 最近输出: ${lastOutputAge}`,
        `子任务: ${children.length}个 (${Array.from(counts.entries()).map(([s, c]) => `${s}:${c}`).join(', ')})`,
        judgement.reason.split('\n').slice(0, 3).join('\n'),
      ].join('\n')
    }

    return [
      `[轻量巡检] ${task.id} | ${task.status} | 最近输出: ${lastOutputAge}`,
      task.errorMessage ? `错误: ${task.errorMessage}` : '无明确错误',
      judgement.reason.split('\n').slice(0, 3).join('\n'),
    ].join('\n')
  }

  private outputFor(task: TaskRecord, children: TaskRecord[]): string {
    return [
      task.resultSummary ?? '',
      task.errorMessage ?? '',
      ...children.map(
        child =>
          `${child.id} ${child.status}\n${child.progressSummary ?? ''}\n${child.resultSummary ?? ''}\n${child.errorMessage ?? ''}`,
      ),
    ].join('\n')
  }
}

function stale(value: string | null, ms: number): boolean {
  if (!value) return true
  return Date.now() - Date.parse(value) > ms
}

function changedSince(value: string | null, baseline: string | null): boolean {
  if (!value) return false
  if (!baseline) return true
  return Date.parse(value) > Date.parse(baseline)
}
