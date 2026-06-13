import { createContext } from './context'
import { scanAuraSessions, discoverSessionRoots } from '../sessionScanner'
export async function sessionsCommand(subcommand = 'list'): Promise<void> {
  const { config, ledger } = createContext()
  const sessions = await scanAuraSessions(config.workspace.root)
  switch (subcommand) {
    case 'roots':
      console.log(
        discoverSessionRoots(config.workspace.root)
          .map(root => `${root.cli}: ${root.root}`)
          .join('\n') || '未发现常见 CLI session 目录。',
      )
      return
    case 'list':
      console.log(formatSessions(sessions))
      return
    case 'import': {
      const ids = process.argv.slice(4).filter(Boolean)
      if (ids.length === 0) {
        console.log('请指定要绑定的 sessionId，例如：sessions import <sessionId> [sessionId...]')
        return
      }
      let created = 0
      let updated = 0
      let linkedExternalTasks = 0
      for (const session of sessions.filter(s => ids.includes(s.sessionId))) {
        const sessionTaskSummary = formatExternalTaskSummary(session)
        const result = ledger.importSessionTask({
          sessionId: session.sessionId,
          title: session.title,
          prompt: [session.lastPrompt ?? session.title, sessionTaskSummary]
            .filter(Boolean)
            .join('\n\n'),
          projectRoot: session.cwd ?? config.workspace.root,
          status: session.isLive
            ? 'running'
            : deriveSessionStatus(session.externalTasks),
          sessionPath: session.transcriptPath,
          sessionPid: session.pid,
          lastActiveAt: session.lastActiveAt,
          resultSummary: [session.lastAssistantText, sessionTaskSummary]
            .filter(Boolean)
            .join('\n\n'),
        })
        result.created ? created++ : updated++
        linkedExternalTasks += session.externalTasks.length
      }
      console.log(
        `导入完成：新增 ${created}，更新 ${updated}，已选择 session ${ids.length}，绑定历史任务 ${linkedExternalTasks}`,
      )
      return
    }
    default:
      throw new Error(`未知 sessions 子命令：${subcommand}`)
  }
}

export function formatSessions(
  sessions: Awaited<ReturnType<typeof scanAuraSessions>>,
): string {
  if (sessions.length === 0) return '未发现 Aura CLI session。'
  return sessions
    .map(s =>
      [
        `${s.sessionId} | ${s.cli} | ${s.isLive ? 'live' : 'stored'} | ${s.title}`,
        `  pid=${s.pid ?? '-'} cwd=${s.cwd ?? '-'}`,
        `  messages=${s.messageCount} lastActive=${s.lastActiveAt ?? '-'}`,
        `  externalTasks=${formatExternalTaskCount(s.externalTasks)}`,
        `  transcript=${s.transcriptPath}`,
      ].join('\n'),
    )
    .join('\n\n')
}

function deriveSessionStatus(
  tasks: Awaited<ReturnType<typeof scanAuraSessions>>[number]['externalTasks'],
) {
  if (tasks.some(t => t.status === 'running' || t.status === 'waiting_user'))
    return 'running' as const
  if (tasks.some(t => t.status === 'queued' || t.status === 'stuck'))
    return 'stuck' as const
  if (tasks.some(t => t.status === 'failed')) return 'failed' as const
  if (tasks.length > 0 && tasks.every(t => t.status === 'completed'))
    return 'completed' as const
  return 'completed' as const
}

function formatExternalTaskCount(
  tasks: Awaited<ReturnType<typeof scanAuraSessions>>[number]['externalTasks'],
): string {
  if (tasks.length === 0) return '0'
  const counts = new Map<string, number>()
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
  return Array.from(counts.entries())
    .map(([status, count]) => `${status}:${count}`)
    .join(',')
}

function formatExternalTaskSummary(
  session: Awaited<ReturnType<typeof scanAuraSessions>>[number],
): string {
  if (session.externalTasks.length === 0) return ''
  const lines = [
    `External session tasks from .angsheng/tasks/${session.sessionId}:`,
    ...session.externalTasks.map(
      task =>
        `- [${task.status}] ${task.id}: ${task.subject}${task.description ? ` - ${task.description}` : ''}`,
    ),
  ]
  return lines.join('\n')
}
