import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { loadConfig } from '../config'
import { isDaemonAlive, sendDaemonRequest } from '../daemonClient'
import { readDaemonState, removeDaemonState } from '../daemonState'
import { runDaemonServer } from '../daemonServer'

export async function daemonCommand(subcommand = 'status'): Promise<void> {
  const config = loadConfig()
  switch (subcommand) {
    case 'run':
      await runDaemonServer(config)
      return
    case 'start':
      await startDaemon()
      return
    case 'stop':
      await stopDaemon()
      return
    case 'status':
      await daemonStatus()
      return
    default:
      throw new Error(`Unknown daemon subcommand: ${subcommand}`)
  }
}

async function startDaemon(): Promise<void> {
  const config = loadConfig()
  if (await isDaemonAlive(config)) {
    const state = readDaemonState(config)
    console.log(`daemon 已在运行：pid=${state?.pid} port=${state?.port}`)
    return
  }
  const stale = readDaemonState(config)
  if (stale) removeDaemonState(config)

  const entrypoint = resolve('src/cli.ts')
  if (!existsSync(entrypoint))
    throw new Error(`Butler entrypoint not found: ${entrypoint}`)
  const child = spawn(process.execPath, [entrypoint, 'daemon', 'run'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 200))
    if (await isDaemonAlive(config)) {
      const state = readDaemonState(config)
      console.log(`daemon 已启动：pid=${state?.pid} port=${state?.port}`)
      return
    }
  }
  throw new Error('daemon 启动后未按时就绪')
}

async function stopDaemon(): Promise<void> {
  const config = loadConfig()
  const response = await sendDaemonRequest(config, { type: 'shutdown' }, 2000)
  if (response?.ok) {
    console.log(response.message ?? 'daemon 正在停止')
    removeDaemonState(config)
    return
  }
  const state = readDaemonState(config)
  if (state) {
    try {
      process.kill(state.pid, 'SIGTERM')
      console.log(`已向 daemon 发送停止信号：pid=${state.pid}`)
      removeDaemonState(config)
    } catch {
      console.log('daemon 状态文件已过期，正在清理。')
      removeDaemonState(config)
    }
    return
  }
  console.log('daemon 未运行。')
}

async function daemonStatus(): Promise<void> {
  const config = loadConfig()
  const state = readDaemonState(config)
  if (!state) {
    console.log('daemon：已停止')
    return
  }
  const alive = await isDaemonAlive(config)
  console.log(`daemon：${alive ? '运行中' : '状态过期'}`)
  console.log(`  PID：${state.pid}`)
  console.log(`  地址：${state.host}:${state.port}`)
  console.log(`  启动时间：${state.startedAt}`)
  if (!alive) removeDaemonState(config)
}
