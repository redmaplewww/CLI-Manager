import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ResolvedButlerConfig } from './types'
import type { DaemonStateFile } from './daemonProtocol'

export function daemonStatePath(config: ResolvedButlerConfig): string {
  return join(config.storage.dataDir, 'daemon.json')
}

export function readDaemonState(
  config: ResolvedButlerConfig,
): DaemonStateFile | null {
  const path = daemonStatePath(config)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DaemonStateFile
  } catch {
    return null
  }
}

export function writeDaemonState(
  config: ResolvedButlerConfig,
  state: DaemonStateFile,
): void {
  writeFileSync(daemonStatePath(config), JSON.stringify(state, null, 2))
}

export function removeDaemonState(config: ResolvedButlerConfig): void {
  try {
    unlinkSync(daemonStatePath(config))
  } catch {
    // ignore missing state file
  }
}
