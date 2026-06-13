import type { NormalizedStreamEvent } from '../types'

export function parseStreamJsonLine(line: string): NormalizedStreamEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  let json: any
  try {
    json = JSON.parse(trimmed)
  } catch {
    return [{ type: 'raw_stdout', text: trimmed }]
  }

  const events: NormalizedStreamEvent[] = [
    { type: 'stdout_json', payload: json },
  ]
  extractSessionId(json, events)
  extractAssistantContent(json, events)
  extractDone(json, events)
  return events
}

function extractSessionId(json: any, events: NormalizedStreamEvent[]): void {
  const sessionId =
    json.session_id ??
    json.sessionId ??
    json.message?.session_id ??
    json.message?.id
  if (typeof sessionId === 'string' && looksLikeSessionId(sessionId)) {
    events.push({
      type: 'session_id',
      cliSessionId: sessionId,
      text: sessionId,
    })
  }
}

function extractAssistantContent(
  json: any,
  events: NormalizedStreamEvent[],
): void {
  if (json.type !== 'assistant') return
  const content = json.message?.content
  if (!Array.isArray(content)) return

  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      events.push({ type: 'assistant_text', text: block.text, payload: block })
    }
    if (block?.type === 'tool_use') {
      const toolName = typeof block.name === 'string' ? block.name : 'unknown'
      events.push({ type: 'tool_use', text: toolName, payload: block })
      if (toolName === 'AskUserQuestion') {
        const question =
          block.input?.question ?? block.input?.prompt ?? block.input?.message
        if (typeof question === 'string') {
          events.push({
            type: 'question',
            text: question,
            question,
            payload: block,
          })
        }
      }
    }
    if (block?.type === 'tool_result') {
      events.push({
        type: 'tool_result',
        text: summarizeToolResult(block),
        payload: block,
      })
    }
  }
}

function extractDone(json: any, events: NormalizedStreamEvent[]): void {
  if (json.type === 'result' || json.type === 'done') {
    events.push({
      type: 'done',
      text: typeof json.result === 'string' ? json.result : undefined,
      payload: json,
    })
  }
}

function summarizeToolResult(block: any): string {
  const content = block.content
  if (typeof content === 'string') return content.slice(0, 500)
  if (Array.isArray(content)) return JSON.stringify(content).slice(0, 500)
  return JSON.stringify(block).slice(0, 500)
}

function looksLikeSessionId(value: string): boolean {
  return value.length >= 8
}
