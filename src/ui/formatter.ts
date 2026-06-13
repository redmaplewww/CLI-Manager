import type { ProjectRecord, TaskRecord, WorkerRecord } from '../types'

export interface DisplayEvent {
  type: string
  text: string | null
  payloadJson: string | null
  createdAt: string
}

const statusZh: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_user: '等待确认',
  stuck: '疑似卡住',
  failed: '失败',
  completed: '已完成',
  cancelled: '已取消',
  summarized: '已总结',
}

const eventZh: Record<string, string> = {
  task_queued: '任务入队',
  task_started: '启动 CLI',
  stdout_json: '原始事件',
  raw_stdout: '原始输出',
  stderr: '错误输出',
  assistant_text: '助手回复',
  tool_use: '调用工具',
  tool_result: '工具结果',
  question: '请求确认',
  session_id: '会话编号',
  done: '执行完成',
  exit: '进程退出',
  watchdog_stuck: '监控判定卡住',
  task_failed: '任务失败',
  task_completed: '任务完成',
  task_cancelled: '任务取消',
  retry_started: '开始重试',
  answer_sent: '已发送回答',
}

export function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) return '暂无任务。'
  return tasks.map(formatTaskCard).join('\n\n')
}

export function formatTaskCard(task: TaskRecord): string {
  const lines = [
    `任务 ${task.id} | ${zhStatus(task.status)} | ${task.title}`,
    `  项目目录: ${task.projectRoot}`,
    `  类型: ${task.taskKind}    来源: ${task.source}    父任务: ${task.parentTaskId ?? '-'}`,
    `  进程: ${task.pid ?? '-'}    会话: ${task.cliSessionId ?? '-'}`,
    `  创建: ${shortTime(task.createdAt)}    更新: ${shortTime(task.updatedAt)}`,
  ]
  if (task.completionCriteria)
    lines.push(`  结束判定: ${cleanText(task.completionCriteria, 180)}`)
  if (task.sessionPath) lines.push(`  会话记录: ${task.sessionPath}`)
  if (task.waitingQuestion) lines.push(`  等待回答: ${task.waitingQuestion}`)
  if (task.errorMessage) lines.push(`  失败原因: ${task.errorMessage}`)
  if (task.resultSummary)
    lines.push(`  最新结果: ${cleanText(task.resultSummary, 220)}`)
  return lines.join('\n')
}

export function formatProjectList(projects: ProjectRecord[]): string {
  if (projects.length === 0) return '暂无自主项目。'
  return projects
    .map(project => {
      const lines = [
        `项目 ${project.id} | ${zhStatus(project.status)} | 迭代 ${project.iteration}/${project.maxIterations}`,
        `  目标: ${cleanText(project.goal, 180)}`,
        `  创建: ${shortTime(project.createdAt)}    更新: ${shortTime(project.updatedAt)}`,
      ]
      if (project.errorMessage) lines.push(`  错误: ${project.errorMessage}`)
      if (project.lastNotification)
        lines.push(`  最新汇报: ${cleanText(project.lastNotification, 240)}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

export function formatEventList(events: DisplayEvent[]): string {
  if (events.length === 0) return '暂无事件。'
  return events.map(formatEvent).join('\n')
}

export function formatEvent(event: DisplayEvent): string {
  const label = eventZh[event.type] ?? event.type
  const content = event.text ?? summarizePayload(event.payloadJson) ?? ''
  if (event.type === 'stdout_json') {
    const parsed = parsePayload(event.payloadJson)
    const summary = summarizeStreamJson(parsed)
    if (summary) return `${shortTime(event.createdAt)} ${label}: ${summary}`
  }
  return `${shortTime(event.createdAt)} ${label}: ${cleanText(content, 220)}`
}

export function formatWorker(worker: WorkerRecord | null): string {
  if (!worker) return '暂无 CLI worker。'
  return [
    `Worker: ${worker.id}`,
    `  状态: ${zhStatus(worker.status)}    PID: ${worker.pid ?? '-'}`,
    `  命令: ${worker.command}`,
    `  工作目录: ${worker.cwd}`,
    `  stdout: ${worker.stdoutPath}`,
    `  stderr: ${worker.stderrPath}`,
  ].join('\n')
}

export function formatResult(task: TaskRecord | null): string {
  if (!task) return '未找到任务。'
  return [
    `任务 ${task.id} 结果`,
    `  状态: ${zhStatus(task.status)}`,
    `  摘要: ${task.resultSummary ? cleanText(task.resultSummary, 1000) : '暂无'}`,
    `  错误: ${task.errorMessage ?? '无'}`,
    `  结果文件: ${task.resultArtifact ?? '无'}`,
  ].join('\n')
}

export function zhStatus(status: string): string {
  return statusZh[status] ?? status
}

function summarizeStreamJson(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const value = json as any
  if (value.type === 'system')
    return `系统初始化，模型 ${value.model ?? '-'}，会话 ${value.session_id ?? '-'}`
  if (value.type === 'assistant') {
    const content = value.message?.content
    if (Array.isArray(content)) {
      const text = content.find((block: any) => block?.type === 'text')?.text
      const thinking = content.find(
        (block: any) => block?.type === 'thinking',
      )?.thinking
      const tool = content.find(
        (block: any) => block?.type === 'tool_use',
      )?.name
      if (text) return `助手回复: ${cleanText(text, 180)}`
      if (thinking) return `思考中: ${cleanText(thinking, 180)}`
      if (tool) return `准备调用工具: ${tool}`
    }
    return '助手产生消息。'
  }
  if (value.type === 'result')
    return `${value.is_error ? '失败' : '成功'}: ${cleanText(value.result ?? '', 180)}`
  return value.type ? `事件类型 ${value.type}` : null
}

function summarizePayload(payloadJson: string | null): string | null {
  const parsed = parsePayload(payloadJson)
  if (!parsed) return payloadJson
  const stream = summarizeStreamJson(parsed)
  if (stream) return stream
  return JSON.stringify(parsed)
}

function parsePayload(payloadJson: string | null): unknown | null {
  if (!payloadJson) return null
  try {
    return JSON.parse(payloadJson)
  } catch {
    return null
  }
}

function cleanText(value: unknown, max = 200): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function shortTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}
