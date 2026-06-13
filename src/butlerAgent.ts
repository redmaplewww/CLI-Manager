import {
  ChatRouter,
  isConversationOnlyInput,
  type ChatAction,
} from './chatRouter'
import { LlmPlanner } from './llmPlanner'
import { sendDaemonRequest } from './daemonClient'
import { TaskLedger } from './db'
import { scanAuraSessions } from './sessionScanner'
import { sessionsCommand, formatSessions } from './commands/sessions'
import { normalizeCliPrompt } from './promptNormalizer'
import type { ResolvedButlerConfig } from './types'
import {
  formatEventList,
  formatProjectList,
  formatResult,
  formatTaskList,
  formatWorker,
} from './ui/formatter'

export interface ButlerAgentResponse {
  reply: string
  actions: ChatAction[]
}

export interface ButlerAgentOptions {
  language?: 'zh' | 'en'
}

export class ButlerAgent {
  private readonly router = new ChatRouter()
  private readonly planner: LlmPlanner

  constructor(
    private readonly config: ResolvedButlerConfig,
    private readonly ledger: TaskLedger,
  ) {
    this.planner = new LlmPlanner(config)
  }

  llmEnabled(): boolean {
    return this.planner.isEnabled()
  }

  async handle(
    input: string,
    options: ButlerAgentOptions = {},
  ): Promise<ButlerAgentResponse> {
    const trimmed = input.trim()
    if (!trimmed) return { reply: this.helpText(), actions: [] }
    if (/^(exit|quit|退出|q)$/i.test(trimmed))
      return { reply: '__exit__', actions: [] }

    const plan = isConversationOnlyInput(trimmed)
      ? null
      : await this.planner.plan(trimmed, {
          tasks: this.ledger.listTasks(),
        })
    if (plan && plan.actions.length > 0) {
      if (
        plan.actions.length === 1 &&
        plan.actions[0]?.type === 'manager_reply'
      ) {
        const direct = await this.planner.reply(trimmed, {
          tasks: this.ledger.listTasks(),
          language: options.language ?? 'zh',
        })
        return {
          reply: this.finalizeReply(direct ?? plan.actions[0].message, options),
          actions: [],
        }
      }
      const en = options.language === 'en'
      const outputs: string[] = [
        en ? `Plan: ${this.ascii(plan.summary)}` : `计划：${plan.summary}`,
      ]
      const grouped = this.groupAddTasksIfNeeded(trimmed, plan.actions)
      if (grouped.managerTaskId)
        outputs.push(
          en
            ? `Created manager task ${grouped.managerTaskId} for grouped child sessions.`
            : `已创建父级管家任务 ${grouped.managerTaskId}，下面的执行项将作为子 session task 管理。`,
        )
      for (const action of grouped.actions)
        outputs.push(await this.execute(action, options))
      return {
        reply: outputs.filter(Boolean).join('\n\n'),
        actions: grouped.actions,
      }
    }

    const action = this.router.route(trimmed)
    if (action.type === 'manager_reply') {
      const direct = await this.planner.reply(trimmed, {
        tasks: this.ledger.listTasks(),
        language: options.language ?? 'zh',
      })
      return {
        reply: this.finalizeReply(direct ?? action.message, options),
        actions: [],
      }
    }
    return {
      reply: this.finalizeReply(await this.execute(action, options), options),
      actions: [action],
    }
  }

  private groupAddTasksIfNeeded(
    originalInput: string,
    actions: ChatAction[],
  ): { actions: ChatAction[]; managerTaskId: string | null } {
    const addTasks = actions.filter(action => action.type === 'add_task')
    if (addTasks.length < 2) return { actions, managerTaskId: null }
    const batchAction: ChatAction = {
      type: 'add_batch',
      title: originalInput.slice(0, 80),
      prompts: addTasks.map(a => a.prompt),
    } as any
    const nonAdd = actions.filter(action => action.type !== 'add_task')
    return { actions: [batchAction, ...nonAdd], managerTaskId: '__pending__' }
  }

