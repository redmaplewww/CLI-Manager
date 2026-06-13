import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { MuxSessionRecord, ResolvedButlerConfig } from './types'

export class MuxStore {
  private readonly path: string

  constructor(private readonly config: ResolvedButlerConfig) {
    mkdirSync(config.storage.dataDir, { recursive: true })
    this.path = join(config.storage.dataDir, 'mux-sessions.json')
  }

  list(): MuxSessionRecord[] {
    if (!existsSync(this.path)) return []
    try {
      return JSON.parse(readFileSync(this.path, 'utf-8')) as MuxSessionRecord[]
    } catch {
      return []
    }
  }

  save(session: MuxSessionRecord): void {
    const sessions = this.list().filter(
      s => s.id !== session.id && s.name !== session.name,
    )
    sessions.push(session)
    writeFileSync(this.path, JSON.stringify(sessions, null, 2))
  }

  get(target: string): MuxSessionRecord | null {
    return (
      this.list().find(
        s => s.id === target || s.name === target || s.tmuxSession === target,
      ) ?? null
    )
  }

  remove(target: string): void {
    writeFileSync(
      this.path,
      JSON.stringify(
        this.list().filter(
          s => s.id !== target && s.name !== target && s.tmuxSession !== target,
        ),
        null,
        2,
      ),
    )
  }
}
