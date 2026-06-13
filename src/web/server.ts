import { existsSync, readFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { loadConfig, loadRawConfig, saveRawConfig, saveEnvValue } from '../config'
import { TaskLedger } from '../db'
import { ProjectStore } from '../projectStore'
import { ButlerAgent } from '../butlerAgent'
import { scanAuraSessions, discoverSessionRoots } from '../sessionScanner'
import { judgeTaskCompletion } from '../completionJudge'
import { sendDaemonRequest, isDaemonAlive } from '../daemonClient'
import { readDaemonState } from '../daemonState'
import {
  formatEventList,
  formatProjectList,
  formatResult,
  formatTaskList,
  formatWorker,
} from '../ui/formatter'

const publicDir = join(import.meta.dir, 'public')

let config = loadConfig()
let ledger = new TaskLedger(config.storage.databasePath)
let projectStore = new ProjectStore(config)
let agent = new ButlerAgent(config, ledger)

export function startWebServer(
  port = Number(process.env.BUTLER_WEB_PORT ?? 8787),
): void {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      try {
        if (url.pathname === '/') return html('index.html')
        if (url.pathname.startsWith('/assets/'))
          return asset(url.pathname.replace('/assets/', ''))
        if (url.pathname === '/api/state') return json(await getState())
        if (url.pathname === '/api/chat' && req.method === 'POST')
          return json(await postChat(req))
        if (url.pathname === '/api/config/llm') return json(getLlmConfig())
        if (url.pathname === '/api/config/llm/save' && req.method === 'POST') {
          const body = (await req.json()) as {
            enabled?: boolean
            baseUrl?: string
            model?: string
            apiKeyEnv?: string
            apiKey?: string
          }
          return json(saveLlmConfig(body))
        }
        if (url.pathname === '/api/progress/scan' && req.method === 'POST')
          return json(
            await sendDaemonRequest(config, {
              type: 'progress_scan',
              force: true,
            }, 60_000),
          )
        if (url.pathname === '/api/monitor') return json(getMonitorFeed())
        if (url.pathname === '/api/inspection/all' && req.method === 'POST') {
          const body = (await req.json()) as { enabled?: boolean }
          for (const task of ledger.listTasks())
            ledger.updateTask(task.id, { inspectionEnabled: Boolean(body.enabled) })
          return json({ ok: true, enabled: Boolean(body.enabled) })
        }
        if (url.pathname === '/api/sessions')
          return json({
            roots: discoverSessionRoots(config.workspace.root),
            sessions: await scanAuraSessions(config.workspace.root),
          })
        if (url.pathname === '/api/sessions/bind' && req.method === 'POST') {
          const body = (await req.json()) as { sessionIds?: string[] }
          return json(await bindSelectedSessions(body.sessionIds ?? []))
        }
        if (url.pathname === '/api/daemon/start' && req.method === 'POST')
          return json(await daemonControl('start'))
        if (url.pathname === '/api/daemon/stop' && req.method === 'POST')
          return json(await daemonControl('stop'))

        const taskEvents = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/events$/i)
        if (taskEvents) return json(getTaskEvents(taskEvents[1]!.toUpperCase()))
        const taskResult = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/result$/i)
        if (taskResult) return json(getTaskResult(taskResult[1]!.toUpperCase()))
        const taskCriteria = url.pathname.match(
          /^\/api\/tasks\/(T\d+(?:-\d+)?)\/criteria$/i,
        )
        if (taskCriteria && req.method === 'POST') {
          const body = (await req.json()) as { completionCriteria?: string }
          const taskId = taskCriteria[1]!.toUpperCase()
          ledger.updateTask(taskId, {
            completionCriteria: body.completionCriteria ?? '',
          })
          return json({ ok: true, task: ledger.getTask(taskId) })
        }
        const taskRename = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/rename$/i)
        if (taskRename && req.method === 'POST') {
          const body = (await req.json()) as { displayName?: string }
          const taskId = taskRename[1]!.toUpperCase()
          ledger.updateTask(taskId, {
            displayName: body.displayName?.trim() || null,
          })
          return json({ ok: true, task: ledger.getTask(taskId) })
        }
        const taskInspection = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/inspection$/i)
        if (taskInspection && req.method === 'POST') {
          const body = (await req.json()) as { enabled?: boolean }
          const taskId = taskInspection[1]!.toUpperCase()
          ledger.updateTask(taskId, { inspectionEnabled: Boolean(body.enabled) })
          return json({ ok: true, task: ledger.getTask(taskId) })
        }
        const taskGroup = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/group$/i)
        if (taskGroup && req.method === 'POST') {
          const body = (await req.json()) as { group?: string | null }
          const taskId = taskGroup[1]!.toUpperCase()
          ledger.updateTask(taskId, { taskGroup: body.group?.trim() || null })
          return json({ ok: true, task: ledger.getTask(taskId) })
        }
        const taskArchive = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/archive$/i)
        if (taskArchive && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as { note?: string }
          const taskId = taskArchive[1]!.toUpperCase()
          ledger.archiveTask(taskId, body.note ?? null)
          return json({ ok: true, task: ledger.getTask(taskId) })
        }
        const taskUnarchive = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/unarchive$/i)
        if (taskUnarchive && req.method === 'POST') {
          const taskId = taskUnarchive[1]!.toUpperCase()
          ledger.unarchiveTask(taskId)
          return json({ ok: true, task: ledger.getTask(taskId) })
        }
        const taskDelete = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/delete$/i)
        if (taskDelete && req.method === 'POST') {
          const taskId = taskDelete[1]!.toUpperCase()
          ledger.deleteTask(taskId)
          return json({ ok: true })
        }
        const taskSession = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/session$/i)
        if (taskSession) return json(await getTaskSession(taskSession[1]!.toUpperCase()))
        const taskJudge = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/judge$/i)
        if (taskJudge) return json(await judgeTaskDone(taskJudge[1]!.toUpperCase()))
        const taskSessionSend = url.pathname.match(
          /^\/api\/tasks\/(T\d+(?:-\d+)?)\/session\/send$/i,
        )
        if (taskSessionSend && req.method === 'POST') {
          const body = (await req.json()) as { message?: string }
          return json(sendSessionMessage(taskSessionSend[1]!.toUpperCase(), body.message ?? ''))
        }
        const taskStop = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/stop$/i)
        if (taskStop && req.method === 'POST')
          return json(
            await sendDaemonRequest(config, {
              type: 'stop',
              taskId: taskStop[1]!.toUpperCase(),
            }),
          )
        const taskRetry = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/retry$/i)
        if (taskRetry && req.method === 'POST')
          return json(
            await sendDaemonRequest(config, {
              type: 'retry',
              taskId: taskRetry[1]!.toUpperCase(),
              resume: url.searchParams.get('resume') === '1',
            }),
          )
        const taskAnswer = url.pathname.match(/^\/api\/tasks\/(T\d+(?:-\d+)?)\/answer$/i)
        if (taskAnswer && req.method === 'POST') {
          const body = (await req.json()) as { answer?: string }
          return json(
            await sendDaemonRequest(config, {
              type: 'answer',
              taskId: taskAnswer[1]!.toUpperCase(),
              answer: body.answer ?? '',
            }),
          )
        }
        return json({ error: 'Not found' }, 404)
      } catch (err) {
        return json(
          { error: err instanceof Error ? err.message : String(err) },
          500,
        )
      }
    },
  })
  console.log(`Aura Butler web dashboard: http://127.0.0.1:${server.port}`)
}