  async execute(
    action: ChatAction,
    options: ButlerAgentOptions = {},
  ): Promise<string> {
    const en = options.language === 'en'
    switch (action.type) {
      case 'help':
        return en ? this.helpTextEn() : this.helpText()
      case 'manager_reply':
        return action.message
      case 'status':
        if (en) return this.formatTaskListEn()
        return formatTaskList(this.ledger.listTasks())
      case 'workers':
        if (en) return this.formatWorkersEn()
        return (
          this.ledger
            .listTasks()
            .map(t => formatWorker(this.ledger.getLatestWorker(t.id)))
            .join('\n\n') || '暂无 CLI worker。'
        )
      case 'daemon_status':
        return this.formatDaemon(
          await sendDaemonRequest(this.config, { type: 'ping' }),
          en,
        )
      case 'start_daemon':
        return en
          ? 'The daemon is managed by the dashboard.'
          : 'daemon 由统一窗口自动管理。'
      case 'stop_daemon':
        return this.formatDaemon(
          await sendDaemonRequest(this.config, { type: 'shutdown' }),
          en,
        )
      case 'add_task':
        const addReq: {
          type: 'add'
          prompt: string
          parentTaskId?: string
        } = { type: 'add', prompt: normalizeCliPrompt(action.prompt) }
        if (action.parentTaskId) addReq.parentTaskId = action.parentTaskId
        return this.formatDaemon(
          await sendDaemonRequest(this.config, addReq),
          en,
        )
      case 'add_batch':
        return this.formatDaemon(
          await sendDaemonRequest(this.config, {
            type: 'add_batch',
            title: (action as any).title ?? '',
            prompts: ((action as any).prompts ?? []).map(normalizeCliPrompt),
          }),
          en,
        )
      case 'events':
        if (en) return this.formatEventsEn(action.taskId)
        return formatEventList(this.ledger.listEvents(action.taskId, 80))
      case 'logs': {
        const worker = this.ledger.getLatestWorker(action.taskId)
        if (en)
          return worker
            ? this.formatWorkerEn(worker)
            : `No worker for task ${action.taskId}.`
        return worker
          ? formatWorker(worker)
          : `任务 ${action.taskId} 暂无 worker。`
      }
      case 'result':
        if (en) return this.formatResultEn(action.taskId)
        return formatResult(this.ledger.getTask(action.taskId))
      case 'stop_task':
        return this.formatDaemon(
          await sendDaemonRequest(this.config, {
            type: 'stop',
            taskId: action.taskId,
          }),
          en,
        )
      case 'retry_task':
        return this.formatDaemon(
          await sendDaemonRequest(this.config, {
            type: 'retry',
            taskId: action.taskId,
            resume: action.resume,
          }),
          en,
        )
      case 'answer_task':
        return this.formatDaemon(
          await sendDaemonRequest(this.config, {
            type: 'answer',
            taskId: action.taskId,
            answer: action.answer,
          }),
          en,
        )
      case 'mux_engines':
      case 'mux_list':
      case 'mux_start':
        return en
          ? 'Mux is managed outside the dashboard for now. The dashboard handles delegation, monitoring, and reporting.'
          : 'Mux 当前仍是外部窗口能力；统一窗口先负责分派、监控和汇报。'
      case 'sessions_list': {
        const sessions = await scanAuraSessions(this.config.workspace.root)
        return en ? this.ascii(formatSessions(sessions)) : formatSessions(sessions)
      }
      case 'sessions_import':
        await sessionsCommand('import')
        return en
          ? 'Existing CLI sessions have been imported and bound to Butler tasks.'
          : '已导入现有 CLI session，并绑定为 Butler task。'
      case 'project_start': {
        const request: {
          type: 'project_start'
          goal: string
          maxIterations?: number
        } = { type: 'project_start', goal: action.goal }
        if (action.maxIterations !== undefined)
          request.maxIterations = action.maxIterations
        return this.formatDaemon(
          await sendDaemonRequest(this.config, request),
          en,
        )
      }
      case 'project_list': {
        const response = await sendDaemonRequest(this.config, {
          type: 'project_list',
        })
        if (!response)
          return en ? 'The daemon is not running.' : 'daemon 未运行。'
        if (!response.ok)
          return en ? `Error: ${response.error}` : `错误：${response.error}`
        if (en) return JSON.stringify(response.data ?? [], null, 2)
        return formatProjectList((response.data as any[]) ?? [])
      }
      case 'unknown':
        return action.message
    }
  }

