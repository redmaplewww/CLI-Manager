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
        if (!force && !this.shouldReport(task)) continue
        await this.reportTask(task, tasks)
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
    if (task.status === 'completed' && !task.progressSummary) return true
    return false
  }

  private async reportTask(task: TaskRecord, allTasks: TaskRecord[]): Promise<void> {
    const now = new Date().toISOString()
    const children = allTasks.filter(child => child.parentTaskId === task.id)
    const related = task.taskKind === 'manager' ? [task, ...children] : [task]
    const output = this.outputFor(task, children)
    let judgement = judgeTaskCompletion(task, output)
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
    if (llmJudgement) {
      judgement = {
        verdict: llmJudgement.verdict,
        done: llmJudgement.verdict === 'done',
        reason: `LLM PROJECT judgement: ${llmJudgement.reason}${llmJudgement.question ? `\nQuestion: ${llmJudgement.question}` : ''}\n\nRule judgement:\n${judgement.reason}`,
        positiveSignals: judgement.positiveSignals,
        negativeSignals: judgement.negativeSignals,
      }
    }
    const summary =
      (await this.planner.summarizeProgress({
        tasks: related,
        workContext: {
          filePath: workContext.filePath,
          content: workContext.content,
        },
      })) ?? this.fallbackSummary(task, children, judgement.reason, workContext)

    this.ledger.updateTask(task.id, {
      progressSummary: summary,
      progressUpdatedAt: now,
      completionVerdict: judgement.verdict,
      completionReason: judgement.reason,
      lastProgressNotifiedAt: now,
    })
    this.ledger.addEvent(
      task.id,
      'assistant_text',
      { progressReport: true, verdict: judgement.verdict },
      summary,
    )
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

  private fallbackSummary(
    task: TaskRecord,
    children: TaskRecord[],
    reason: string,
    workContext: { filePath: string | null; content: string },
  ): string {
    if (children.length > 0) {
      const counts = new Map<string, number>()
      for (const child of children)
        counts.set(child.status, (counts.get(child.status) ?? 0) + 1)
      return [
        `父任务 ${task.id} 进度：${children.length} 个子任务；${Array.from(counts.entries())
          .map(([status, count]) => `${status}:${count}`)
          .join('，')}`,
        workContext.filePath ? `项目管理文件：${workContext.filePath}` : '项目管理文件：未找到',
        `预期比对：${reason}`,
        '下一步：继续巡视未完成子任务，stuck/failed 会进入自动恢复。',
      ].join('\n')
    }
    return [
      `任务 ${task.id} 当前状态：${task.status}`,
      workContext.filePath ? `项目管理文件：${workContext.filePath}` : '项目管理文件：未找到',
      workContext.content ? `项目认知摘要：${workContext.content.slice(-600)}` : '',
      `预期比对：${reason}`,
      task.errorMessage ? `阻塞/错误：${task.errorMessage}` : '暂未发现明确阻塞。',
      '下一步：继续巡视输出、完成判定和恢复条件。',
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
