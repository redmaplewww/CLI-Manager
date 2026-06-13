import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, extname, join, resolve } from 'path'
import { homedir } from 'os'
import type { AuraSessionSummary, ExternalSessionTask, TaskStatus } from './types'

interface RegistryEntry {
  pid?: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  kind?: string
  entrypoint?: string
}

export async function scanAuraSessions(
  root: string,
): Promise<AuraSessionSummary[]> {
  return scanCliSessions(root)
}

export async function scanCliSessions(root: string): Promise<AuraSessionSummary[]> {
  const roots = discoverSessionRoots(root)
  const results = await Promise.all(
    roots.map(source => scanAngshengSessions(source.root, source.cli)),
  )
  return results.flat().sort(
    (a, b) =>
      Date.parse(b.lastActiveAt ?? '') - Date.parse(a.lastActiveAt ?? ''),
  )
}

export function discoverSessionRoots(root: string): Array<{ cli: string; root: string }> {
  const home = homedir()
  const candidates: Array<{ cli: string; root: string }> = [
    { cli: 'aura/opencode', root: join(root, '.angsheng') },
    { cli: 'aura/opencode', root: join(home, 'CLI-self-deploy-src', '.angsheng') },
    { cli: 'aura/opencode', root: join(home, 'CLI-self', '.angsheng') },
    { cli: 'opencode', root: join(home, '.local', 'share', 'opencode') },
    { cli: 'opencode', root: join(home, '.opencode') },
    { cli: 'claude-code', root: join(home, '.claude', 'projects') },
    { cli: 'codex', root: join(home, '.codex', 'sessions') },
  ]
  for (const env of ['AURA_CLI_ROOT', 'CLI_SELF_ROOT', 'OPENCODE_CLI_ROOT']) {
    const value = process.env[env]
    if (value) candidates.push({ cli: 'aura/opencode', root: join(value, '.angsheng') })
  }
  for (const base of candidateBases(root, home)) {
    for (const child of likelyCliChildren(base)) {
      candidates.push({ cli: 'aura/opencode', root: join(child, '.angsheng') })
    }
  }
  const seen = new Set<string>()
  return candidates
    .map(c => ({ ...c, root: resolve(c.root) }))
    .filter(c => existsSync(c.root) && !seen.has(c.root) && seen.add(c.root))
}

function candidateBases(root: string, home: string): string[] {
  return [root, dirname(root), home, dirname(home), process.cwd(), dirname(process.cwd()), '/opt', '/workspace']
}

function likelyCliChildren(base: string): string[] {
  try {
    if (!existsSync(base) || !statSync(base).isDirectory()) return []
    return readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /cli|aura|opencode|claude|codex|deploy/i.test(entry.name))
      .slice(0, 100)
      .map(entry => join(base, entry.name))
  } catch {
    return []
  }
}

async function scanAngshengSessions(
  base: string,
  cli = 'aura/opencode',
): Promise<AuraSessionSummary[]> {
  const registry = await readRegistry(join(base, 'sessions'))
  const projectsDir = join(base, 'projects')
  const externalTasks = await readExternalTasks(join(base, 'tasks'))
  const out: AuraSessionSummary[] = []
  for (const projectHash of await safeReaddir(projectsDir)) {
    const projectPath = join(projectsDir, projectHash)
    if (!(await isDirectory(projectPath))) continue
    for (const entry of await safeReaddir(projectPath)) {
      if (extname(entry) !== '.jsonl') continue
      const sessionId = basename(entry, '.jsonl')
      const transcriptPath = join(projectPath, entry)
      const summary = await summarizeTranscript(
        transcriptPath,
        sessionId,
        projectHash,
        registry.get(sessionId),
        externalTasks.get(sessionId) ?? [],
        cli,
      )
      out.push(summary)
    }
  }
  return out.sort(
    (a, b) => Date.parse(b.lastActiveAt ?? '') - Date.parse(a.lastActiveAt ?? ''),
  )
}

