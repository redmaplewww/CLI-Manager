import { LlmPlanner } from './llmPlanner'
import { judgeTaskCompletion } from './completionJudge'
import { ProjectStore } from './projectStore'
import { TaskLedger } from './db'
import type { ProjectRecord, ResolvedButlerConfig, TaskRecord } from './types'
import { Scheduler } from './scheduler'
import { discoverWorkContext } from './workContext'

export class AutonomousProjectManager {
  private readonly store: ProjectStore
  private readonly planner: LlmPlanner
  private readonly activeLoops = new Set<string>()

  constructor(
    private readonly config: ResolvedButlerConfig,
    private readonly ledger: TaskLedger,
    private readonly scheduler: Scheduler,
  ) {
    this.store = new ProjectStore(config)
    this.planner = new LlmPlanner(config)
  }

  start(goal: string, maxIterations = 5): ProjectRecord {
    const now = new Date().toISOString()
    const project: ProjectRecord = {
      id: `P${Date.now().toString(36)}`,
      goal,
      status: 'running',
      taskIds: [],
      maxIterations,
      iteration: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      finalSummary: null,
      lastNotification: null,
      lastNotificationAt: null,
      errorMessage: null,
    }
    this.store.save(project)
    const managerTask = this.ledger.createManagerTask({
      title: goal.slice(0, 80),
      prompt: goal,
      projectRoot: this.config.workspace.root,
      completionCriteria: `1. 总目标完成：${goal}\n2. 所有子 session task 均完成，或对失败项给出明确阻塞原因和恢复计划。`,
    })
    project.taskIds.push(managerTask.id)
    this.store.save(project)
    if (this.activeLoops.has(project.id)) return project
    this.activeLoops.add(project.id)
    void this.runLoop(project.id)
    return project
  }

  list(): ProjectRecord[] {
    return this.store.list()
  }

  async runLoop(projectId: string): Promise<void> {
    let project = this.store.get(projectId)
    if (!project) { this.activeLoops.delete(projectId); return }

    try {
      await this.createInitialConsultation(project)
      while (
        project.status === 'running' &&
        project.iteration < project.maxIterations
      ) {
        await this.waitForProjectTasks(project)
        project = this.store.get(projectId)
        if (!project) return
        const tasks = this.projectSessionTasks(project)
        const judgements = await Promise.all(
          tasks.map(async t => {
            const output = [t.resultSummary ?? '', t.errorMessage ?? ''].join('\n')
            const ruleJudgement = judgeTaskCompletion(t, output)
            if (ruleJudgement.done) return { task: t, judgement: ruleJudgement }
            const workContext = discoverWorkContext(t)
            const llmJudgement = await this.planner.judgeTaskCompletionWithContext({
              task: t,
              ruleJudgement: ruleJudgement.reason,
              sessionSummary: output,
              workContext: { filePath: workContext.filePath, content: workContext.content },
            })
            if (llmJudgement) {
              return {
                task: t,
                judgement: {
                  verdict: llmJudgement.verdict,
                  done: llmJudgement.verdict === 'done',
                  reason: `LLM PROJECT judgement: ${llmJudgement.reason}`,
                  positiveSignals: ruleJudgement.positiveSignals,
                  negativeSignals: ruleJudgement.negativeSignals,
                },
              }
            }
            return { task: t, judgement: ruleJudgement }
          }),
        )
        if (tasks.length > 0 && judgements.every(item => item.judgement.done)) {
          await this.finish(project, tasks, 'completed')
          return
        }
        const failed = judgements
          .filter(
            item =>
              ['failed', 'stuck', 'cancelled'].includes(item.task.status) ||
              item.judgement.verdict === 'needs_review',
          )
          .map(item => item.task)
        if (failed.length === 0) continue
        project.iteration += 1
        this.store.save(project)
        await this.createRecoveryTasks(project, tasks, failed)
        project = this.store.get(projectId)
        if (!project) return
      }

      project = this.store.get(projectId)
      if (!project) return
      await this.finish(project, this.projectSessionTasks(project), 'failed')
    } catch (err) {
      project = this.store.get(projectId)
      if (!project) return
      const message = err instanceof Error ? err.message : String(err)
      project.status = 'failed'
      project.completedAt = new Date().toISOString()
      project.errorMessage = message
      project.lastNotification = `项目无法继续：${message}`
      project.lastNotificationAt = new Date().toISOString()
      this.store.save(project)
    } finally {
      this.activeLoops.delete(projectId)
    }
  }

