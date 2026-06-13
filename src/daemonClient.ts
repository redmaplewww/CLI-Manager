import { createConnection } from 'net'
import type { DaemonRequest, DaemonResponse } from './daemonProtocol'
import type { ResolvedButlerConfig } from './types'
import { readDaemonState } from './daemonState'

export async function sendDaemonRequest(
  config: ResolvedButlerConfig,
  request: DaemonRequest,
  timeoutMs = 5000,
): Promise<DaemonResponse | null> {
  const state = readDaemonState(config)
  if (!state) return null

  return new Promise(resolve => {
    const socket = createConnection({ host: state.host, port: state.port })
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({
        ok: false,
        error: `Daemon request timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n')
    })

    socket.on('data', chunk => {
      buffer += chunk.toString()
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      clearTimeout(timer)
      const line = buffer.slice(0, idx)
      socket.end()
      try {
        resolve(JSON.parse(line) as DaemonResponse)
      } catch {
        resolve({ ok: false, error: 'Daemon returned invalid JSON' })
      }
    })

    socket.on('error', err => {
      clearTimeout(timer)
      resolve({ ok: false, error: err.message })
    })

    socket.on('close', () => clearTimeout(timer))
  })
}

export async function isDaemonAlive(
  config: ResolvedButlerConfig,
): Promise<boolean> {
  const response = await sendDaemonRequest(config, { type: 'ping' }, 1500)
  return response?.ok === true
}
