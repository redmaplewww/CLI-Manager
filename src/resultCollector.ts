import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ResolvedButlerConfig } from './types'
import { TaskLedger } from './db'

export class ResultCollector {
  constructor(
    private readonly config: ResolvedButlerConfig,
    private readonly ledger: TaskLedger,
  ) {}

  collect(taskId: string, finalAssistantText: string): string {
    mkdirSync(this.config.storage.artifactsDir, { recursive: true })
    const task = this.ledger.getTask(taskId)
    const events = this.ledger.listEvents(taskId, 1000)
    const artifactPath = join(
      this.config.storage.artifactsDir,
      `${taskId}.result.json`,
    )
    const summaryPath = join(
      this.config.storage.artifactsDir,
      `${taskId}.summary.md`,
    )
    const toolUses = events
      .filter(e => e.type === 'tool_use')
      .map(e => e.text)
      .filter(Boolean)
    const stderrTail = events
      .filter(e => e.type === 'stderr')
      .map(e => e.text ?? '')
      .join('')
      .slice(-2000)
    const summary =
      finalAssistantText.trim() ||
      lastAssistantText(events) ||
      'Task completed without assistant summary.'

    writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          task_id: taskId,
          status: 'completed',
          cli_session_id: task?.cliSessionId ?? null,
          summary,
          tool_uses: toolUses,
          stderr_tail: stderrTail,
          generated_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
    writeFileSync(summaryPath, `# ${taskId} Summary\n\n${summary}\n`)
    return artifactPath
  }
}

function lastAssistantText(
  events: Array<{ type: string; text: string | null }>,
): string {
  const texts = events
    .filter(e => e.type === 'assistant_text' && e.text)
    .map(e => e.text as string)
  return texts.at(-1)?.trim() ?? ''
}