async function readRegistry(
  dir: string,
): Promise<Map<string, RegistryEntry & { path: string; isLive: boolean }>> {
  const map = new Map<
    string,
    RegistryEntry & { path: string; isLive: boolean }
  >()
  for (const entry of await safeReaddir(dir)) {
    if (extname(entry) !== '.json') continue
    const path = join(dir, entry)
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as RegistryEntry
      if (!parsed.sessionId) continue
      map.set(parsed.sessionId, {
        ...parsed,
        path,
        isLive: parsed.pid ? isPidLive(parsed.pid) : false,
      })
    } catch {
      // ignore malformed registry entries
    }
  }
  return map
}

async function summarizeTranscript(
  transcriptPath: string,
  sessionId: string,
  projectHash: string,
  registry?: RegistryEntry & { path: string; isLive: boolean },
  externalTasks: ExternalSessionTask[] = [],
  cli = 'aura/opencode',
): Promise<AuraSessionSummary> {
  const text = await readTail(transcriptPath, 2_000_000)
  const lines = text.split(/\r?\n/).filter(Boolean)
  let firstPrompt: string | null = null
  let lastPrompt: string | null = null
  let bestPrompt: string | null = null
  let lastAssistantText: string | null = null
  let cwd: string | null = registry?.cwd ?? null
  let createdAt: string | null = null
  let lastActiveAt: string | null = null
  let messageCount = 0

  for (const line of lines) {
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null
    if (ts) {
      if (!createdAt || Date.parse(ts) < Date.parse(createdAt)) createdAt = ts
      if (!lastActiveAt || Date.parse(ts) > Date.parse(lastActiveAt))
        lastActiveAt = ts
    }
    if (typeof entry.cwd === 'string') cwd = entry.cwd
    if (entry.type === 'last-prompt' && typeof entry.lastPrompt === 'string') {
      const content = cleanSessionText(entry.lastPrompt)
      if (isUsefulUserPrompt(content)) lastPrompt = content
    }
    if (entry.type === 'user' || entry.type === 'assistant') messageCount++
    if (entry.type === 'user') {
      const content = cleanSessionText(extractContent(entry.message?.content))
      if (content && isUsefulUserPrompt(content) && !firstPrompt)
        firstPrompt = content
      if (content && isUsefulUserPrompt(content)) {
        lastPrompt = content
        if (!bestPrompt || promptScore(content) > promptScore(bestPrompt))
          bestPrompt = content
      }
    }
    if (entry.type === 'assistant') {
      const content = cleanSessionText(extractContent(entry.message?.content))
      if (content && !looksLikeToolDump(content)) lastAssistantText = content
    }
  }

  const st = safeStat(transcriptPath)
  if (!lastActiveAt && st) lastActiveAt = new Date(st.mtimeMs).toISOString()
  if (!createdAt && st)
    createdAt = new Date(st.birthtimeMs || st.ctimeMs).toISOString()
  const title = (bestPrompt ?? lastPrompt ?? firstPrompt ?? `Session ${sessionId}`)
    .replace(/\s+/g, ' ')
    .slice(0, 160)
  const summary = buildSessionSummary({
    firstPrompt,
    lastPrompt: bestPrompt ?? lastPrompt,
    lastAssistantText,
    cwd,
    messageCount,
  })

  return {
    cli,
    sessionId,
    title,
    summary,
    cwd,
    pid: registry?.pid ?? null,
    isLive: registry?.isLive ?? false,
    kind: registry?.kind ?? null,
    entrypoint: registry?.entrypoint ?? null,
    transcriptPath,
    registryPath: registry?.path ?? null,
    messageCount,
    createdAt,
    lastActiveAt,
    lastPrompt,
    lastAssistantText,
    projectHash,
    externalTasks,
  }
}