async function getState() {
  const tasks = ledger.listTasks()
  const archivedTasks = ledger.listArchivedTasks()
  const latest = tasks.at(-1)
  const daemon = readDaemonState(config)
  return {
    daemon: { alive: await isDaemonAlive(config), state: daemon },
    llm: currentLlmState(),
    tasks,
    archivedTasks,
    taskTree: buildTaskTree(tasks),
    tasksFormatted: formatTaskList(tasks),
    projects: projectStore.list(),
    projectsFormatted: formatProjectList(projectStore.list()),
    workers: tasks.map(task => ({
      taskId: task.id,
      worker: ledger.getLatestWorker(task.id),
    })),
    latestTaskId: latest?.id ?? null,
    latestEvents: latest ? ledger.listEvents(latest.id, 40) : [],
    latestEventsFormatted: latest
      ? formatEventList(ledger.listEvents(latest.id, 40))
      : '暂无事件。',
    latestWorkerFormatted: latest
      ? formatWorker(ledger.getLatestWorker(latest.id))
      : '暂无 CLI worker。',
  }
}

function buildTaskTree(tasks: ReturnType<TaskLedger['listTasks']>) {
  return tasks.map(task => ({
    ...task,
    children: tasks.filter(child => child.parentTaskId === task.id),
  }))
}

