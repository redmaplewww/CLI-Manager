import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProjectRecord, ResolvedButlerConfig } from './types'

export class ProjectStore {
  private readonly path: string

  constructor(config: ResolvedButlerConfig) {
    mkdirSync(config.storage.dataDir, { recursive: true })
    this.path = join(config.storage.dataDir, 'projects.json')
  }

  list(): ProjectRecord[] {
    if (!existsSync(this.path)) return []
    try {
      return JSON.parse(readFileSync(this.path, 'utf-8')) as ProjectRecord[]
    } catch {
      return []
    }
  }

  get(id: string): ProjectRecord | null {
    return this.list().find(p => p.id === id) ?? null
  }

  save(project: ProjectRecord): void {
    const projects = this.list().filter(p => p.id !== project.id)
    projects.push({ ...project, updatedAt: new Date().toISOString() })
    writeFileSync(this.path, JSON.stringify(projects, null, 2))
  }

  remove(id: string): void {
    const projects = this.list().filter(p => p.id !== id)
    writeFileSync(this.path, JSON.stringify(projects, null, 2))
  }
}