function buildSessionSummary(input: {
  firstPrompt: string | null
  lastPrompt: string | null
  lastAssistantText: string | null
  cwd: string | null
  messageCount: number
}): string {
  const topic = cleanSessionText(input.lastPrompt ?? input.firstPrompt ?? '未知任务')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
  const assistant = cleanSessionText(input.lastAssistantText ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
  const signals: string[] = []
  const text = `${topic} ${assistant}`.toLowerCase()
  if (/error|failed|失败|报错|unknown skill/.test(text)) signals.push('可能失败/报错')
  if (/completed|完成|ready|success|passed/.test(text)) signals.push('可能已完成')
  if (/running|slurm|jobid|calculat|lammps|mpi/.test(text)) signals.push('可能在计算/模拟')
  if (/workflow-auto/.test(text)) signals.push('workflow-auto')
  return [
    `主题：${topic}`,
    assistant ? `最近输出：${assistant}` : '',
    input.cwd ? `目录：${input.cwd}` : '',
    `消息数：${input.messageCount}`,
    signals.length ? `信号：${signals.join('，')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

async function readExternalTasks(
  tasksDir: string,
): Promise<Map<string, ExternalSessionTask[]>> {
  const map = new Map<string, ExternalSessionTask[]>()
  for (const sessionId of await safeReaddir(tasksDir)) {
    const dir = join(tasksDir, sessionId)
    if (!(await isDirectory(dir))) continue
    const tasks: ExternalSessionTask[] = []
    for (const entry of await safeReaddir(dir)) {
      if (extname(entry) !== '.json') continue
      const path = join(dir, entry)
      try {
        const parsed = JSON.parse(await readFile(path, 'utf-8')) as any
        tasks.push({
          id: String(parsed.id ?? basename(entry, '.json')),
          subject: String(parsed.subject ?? `Task ${basename(entry, '.json')}`),
          description: String(parsed.description ?? ''),
          activeForm:
            typeof parsed.activeForm === 'string' ? parsed.activeForm : null,
          status: normalizeTaskStatus(parsed.status),
          blocks: Array.isArray(parsed.blocks) ? parsed.blocks.map(String) : [],
          blockedBy: Array.isArray(parsed.blockedBy)
            ? parsed.blockedBy.map(String)
            : [],
          path,
        })
      } catch {
        // ignore malformed task entries
      }
    }
    tasks.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id))
    map.set(sessionId, tasks)
  }
  return map
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  const status = String(value ?? 'queued')
  if (status === 'pending') return 'queued'
  if (
    [
      'queued',
      'running',
      'waiting_user',
      'stuck',
      'failed',
      'completed',
      'cancelled',
      'summarized',
    ].includes(status)
  )
    return status as TaskStatus
  return 'queued'
}

function extractContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content
    .map(part => {
      if (part?.type === 'text' && typeof part.text === 'string')
        return part.text
      if (part?.type === 'tool_use') return `[Tool: ${part.name ?? 'unknown'}]`
      if (part?.type === 'tool_result') return ''
      return ''
    })
    .filter(Boolean)
  return parts.join('\n') || null
}

function cleanSessionText(value: string | null): string {
  if (!value) return ''
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/�+/g, '')
    .replace(/[\uFFFD]+/g, '')
    .replace(/\[Tool result\][\s\S]*/g, '')
    .trim()
}

function isUsefulUserPrompt(text: string): boolean {
  if (!text || text.startsWith('<')) return false
  if (looksLikeToolDump(text)) return false
  if (/^\s*(Base directory for this skill|#\s*LAMMPS|\[WORKFLOW workflow-auto\] Current stage)/i.test(text))
    return false
  if (mojibakeRatio(text) > 0.25) return false
  return text.length >= 2
}

function looksLikeToolDump(text: string): boolean {
  return /^\s*\[Tool result\]/i.test(text) || /<tool_use_error>|Exit code \d+/i.test(text)
}

function promptScore(text: string): number {
  let score = Math.min(text.length, 500)
  if (/workflow-auto|任务|复现|计算|模拟|lammps|拉伸|压缩|paper|doi/i.test(text)) score += 500
  if (/^\s*(Base directory for this skill|#\s*LAMMPS|\[WORKFLOW workflow-auto\] Current stage)/i.test(text)) score -= 1500
  if (/Task[:：]\s*[^\n]+/i.test(text)) score += 600
  if (looksLikeToolDump(text)) score -= 1000
  score -= mojibakeRatio(text) * 1000
  return score
}

function mojibakeRatio(text: string): number {
  if (!text) return 0
  const bad = (text.match(/[�]|[����]|\?\?\?/g) ?? []).join('').length
  return bad / Math.max(text.length, 1)
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const st = await stat(path)
  const buf = readFileSync(path)
  if (st.size <= maxBytes) return buf.toString('utf-8')
  return buf.subarray(st.size - maxBytes).toString('utf-8')
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function safeStat(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function isPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