function getMonitorFeed() {
  const tasks = ledger.listTasks()
  const lines = tasks
    .filter(task => task.progressSummary || task.completionVerdict || task.status !== 'completed')
    .slice(-80)
    .map(task => ({
      taskId: task.id,
      title: task.displayName ?? task.title,
      status: task.status,
      inspectionEnabled: task.inspectionEnabled,
      verdict: task.completionVerdict,
      updatedAt: task.progressUpdatedAt ?? task.updatedAt,
      summary:
        task.progressSummary ??
        task.completionReason ??
        task.errorMessage ??
        '暂无巡检记录',
    }))
  return { items: lines }
}

async function postChat(req: Request) {
  const body = (await req.json()) as { message?: string }
  const message = body.message?.trim()
  if (!message) return { reply: '请输入消息。', actions: [] }
  return agent.handle(message, { language: 'zh' })
}

function getLlmConfig() {
  const raw = loadRawConfig()
  const llm = raw.llm ?? config.llm
  const apiKeyEnv = llm?.apiKeyEnv ?? 'OPENAI_API_KEY'
  return {
    enabled: Boolean(llm?.enabled),
    baseUrl: llm?.baseUrl ?? '',
    model: llm?.model ?? '',
    apiKeyEnv,
    hasApiKey: Boolean(process.env[apiKeyEnv]),
  }
}

function saveLlmConfig(body: {
  enabled?: boolean
  baseUrl?: string
  model?: string
  apiKeyEnv?: string
  apiKey?: string
}) {
  const raw = loadRawConfig()
  const apiKeyEnv = body.apiKeyEnv?.trim() || raw.llm?.apiKeyEnv || 'OPENAI_API_KEY'
  raw.llm = {
    enabled: Boolean(body.enabled),
    provider: 'openai-compatible',
    baseUrl: body.baseUrl?.trim() || raw.llm?.baseUrl || 'https://api.openai.com/v1',
    apiKeyEnv,
    model: body.model?.trim() || raw.llm?.model || 'gpt-4o-mini',
    timeoutMs: raw.llm?.timeoutMs ?? 20000,
  }
  saveRawConfig(raw)
  if (body.apiKey?.trim()) saveEnvValue(apiKeyEnv, body.apiKey.trim())
  reloadRuntimeConfig()
  return {
    ok: true,
    message: 'LLM 配置已保存，并已刷新当前网页运行时。daemon 中的定时进度总结需重启后完全生效。',
    llm: getLlmConfig(),
  }
}

function reloadRuntimeConfig(): void {
  config = loadConfig()
  ledger = new TaskLedger(config.storage.databasePath)
  projectStore = new ProjectStore(config)
  agent = new ButlerAgent(config, ledger)
}

function currentLlmState() {
  const keyEnv = config.llm?.apiKeyEnv ?? 'OPENAI_API_KEY'
  const configEnabled = Boolean(config.llm?.enabled)
  const hasApiKey = Boolean(process.env[keyEnv])
  return {
    enabled: configEnabled && hasApiKey,
    configEnabled,
    hasApiKey,
    apiKeyEnv: keyEnv,
    model: config.llm?.model ?? null,
    baseUrl: config.llm?.baseUrl ?? null,
    reason: !configEnabled
      ? 'disabled_in_config'
      : !hasApiKey
        ? `missing_env:${keyEnv}`
        : 'ready',
  }
}

