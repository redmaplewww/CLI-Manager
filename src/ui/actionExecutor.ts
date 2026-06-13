import {
  ChatRouter,
  isConversationOnlyInput,
  type ChatAction,
} from '../chatRouter'
import { LlmPlanner, type ChatPlan } from '../llmPlanner'
import { sendDaemonRequest } from '../daemonClient'
import { TaskLedger } from '../db'
import { scanAuraSessions } from '../sessionScanner'
import { sessionsCommand, formatSessions } from '../commands/sessions'
import { normalizeCliPrompt } from '../promptNormalizer'
import type { ResolvedButlerConfig } from '../types'
import {
  formatEventList,
  formatProjectList,
  formatResult,
  formatTaskList,
  formatWorker,
} from './formatter'

export class ActionExecutor {
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

  async plan(input: string): Promise<ChatPlan> {
    const fallbackAction = this.router.route(input)
    if (
      fallbackAction.type === 'unknown' &&
      fallbackAction.message === '__exit__'
    ) {
      return {
        summary: '退出请求',
        actions: [fallbackAction],
        monitor: false,
        monitorUntil: 'none',
      }
    }
    return (
      (!isConversationOnlyInput(input)
        ? await this.planner.plan(input, { tasks: this.ledger.listTasks() })
        : null) ?? {
        summary: '已使用本地规则生成执行计划',
        actions: [fallbackAction],
        monitor: fallbackAction.type === 'add_task',
        monitorEverySeconds: 10,
        monitorUntil: fallbackAction.type === 'add_task' ? 'all_done' : 'none',
      }
    )
  }

  async execute(action: ChatAction): Promise<string> {
    switch (action.type) {
      case 'help':
        return '你可以说：负责当前项目全流程 / 现在进度 / 看 T001 结果 / 停止 T001 / 开一个 CLI 窗口 name worker-a'
      case 'manager_reply':
        return action.message
      case 'status':
        return formatTaskList(this.ledger.listTasks())
      case 'workers':
        return (
          this.ledger
            .listTasks()
            .map(t => formatWorker(this.ledger.getLatestWorker(t.id)))
            .join('\n\n') || '暂无 CLI worker。'
        )
      case 'daemon_status':
        return this.formatDaemonStatus(
          await sendDaemonRequest(this.config, { type: 'ping' }),
        )
      case 'start_daemon':
        return 'daemon 已由统一窗口自动管理。'
      case 'stop_daemon':
        return JSON.stringify(
          await sendDaemonRequest(this.config, { type: 'shutdown' }),
          null,
          2,
        )
      case 'add_task':
        const addReq: {
          type: 'add'
          prompt: string
          parentTaskId?: string
        } = { type: 'add', prompt: normalizeCliPrompt(action.prompt) }
        if (action.parentTaskId) addReq.parentTaskId = action.parentTaskId
        return this.daemonMessage(
          await sendDaemonRequest(this.config, addReq),
        )
      case 'events':
        return formatEventList(this.ledger.listEvents(action.taskId, 80))
      case 'logs': {
        const worker = this.ledger.getLatestWorker(action.taskId)
        return worker?.stdoutPath
          ? `日志文件：${worker.stdoutPath}`
          : `任务 ${action.taskId} 暂无日志。`
      }
      case 'result': {
        const task = this.ledger.getTask(action.taskId)
        return formatResult(task)
      }
      case 'stop_task':
        return this.daemonMessage(
          await sendDaemonRequest(this.config, {
            type: 'stop',
            taskId: action.taskId,
          }),
        )
      case 'retry_task':
        return this.daemonMessage(
          await sendDaemonRequest(this.config, {
            type: 'retry',
            taskId: action.taskId,
            resume: action.resume,
          }),
        )
      case 'answer_task':
        return this.daemonMessage(
          await sendDaemonRequest(this.config, {
            type: 'answer',
            taskId: action.taskId,
            answer: action.answer,
          }),
        )
      case 'mux_engines':
      case 'mux_list':
      case 'mux_start':
        return 'Mux 操作当前请在命令行使用；统一窗口内暂时只负责监控。'
      case 'sessions_list':
        return formatSessions(await scanAuraSessions(this.config.workspace.root))
      case 'sessions_import':
        await sessionsCommand('import')
        return '已导入现有 CLI session，并绑定为 Butler task。'
      case 'project_start': {
        const req: {
          type: 'project_start'
          goal: string
          maxIterations?: number
        } = { type: 'project_start', goal: action.goal }
        if (action.maxIterations !== undefined)
          req.maxIterations = action.maxIterations
        return this.daemonMessage(await sendDaemonRequest(this.config, req))
      }
      case 'project_list': {
        const response = await sendDaemonRequest(this.config, {
          type: 'project_list',
        })
        if (!response) return 'daemon 未运行。'
        if (!response.ok) return `错误：${response.error}`
        return formatProjectList((response.data as any[]) ?? [])
      }
      case 'unknown':
        return action.message
      case 'add_batch':
        return this.daemonMessage(
          await sendDaemonRequest(this.config, {
            type: 'add_batch',
            title: (action as any).title ?? '',
            prompts: ((action as any).prompts ?? []).map(normalizeCliPrompt),
          }),
        )
    }
  }

  private daemonMessage(
    response: Awaited<ReturnType<typeof sendDaemonRequest>>,
  ): string {
    if (!response) return 'daemon 未运行。'
    if (!response.ok) return `错误：${response.error}`
    return response.message
      ? `执行成功：${response.message}`
      : `执行成功：${JSON.stringify(response.data ?? {})}`
  }

  private formatDaemonStatus(
    response: Awaited<ReturnType<typeof sendDaemonRequest>>,
  ): string {
    if (!response) return 'daemon 未运行。'
    if (!response.ok) return `daemon 异常：${response.error}`
    return 'daemon 正在运行。'
  }
}
