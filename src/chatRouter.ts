export type ChatAction =
  | { type: 'help' }
  | { type: 'manager_reply'; message: string }
  | { type: 'status' }
  | { type: 'workers' }
  | { type: 'daemon_status' }
  | { type: 'start_daemon' }
  | { type: 'stop_daemon' }
  | { type: 'add_task'; prompt: string; parentTaskId?: string }
  | { type: 'events'; taskId: string }
  | { type: 'logs'; taskId: string }
  | { type: 'result'; taskId: string }
  | { type: 'stop_task'; taskId: string }
  | { type: 'retry_task'; taskId: string; resume: boolean }
  | { type: 'answer_task'; taskId: string; answer: string }
  | { type: 'add_batch'; title: string; prompts: string[] }
  | { type: 'mux_engines' }
  | { type: 'mux_list' }
  | { type: 'mux_start'; name?: string; prompt?: string; engine?: string }
  | { type: 'sessions_list' }
  | { type: 'sessions_import' }
  | { type: 'project_start'; goal: string; maxIterations?: number }
  | { type: 'project_list' }
  | { type: 'unknown'; message: string }

export class ChatRouter {
  route(input: string): ChatAction {
    const text = input.trim()
    const lower = text.toLowerCase()
    if (!text) return { type: 'help' }
    if (/^(help|帮助|怎么用|用法)$/.test(lower)) return { type: 'help' }
    if (/^(exit|quit|退出|q)$/.test(lower))
      return { type: 'unknown', message: '__exit__' }

    if (/(启动|开启|start).*(daemon|管家|后台)/i.test(text))
      return { type: 'start_daemon' }
    if (/(关闭|停止|stop).*(daemon|管家|后台)/i.test(text))
      return { type: 'stop_daemon' }
    if (/(daemon|管家|后台).*(状态|status)/i.test(text))
      return { type: 'daemon_status' }
    if (
      /^(status|状态|进度|现在进度|现在进展|现在怎么样|任务列表)$/i.test(text)
    )
      return { type: 'status' }
    if (/^(你好|hi|hello|在吗|你是谁|你能做什么)$/i.test(text))
      return {
        type: 'manager_reply',
        message:
          '我是 Aura Butler 管家。你可以和我讨论目标，我会判断是否需要分派 CLI 任务；只有当你明确要求检查、修复、执行、负责项目或查看状态时，我才会创建任务。',
      }
    if (/(worker|工人|实例|进程).*(状态|列表|status|list)/i.test(text))
      return { type: 'workers' }

    const taskId = extractTaskId(text)
    if (taskId && /(事件|events|过程)/i.test(text))
      return { type: 'events', taskId }
    if (taskId && /(日志|logs|输出)/i.test(text))
      return { type: 'logs', taskId }
    if (taskId && /(结果|result|总结)/i.test(text))
      return { type: 'result', taskId }
    if (taskId && /(停止|取消|stop|kill)/i.test(text))
      return { type: 'stop_task', taskId }
    if (taskId && /(重试|retry|再跑)/i.test(text))
      return { type: 'retry_task', taskId, resume: /(续跑|resume)/i.test(text) }
    if (taskId && /(回答|answer|回复)/i.test(text))
      return { type: 'answer_task', taskId, answer: stripAnswer(text, taskId) }

    if (/(mux|窗口|tmux).*(引擎|engines|支持)/i.test(text))
      return { type: 'mux_engines' }
    if (/(mux|窗口|tmux).*(列表|list|状态)/i.test(text))
      return { type: 'mux_list' }
    if (/(开|启动|start).*(窗口|mux|tmux|cli)/i.test(text))
      return parseMuxStart(text)

    if (/(导入|绑定|接管|同步).*(session|会话)/i.test(text))
      return { type: 'sessions_import' }
    if (/(session|会话).*(列表|list|状态|历史|已有)/i.test(text))
      return { type: 'sessions_list' }

    if (/(workflow-auto|\/workflow-auto)/i.test(text))
      return { type: 'add_task', prompt: stripTaskPrefix(text) }

    if (/(项目列表|project list|projects)/i.test(text))
      return { type: 'project_list' }
    if (
      /(全流程|全程|直到完成|负责.*项目|项目.*负责|autonomous|自主)/i.test(text)
    ) {
      return { type: 'project_start', goal: text, maxIterations: 5 }
    }

    if (
      /^(add|新任务|创建任务|启动任务|执行|帮我|请|让|检查|修复|review|测试)/i.test(
        text,
      )
    ) {
      return { type: 'add_task', prompt: stripTaskPrefix(text) }
    }

    return {
      type: 'manager_reply',
      message:
        '我已收到。请告诉我你希望我做什么：例如“负责当前项目全流程”“检查测试失败原因”“查看现在进度”。我不会把普通聊天直接发给 CLI task。',
    }
  }
}

export function isConversationOnlyInput(input: string): boolean {
  const text = input.trim()
  if (!text) return true
  if (isExplicitTaskRequest(text)) return false
  if (/^(计划|plan)[:：]/i.test(text)) return true
  if (/^(已处理|执行成功|done)[:：]/i.test(text)) return true
  if (/(不要|别|不必|无需).*(新建|创建|生成).*(task|任务)/i.test(text))
    return true
  if (/(task|任务).*(应该|只|仅|限定|不要).*(cli|CLI|对话|聊天)/i.test(text))
    return true
  if (/(以后|后续|之后).*(不要|别|不必|无需).*(task|任务)/i.test(text))
    return true
  return false
}

function isExplicitTaskRequest(text: string): boolean {
  return /^(add|新任务|创建任务|启动任务|执行|检查|修复|测试|review)\b/i.test(
    text,
  )
}

function extractTaskId(text: string): string | null {
  return text.match(/\bT\d{3,}(?:-\d+)?\b/i)?.[0].toUpperCase() ?? null
}

function stripTaskPrefix(text: string): string {
  return text
    .replace(/^(add|新任务|创建任务|启动任务|执行)[:：\s]*/i, '')
    .trim()
}

function stripAnswer(text: string, taskId: string): string {
  return text
    .replace(new RegExp(taskId, 'i'), '')
    .replace(/^(回答|answer|回复)[:：\s]*/i, '')
    .trim()
}

function parseMuxStart(text: string): ChatAction {
  const name = text.match(/(?:name|名字|名称)[:：= ]+([a-zA-Z0-9_-]+)/i)?.[1]
  const prompt = text.match(/(?:prompt|任务)[:：= ]+(.+)$/i)?.[1]
  const engine = text.match(/(tmux|windows-terminal|detached)/i)?.[1]
  const action: ChatAction = { type: 'mux_start' }
  if (name) action.name = name
  if (prompt) action.prompt = prompt
  if (engine) action.engine = engine
  return action
}
