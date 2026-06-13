import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, normalize } from 'path'
import type { TaskRecord } from './types'

const projectFileNames = [
  'PROJECT.md',
  'project.md',
  'PLAN.md',
  'plan.md',
  'TASK.md',
  'task.md',
  'README.md',
  'work-log.md',
  'progress.md',
  '项目管理.md',
  '任务管理.md',
  '进度.md',
]

export interface WorkContext {
  cwd: string | null
  filePath: string | null
  content: string
}

export function discoverWorkContext(task: TaskRecord): WorkContext {
  const explicit = explicitWorkDirFromText(`${task.prompt}\n${task.title}`)
  const cwd = explicit ?? task.projectRoot ?? cwdFromSessionPath(task.sessionPath)
  if (!cwd) return { cwd: null, filePath: null, content: '' }
  const filePath = findProjectFile(cwd)
  if (!filePath) return { cwd, filePath: null, content: '' }
  return {
    cwd,
    filePath,
    content: readFileSync(filePath, 'utf-8').slice(-12_000),
  }
}

function explicitWorkDirFromText(text: string): string | null {
  const patterns = [
    /(?:in|at|directory|工作目录|目录|在)\s+([A-Za-z]:[\\/][^\s`'"，。]+|\/[\w.\-/]+)[\s`'"，。]*/i,
    /([A-Za-z]:[\\/][^\s`'"，。]+|\/[\w.\-/]+)\s+(?:中|里|内|执行|run|execute)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const value = match?.[1]?.trim()
    if (value && existsSync(normalize(value)) && statSync(normalize(value)).isDirectory())
      return normalize(value)
  }
  return null
}

function cwdFromSessionPath(path: string | null): string | null {
  if (!path) return null
  return dirname(path)
}

function findProjectFile(start: string): string | null {
  const queue = [start]
  const seen = new Set<string>()
  while (queue.length > 0 && seen.size < 80) {
    const dir = queue.shift()!
    if (seen.has(dir) || !existsSync(dir)) continue
    seen.add(dir)
    for (const name of projectFileNames) {
      const path = join(dir, name)
      if (existsSync(path) && statSync(path).isFile()) return path
    }
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (/node_modules|\.git|data|logs|dist|build/i.test(entry.name)) continue
        queue.push(join(dir, entry.name))
      }
    } catch {
      // ignore unreadable directories
    }
  }
  return null
}