  private async createInitialConsultation(
    project: ProjectRecord,
  ): Promise<void> {
    const prompt = `You are the execution CLI for an autonomous project child session. Consult on this project goal and produce a concrete execution plan. Then perform the first useful step if possible. Goal: ${project.goal}. Requirements: explain risks, commands/files to inspect, success criteria, and what follow-up tasks should be run if this attempt fails.`
    const task = this.ledger.createTask({
      title: `Project ${project.id} initial consultation`,
      prompt,
      projectRoot: this.config.workspace.root,
      category: 'research',
      priority: 'high',
      taskKind: 'session',
      parentTaskId: project.taskIds[0] ?? null,
      completionCriteria:
        `1. 完成项目目标：${project.goal}\n2. 读取并遵循工作目录中的项目管理文件（如 PROJECT.md / work-log.md / progress.md）。\n3. 输出已完成内容、剩余缺口、生成文件/日志路径；若无法完成，明确报告阻塞原因。`,
    })
    project.taskIds.push(task.id)
    this.store.save(project)
    this.scheduler.runQueuedOnce()
  }

  private async createRecoveryTasks(
    project: ProjectRecord,
    tasks: TaskRecord[],
    failed: TaskRecord[],
  ): Promise<void> {
    const recoveryPrompt = await this.planner.draftRecoveryPrompt({
      goal: project.goal,
      tasks,
      failed,
      iteration: project.iteration,
    })
    const task = this.ledger.createTask({
      title: `Project ${project.id} recovery ${project.iteration}`,
      prompt: recoveryPrompt,
      projectRoot: this.config.workspace.root,
      category: 'research',
      priority: 'high',
      taskKind: 'session',
      parentTaskId: project.taskIds[0] ?? null,
    })
    project.taskIds.push(task.id)
    this.store.save(project)
    this.scheduler.runQueuedOnce()
  }

  private async waitForProjectTasks(project: ProjectRecord): Promise<void> {
    for (let i = 0; i < 720; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000))
        const tasks = this.projectSessionTasks(project)
      if (
        tasks.length > 0 &&
        tasks.every(t =>
          ['completed', 'failed', 'stuck', 'cancelled', 'summarized'].includes(
            t.status,
          ),
        )
      )
        return
    }
  }

  private projectTasks(project: ProjectRecord): TaskRecord[] {
    return project.taskIds
      .map(id => this.ledger.getTask(id))
      .filter((t): t is TaskRecord => Boolean(t))
  }

  private projectSessionTasks(project: ProjectRecord): TaskRecord[] {
    return this.projectTasks(project).filter(t => t.taskKind === 'session')
  }

  private async summarize(
    project: ProjectRecord,
    tasks: TaskRecord[],
    status: string,
  ): Promise<string> {
    return this.planner.summarizeProjectFinal({
      goal: project.goal,
      tasks,
      status,
    })
  }

  private async finish(
    project: ProjectRecord,
    tasks: TaskRecord[],
    status: 'completed' | 'failed',
  ): Promise<void> {
    project.status = status
    project.completedAt = new Date().toISOString()
    project.finalSummary = await this.summarize(project, tasks, status)
    project.lastNotification = project.finalSummary
    project.lastNotificationAt = new Date().toISOString()
    this.store.save(project)
    const managerTaskId = project.taskIds[0]
    if (managerTaskId) {
      this.ledger.updateTask(managerTaskId, {
        status,
        finishedAt: project.completedAt,
        resultSummary: project.finalSummary,
      })
    }
  }
}
