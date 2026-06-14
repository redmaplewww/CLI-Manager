import { createServer, type Socket } from 'net'
import type { DaemonRequest, DaemonResponse } from './daemonProtocol'
import { normalizeCliPrompt } from './promptNormalizer'
import type { ResolvedButlerConfig } from './types'
import { TaskLedger } from './db'
import { Supervisor } from './supervisor'
import { Scheduler } from './scheduler'
import { Watchdog } from './watchdog'
import { readDaemonState, removeDaemonState, writeDaemonState } from './daemonState'
import { AutonomousProjectManager } from './autonomousProjectManager'
import { ProgressReporter } from './progressReporter'

export async function runDaemonServer(
  config: ResolvedButlerConfig,
): Promise<void> {
  const ledger = new TaskLedger(config.storage.databasePath)
  const supervisor = new Supervisor(config, ledger)
  const scheduler = new Scheduler(config, ledger, supervisor.adapter)
  const watchdog = new Watchdog(config, ledger, supervisor)
  const projects = new AutonomousProjectManager(config, ledger, scheduler)
  const reporter = new ProgressReporter(config, ledger)

  const server = createServer(socket =>
    handleSocket(socket, ledger, supervisor, scheduler, projects, reporter),
  )

  const host = '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Daemon did not bind to a TCP port')

  writeDaemonState(config, {
    pid: process.pid,
    host,
    port: address.port,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    watchdogLastBeat: null,
    watchdogIntervalSeconds: Math.max(30, config.execution.watchdogIntervalSeconds ?? 300),
    reporterLastBeat: null,
    reporterIntervalSeconds: Math.max(300, config.execution.progressReportIntervalSeconds ?? 900),
    schedulerLastBeat: null,
    schedulerIntervalSeconds: Math.max(1, config.execution.schedulerIntervalSeconds ?? 2),
  })

  const beatHeartbeat = () => {
    const existing = readDaemonState(config)
    if (existing) writeDaemonState(config, existing)
  }

  const schedulerTimer = setInterval(() => {
    const now = new Date().toISOString()
    const existing = readDaemonState(config)
    if (existing) {
      existing.schedulerLastBeat = now
      writeDaemonState(config, existing)
    }
    scheduler.runQueuedOnce()
  }, Math.max(1, config.execution.schedulerIntervalSeconds ?? 2) * 1000)

  const watchdogTimer = setInterval(() => {
    const now = new Date().toISOString()
    const existing = readDaemonState(config)
    if (existing) {
      existing.watchdogLastBeat = now
      writeDaemonState(config, existing)
    }
    watchdog.scanOnce()
  }, Math.max(30, config.execution.watchdogIntervalSeconds ?? 300) * 1000)

  const reporterTimer = setInterval(() => {
    const now = new Date().toISOString()
    const existing = readDaemonState(config)
    if (existing) {
      existing.reporterLastBeat = now
      writeDaemonState(config, existing)
    }
    void reporter.scanOnce(false)
  }, Math.max(300, config.execution.progressReportIntervalSeconds ?? 900) * 1000)

  beatHeartbeat()

  const shutdown = () => {
    clearInterval(schedulerTimer)
    clearInterval(watchdogTimer)
    clearInterval(reporterTimer)
    removeDaemonState(config)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

function handleSocket(
  socket: Socket,
  ledger: TaskLedger,
  supervisor: Supervisor,
  scheduler: Scheduler,
  projects: AutonomousProjectManager,
  reporter: ProgressReporter,
): void {
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk.toString()
    const idx = buffer.indexOf('\n')
    if (idx === -1) return
    const line = buffer.slice(0, idx)
    void handleLine(line, ledger, supervisor, scheduler, projects, reporter)
      .then(response => writeResponse(socket, response))
      .catch(err =>
        writeResponse(socket, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
  })
}

async function handleLine(
  line: string,
  ledger: TaskLedger,
  supervisor: Supervisor,
  scheduler: Scheduler,
  projects: AutonomousProjectManager,
  reporter: ProgressReporter,
): Promise<DaemonResponse> {
  const request = JSON.parse(line) as DaemonRequest
  switch (request.type) {
    case 'ping':
      return { ok: true, message: 'pong' }
    case 'add': {
      const prompt = normalizeCliPrompt(request.prompt)
      const createInput: Parameters<TaskLedger['createTask']>[0] = {
        title: prompt.slice(0, 80),
        prompt,
        projectRoot: supervisor.config.workspace.root,
        taskKind: request.taskKind ?? 'session',
        parentTaskId: request.parentTaskId ?? null,
      }
      if (request.completionCriteria !== undefined)
        createInput.completionCriteria = request.completionCriteria
      const task = ledger.createTask(createInput)
      if (task.taskKind === 'session') scheduler.runQueuedOnce()
      return {
        ok: true,
        message: `Queued ${task.id}`,
        data: { taskId: task.id },
      }
    }
    case 'retry': {
      const task = ledger.getTask(request.taskId)
      if (!task)
        return { ok: false, error: `Task not found: ${request.taskId}` }
      ledger.updateTask(task.id, {
        status: 'queued',
        retryCount: task.retryCount + 1,
        errorMessage: null,
      })
      ledger.addEvent(task.id, 'retry_started', {
        resume: request.resume ?? false,
      })
      supervisor.startTaskNow(task.id, undefined, request.resume ?? false)
      return { ok: true, message: `Retried ${task.id}` }
    }
    case 'resume_message': {
      supervisor.resumeTaskWithMessage(request.taskId, request.message)
      return {
        ok: true,
        message: `Resumed ${request.taskId} with message`,
      }
    }
    case 'answer': {
      const ok = supervisor.adapter.answer(request.taskId, request.answer)
      return ok
        ? { ok: true, message: `Answered ${request.taskId}` }
        : { ok: false, error: `Task ${request.taskId} is not live in daemon` }
    }
    case 'stop': {
      const ok = supervisor.adapter.stop(request.taskId)
      if (!ok) {
        const task = ledger.getTask(request.taskId)
        if (!task)
          return { ok: false, error: `Task not found: ${request.taskId}` }
        if (task.pid) {
          try {
            process.kill(task.pid, 'SIGTERM')
          } catch {
            // process already gone
          }
        }
        ledger.updateTask(task.id, {
          status: 'cancelled',
          pid: null,
          finishedAt: new Date().toISOString(),
        })
        ledger.addEvent(task.id, 'task_cancelled')
      }
      return { ok: true, message: `Stopped ${request.taskId}` }
    }
    case 'add_batch': {
      const title = request.title.slice(0, 80)
      const completionCriteria =
        request.completionCriteria ??
        `1. 父目标完成：${title}\n2. 所有子 session task 均达到各自结束判定规则。\n3. 对未完成或失败子任务给出恢复记录和阻塞说明。`
      const manager = ledger.createManagerTask({
        title,
        prompt: request.title,
        projectRoot: supervisor.config.workspace.root,
        completionCriteria,
      })
      const childIds: string[] = []
      for (const rawPrompt of request.prompts) {
        const prompt = normalizeCliPrompt(rawPrompt)
        const child = ledger.createTask({
          title: prompt.slice(0, 80),
          prompt,
          projectRoot: supervisor.config.workspace.root,
          taskKind: 'session',
          parentTaskId: manager.id,
        })
        childIds.push(child.id)
      }
      scheduler.runQueuedOnce()
      return {
        ok: true,
        message: `Created manager ${manager.id} with ${childIds.length} children: ${childIds.join(', ')}`,
        data: { managerId: manager.id, childIds },
      }
    }
    case 'project_start': {
      const project = projects.start(request.goal, request.maxIterations ?? 5)
      return {
        ok: true,
        message: `Started project ${project.id}`,
        data: project,
      }
    }
    case 'project_list':
      return { ok: true, data: projects.list() }
    case 'progress_scan':
      await reporter.scanOnce(request.force ?? false)
      return { ok: true, message: 'Progress scan completed' }
    case 'shutdown':
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50)
      return { ok: true, message: 'Daemon shutting down' }
  }
}

function writeResponse(socket: Socket, response: DaemonResponse): void {
  socket.write(JSON.stringify(response) + '\n')
  socket.end()
}