async function daemonControl(action: 'start' | 'stop') {
  if (action === 'stop') return sendDaemonRequest(config, { type: 'shutdown' })
  if (await isDaemonAlive(config))
    return { ok: true, message: 'daemon 已在运行' }
  const { spawn } = await import('child_process')
  const child = spawn(process.execPath, ['src/cli.ts', 'daemon', 'run'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { ok: true, message: 'daemon 正在启动' }
}

async function bindSelectedSessions(sessionIds: string[]) {
  const sessions = await scanAuraSessions(config.workspace.root)
  let created = 0
  let updated = 0
  const bound: string[] = []
  for (const session of sessions.filter(s => sessionIds.includes(s.sessionId))) {
    const result = ledger.importSessionTask({
      sessionId: session.sessionId,
      title: `[${session.cli}] ${session.title}`,
      prompt: session.lastPrompt ?? session.title,
      projectRoot: session.cwd ?? config.workspace.root,
      status: session.isLive ? 'running' : 'completed',
      sessionPath: session.transcriptPath,
      sessionPid: session.pid,
      lastActiveAt: session.lastActiveAt,
      resultSummary: session.lastAssistantText,
    })
    result.created ? created++ : updated++
    bound.push(session.sessionId)
  }
  return { ok: true, created, updated, bound }
}

function getTaskEvents(taskId: string) {
  const events = ledger.listEvents(taskId, 500)
  return { taskId, events, formatted: formatEventList(events) }
}

function getTaskResult(taskId: string) {
  const task = ledger.getTask(taskId)
  return {
    taskId,
    task,
    children: task ? ledger.listChildTasks(task.id) : [],
    formatted: formatResult(task),
  }
}

async function getTaskSession(taskId: string) {
  const task = ledger.getTask(taskId)
  if (!task?.cliSessionId) return { taskId, task, session: null, history: [] }
  const sessions = await scanAuraSessions(config.workspace.root)
  const session = sessions.find(s => s.sessionId === task.cliSessionId) ?? null
  const transcriptPath = session?.transcriptPath ?? task.sessionPath
  const history = transcriptPath ? parseTranscript(transcriptPath, 300) : []
  return { taskId, task, session, history }
}

async function judgeTaskDone(taskId: string) {
  const sessionData = await getTaskSession(taskId)
  const task = sessionData.task
  if (!task) return { taskId, ok: false, error: 'Task not found' }
  const output = [
    task.resultSummary ?? '',
    ...sessionData.history.slice(-80).map(item => item.text ?? ''),
  ].join('\n')
  const judgement = judgeTaskCompletion(task, output)
  return {
    taskId,
    ok: true,
    verdict: judgement.verdict,
    done: judgement.done,
    reason: judgement.reason,
    lastOutput: output.slice(-2000),
  }
}

function sendSessionMessage(taskId: string, message: string) {
  const task = ledger.getTask(taskId)
  const text = message.trim()
  if (!text) return { ok: false, error: '消息不能为空。' }
  if (!task) return { ok: false, error: `Task not found: ${taskId}` }
  ledger.addEvent(task.id, 'answer_sent', { sessionMessage: true }, text)
  void sendDaemonRequest(config, {
    type: 'resume_message',
    taskId,
    message: text,
  }).then(response => {
    if (!response?.ok && task.sessionPath) {
      appendSessionNote(task.sessionPath, text, response?.error ?? 'daemon unavailable')
      ledger.addEvent(
        task.id,
        'stderr',
        { resumeMessageFallback: true },
        response?.error ?? 'daemon unavailable; wrote note to transcript',
      )
    }
  })
  return {
    ok: true,
    message:
      '已请求 Butler 用 --resume 接管该 session 并发送消息；如果 daemon 不可用，会退回写入历史备注。',
  }
}

function appendSessionNote(path: string, message: string, reason: string): void {
  appendFileSync(
    path,
    JSON.stringify({
      type: 'butler-note',
      timestamp: new Date().toISOString(),
      message,
      reason,
    }) + '\n',
  )
}

function parseTranscript(path: string, limit: number) {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/).filter(Boolean)
  return lines.slice(-limit).map(line => {
    try {
      const parsed = JSON.parse(line) as any
      return {
        type: String(parsed.type ?? 'unknown'),
        timestamp: parsed.timestamp ?? null,
        text: extractTranscriptText(parsed),
      }
    } catch {
      return { type: 'raw', timestamp: null, text: line }
    }
  })
}

function extractTranscriptText(entry: any): string {
  if (typeof entry.message === 'string') return entry.message
  if (typeof entry.message?.content === 'string') return entry.message.content
  if (Array.isArray(entry.message?.content)) {
    return entry.message.content
      .map((part: any) => {
        if (part?.type === 'text') return part.text
        if (part?.type === 'tool_use') return `[Tool: ${part.name ?? 'unknown'}]`
        if (part?.type === 'tool_result') return `[Tool result] ${String(part.content ?? '').slice(0, 800)}`
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return entry.lastPrompt ?? entry.result ?? entry.message ?? JSON.stringify(entry).slice(0, 1000)
}

function html(name: string): Response {
  const path = join(publicDir, name)
  return new Response(readFileSync(path, 'utf-8'), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function asset(name: string): Response {
  const path = join(publicDir, name)
  if (!existsSync(path)) return new Response('Not found', { status: 404 })
  const type = name.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : name.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'application/octet-stream'
  return new Response(readFileSync(path), { headers: { 'content-type': type } })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

if (import.meta.main) startWebServer()