  private formatDaemon(
    response: Awaited<ReturnType<typeof sendDaemonRequest>>,
    en = false,
  ): string {
    if (!response) return en ? 'The daemon is not running.' : 'daemon 未运行。'
    if (!response.ok)
      return en ? `Error: ${response.error}` : `错误：${response.error}`
    if (en)
      return response.message
        ? `Done: ${this.ascii(response.message)}`
        : `Done: ${JSON.stringify(response.data ?? {})}`
    return response.message
      ? `已处理：${response.message}`
      : `已处理：${JSON.stringify(response.data ?? {})}`
  }

  private helpText(): string {
    return '我是 Aura Butler 管家。你可以直接和我对话；我会先理解你的目标，必要时再分派 CLI worker。示例：\n- 现在进度\n- 请检查当前项目测试失败原因\n- 你负责当前项目全流程，失败后修正并汇报\n- 看 T004 结果'
  }

  private helpTextEn(): string {
    return 'I am Aura Butler, your manager agent. Talk to me first; I delegate to CLI workers only when execution is needed. Examples:\n- current progress\n- inspect package.json\n- own the full project workflow and report when done\n- show T004 result'
  }

  private formatTaskListEn(): string {
    const tasks = this.ledger.listTasks()
    if (tasks.length === 0) return 'No tasks.'
    return tasks
      .map(t =>
        [
          `Task ${t.id} | ${t.status} | ${this.ascii(t.title)}`,
          `  PID: ${t.pid ?? '-'}  Session: ${t.cliSessionId ?? '-'}`,
          `  Error: ${this.ascii(t.errorMessage ?? 'none')}`,
          t.resultSummary
            ? `  Result: ${this.ascii(t.resultSummary).slice(0, 240)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n')
  }

  private formatWorkersEn(): string {
    const workers = this.ledger
      .listTasks()
      .map(t => this.ledger.getLatestWorker(t.id))
      .filter(Boolean)
    if (workers.length === 0) return 'No CLI workers.'
    return workers
      .map(worker => this.formatWorkerEn(worker as NonNullable<typeof worker>))
      .join('\n\n')
  }

  private formatWorkerEn(worker: {
    id: string
    status: string
    pid: number | null
    command: string
    cwd: string
    stdoutPath: string
    stderrPath: string
  }): string {
    return [
      `Worker ${worker.id}`,
      `  Status: ${worker.status}  PID: ${worker.pid ?? '-'}`,
      `  Command: ${this.ascii(worker.command)}`,
      `  CWD: ${worker.cwd}`,
      `  stdout: ${worker.stdoutPath}`,
      `  stderr: ${worker.stderrPath}`,
    ].join('\n')
  }

  private formatEventsEn(taskId: string): string {
    const events = this.ledger.listEvents(taskId, 80)
    if (events.length === 0) return `No events for ${taskId}.`
    return events
      .map(
        e =>
          `${e.createdAt} ${e.type}: ${this.ascii(e.text ?? e.payloadJson ?? '').slice(0, 220)}`,
      )
      .join('\n')
  }

  private formatResultEn(taskId: string): string {
    const task = this.ledger.getTask(taskId)
    if (!task) return `Task ${taskId} not found.`
    return [
      `Task ${task.id} result`,
      `  Status: ${task.status}`,
      `  Summary: ${this.ascii(task.resultSummary ?? 'none')}`,
      `  Error: ${this.ascii(task.errorMessage ?? 'none')}`,
      `  Artifact: ${task.resultArtifact ?? 'none'}`,
    ].join('\n')
  }

  private finalizeReply(reply: string, options: ButlerAgentOptions): string {
    if (options.language !== 'en') return reply
    const ascii = reply
      .replace(/[^\x00-\x7F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (ascii.length >= 12) return ascii
    return 'I am Aura Butler, your manager agent. I will talk with you first, then delegate work to CLI workers only when execution is clearly needed.'
  }

  private ascii(value: string): string {
    return value
      .replace(/[^\x00-\x7F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
}
