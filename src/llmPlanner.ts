import type { ChatAction } from './chatRouter'
import type { ResolvedButlerConfig, TaskRecord } from './types'

export interface ChatPlan {
  summary: string
  actions: ChatAction[]
  monitor: boolean
  monitorEverySeconds?: number
  monitorUntil?: 'all_done' | 'first_done' | 'none'
}

export class LlmPlanner {
  constructor(private readonly config: ResolvedButlerConfig) {}

  isEnabled(): boolean {
    const llm = this.config.llm
    if (!llm?.enabled) return false
    const keyEnv = llm.apiKeyEnv ?? 'OPENAI_API_KEY'
    return Boolean(process.env[keyEnv])
  }

  async plan(
    input: string,
    context: { tasks: TaskRecord[] },
  ): Promise<ChatPlan | null> {
    if (!this.isEnabled()) return null
    const llm = this.config.llm!
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      llm.timeoutMs ?? 20_000,
    )
    try {
      const response = await fetch(
        `${trimSlash(llm.baseUrl ?? 'https://api.openai.com/v1')}/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env[llm.apiKeyEnv ?? 'OPENAI_API_KEY']}`,
          },
          body: JSON.stringify({
            model: llm.model ?? 'gpt-4o-mini',
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: plannerSystemPrompt() },
              {
                role: 'user',
                content: JSON.stringify({
                  input,
                  tasks: summarizeTasks(context.tasks),
                }),
              },
            ],
          }),
        },
      )
      if (!response.ok) return null
      const json = (await response.json()) as any
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') return null
      return parsePlannedPlan(content)
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  async reply(
    input: string,
    context: { tasks: TaskRecord[]; language?: 'zh' | 'en' },
  ): Promise<string | null> {
    if (!this.isEnabled()) return null
    const llm = this.config.llm!
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      llm.timeoutMs ?? 20_000,
    )
    try {
      const response = await fetch(
        `${trimSlash(llm.baseUrl ?? 'https://api.openai.com/v1')}/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env[llm.apiKeyEnv ?? 'OPENAI_API_KEY']}`,
          },
          body: JSON.stringify({
            model: llm.model ?? 'gpt-4o-mini',
            temperature: 0.3,
            messages: [
              {
                role: 'system',
                content:
                  context.language === 'en'
                    ? 'You are Aura Butler, the manager agent. You talk directly to the user. Understand goals, explain what you can do, and only delegate to CLI workers when execution is clearly needed. When the user asks for a status check or progress report, synthesize a clear butler-style summary from the task data: what is done, what is in progress, what failed, and what needs attention. Do not dump raw task lists. Reply in concise English using ASCII characters only.'
                    : '你是 Aura Butler 管家 Agent。你直接和用户对话，负责理解目标、说明你能做什么、必要时再分派 CLI worker。当用户询问进度、状态或任务完成情况时，请根据任务数据生成管家式汇报：哪些已完成、哪些进行中、哪些失败/卡住、哪些需要关注。不要直接贴原始任务列表，而是归纳总结。优先中文，简洁。',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  input,
                  tasks: summarizeTasks(context.tasks),
                }),
              },
            ],
          }),
        },
      )
      if (!response.ok) return null
      const json = (await response.json()) as any
      const content = json.choices?.[0]?.message?.content
      return typeof content === 'string' ? content.trim() : null
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  async summarizeProgress(context: {
    tasks: TaskRecord[]
    workContext?: { filePath: string | null; content: string }
  }): Promise<string | null> {
    if (!this.isEnabled()) return null
    const llm = this.config.llm!
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      llm.timeoutMs ?? 20_000,
    )
    try {
      const response = await fetch(
        `${trimSlash(llm.baseUrl ?? 'https://api.openai.com/v1')}/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env[llm.apiKeyEnv ?? 'OPENAI_API_KEY']}`,
          },
          body: JSON.stringify({
            model: llm.model ?? 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
              {
                role: 'system',
                content:
                  'You are Aura Butler. Briefly summarize task progress, blockers, completed work, and what you will monitor next. Be concise and operational.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  tasks: summarizeTasks(context.tasks),
                  workContext: context.workContext,
                }),
              },
            ],
          }),
        },
      )
      if (!response.ok) return null
      const json = (await response.json()) as any
      const content = json.choices?.[0]?.message?.content
      return typeof content === 'string' ? content.trim() : null
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  async requireProgressSummary(context: {
    tasks: TaskRecord[]
  }): Promise<string> {
    const summary = await this.summarizeProgress(context)
    if (!summary)
      throw new Error(
        'LLM summary is required but unavailable. Enable llm.enabled and configure an API key.',
      )
    return summary
  }

  async draftRecoveryPrompt(context: {
    goal: string
    tasks: TaskRecord[]
    failed: TaskRecord[]
    iteration: number
  }): Promise<string> {
    if (!this.isEnabled()) {
      return this.fallbackRecoveryPrompt(context)
    }
    const llm = this.config.llm!
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      llm.timeoutMs ?? 20_000,
    )
    try {
      const response = await fetch(
        `${trimSlash(llm.baseUrl ?? 'https://api.openai.com/v1')}/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env[llm.apiKeyEnv ?? 'OPENAI_API_KEY']}`,
          },
          body: JSON.stringify({
            model: llm.model ?? 'gpt-4o-mini',
            temperature: 0.1,
            messages: [
              {
                role: 'system',
                content:
                  'You are Aura Butler. Write the next recovery prompt to send to the execution CLI. The prompt must be complete, specific, and based on observed task outcomes. Return only the worker prompt.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  goal: context.goal,
                  iteration: context.iteration,
                  tasks: summarizeTasks(context.tasks),
                  failed: summarizeTasks(context.failed),
                }),
              },
            ],
          }),
        },
      )
      if (!response.ok) {
        console.warn(`LLM recovery prompt failed: ${response.status}, using fallback`)
        return this.fallbackRecoveryPrompt(context)
      }
      const json = (await response.json()) as any
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) {
        console.warn('LLM returned empty recovery prompt, using fallback')
        return this.fallbackRecoveryPrompt(context)
      }
      return content.trim()
    } finally {
      clearTimeout(timeout)
    }
  }

  private fallbackRecoveryPrompt(context: {
    goal: string
    tasks: TaskRecord[]
    failed: TaskRecord[]
    iteration: number
  }): string {
    const failedSummary = context.failed
      .map(t => `${t.id}: ${t.status} - ${t.errorMessage ?? t.resultSummary ?? 'no details'}`)
      .join('\n')
    return [
      `Continue working on: ${context.goal}`,
      `This is recovery iteration ${context.iteration}.`,
      '',
      'Previously failed tasks:',
      failedSummary || 'No details available.',
      '',
      'Review what went wrong, fix the issues, and continue toward the goal.',
      'Read any PROJECT.md or project management files for current state and next steps.',
    ].join('\n')
  }

  async draftTaskContinuationPrompt(context: {
    task: TaskRecord
    judgement: string
    workContext?: { filePath: string | null; content: string }
  }): Promise<string | null> {
    if (!this.isEnabled()) return null
    const llm = this.config.llm!
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), llm.timeoutMs ?? 20_000)
    try {
      const response = await fetch(
        `${trimSlash(llm.baseUrl ?? 'https://api.openai.com/v1')}/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env[llm.apiKeyEnv ?? 'OPENAI_API_KEY']}`,
          },
          body: JSON.stringify({
            model: llm.model ?? 'gpt-4o-mini',
            temperature: 0.1,
            messages: [
              {
                role: 'system',
                content:
                  'You are Aura Butler. Write a concrete continuation prompt for an execution CLI. Use the project management file as the source of truth for current stage, completed work, missing work, and next actions. Return only the prompt to send to the CLI.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  task: summarizeTasks([context.task])[0],
                  judgement: context.judgement,
                  workContext: context.workContext,
                }),
              },
            ],
          }),
        },
      )
      if (!response.ok) return null
      const json = (await response.json()) as any
      const content = json.choices?.[0]?.message?.content
      return typeof content === 'string' ? content.trim() : null
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  async judgeTaskCompletionWithContext(context: {
    task: TaskRecord
    ruleJudgement: string
    sessionSummary: string
    workContext: { filePath: string | null; content: string }
  }): Promise<{
    verdict: 'done' | 'not_done' | 'needs_review' | 'uncertain'
    reason: string
    question?: string
  } | null> {
    if (!this.isEnabled()) return null
    const llm = this.config.llm!
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), llm.timeoutMs ?? 20_000)
    try {
      const response = await fetch(
        `${trimSlash(llm.baseUrl ?? 'https://api.openai.com/v1')}/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env[llm.apiKeyEnv ?? 'OPENAI_API_KEY']}`,
          },
          body: JSON.stringify({
            model: llm.model ?? 'gpt-4o-mini',
            temperature: 0,
            messages: [
              {
                role: 'system',
                content:
                  'You are Aura Butler completion judge. PROJECT/work management file is mandatory source of truth. Do not request full logs or full file trees. Judge from PROJECT content, task criteria, and summarized session answer only. Return strict JSON: {"verdict":"done|not_done|needs_review|uncertain","reason":"...","question":"optional concise question to ask agent if uncertain"}. Done requires a complete reliable conclusion as defined by PROJECT.md or task criteria.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  task: summarizeTasks([context.task])[0],
                  ruleJudgement: context.ruleJudgement,
                  projectFile: context.workContext.filePath,
                  projectContent: context.workContext.content,
                  sessionSummary: context.sessionSummary.slice(-6000),
                }),
              },
            ],
          }),
        },
      )
      if (!response.ok) return null
      const json = (await response.json()) as any
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') return null
      return parseJsonObject(content)
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  async summarizeProjectFinal(context: {
    goal: string
    tasks: TaskRecord[]
    status: string
  }): Promise<string> {
    const summary = await this.requireProgressSummary({ tasks: context.tasks })
    return `项目目标：${context.goal}\n项目状态：${context.status}\n\n${summary}`
  }
}

function plannerSystemPrompt(): string {
  return `You are Aura Butler's autonomous task manager. Convert the user's natural-language message into a JSON plan.

Allowed actions:
{"type":"help"}
{"type":"manager_reply","message":"..."}
{"type":"status"}
{"type":"workers"}
{"type":"daemon_status"}
{"type":"start_daemon"}
{"type":"stop_daemon"}
{"type":"add_task","prompt":"..."}
{"type":"events","taskId":"T001"}
{"type":"logs","taskId":"T001"}
{"type":"result","taskId":"T001"}
{"type":"stop_task","taskId":"T001"}
{"type":"retry_task","taskId":"T001","resume":true|false}
{"type":"answer_task","taskId":"T001","answer":"..."}
{"type":"mux_engines"}
{"type":"mux_list"}
{"type":"mux_start","name":"optional","prompt":"optional","engine":"tmux|windows-terminal|detached optional"}
{"type":"sessions_list"}
{"type":"sessions_import"}
{"type":"project_start","goal":"...","maxIterations":5}
{"type":"project_list"}

Return shape:
{"summary":"what you will do","monitor":true|false,"monitorEverySeconds":number,"monitorUntil":"all_done|first_done|none","actions":[ACTION,...]}

Rules:
- Return only JSON, no markdown.
- The user is talking to the Butler manager first, not directly to a worker task.
- For greetings, clarification, capability questions, casual conversation, or ambiguous messages, use manager_reply. Do NOT create add_task.
- For conversation about Butler behavior, preferences, policies, prior results, or plans that are not direct CLI execution requests, use manager_reply. Do NOT create add_task.
- If the user says task creation should be limited to CLI-related work, confirms a preference, or complains that a chat message became a task, acknowledge it with manager_reply instead of creating a task.
- Only create add_task/project_start when the user clearly asks Butler to execute, inspect, fix, review, test, research, monitor, or own a project workflow.
- You may emit multiple actions. If the user asks for multiple objectives, split them into multiple add_task actions.
- If the user asks for one parent objective containing multiple parallel cases (for example Cu/Al/Fe variants, ten paper reproductions, multiple materials), split into child add_task actions; Butler will group them under one manager task instead of flat tasks.
- If the user asks Butler to own a large manager-level objective, prefer project_start. A project_start creates one manager task and child session tasks; do not flatten it into unrelated add_task actions.
- For add_task prompts, include explicit completion criteria ONLY when the task has concrete acceptance checks (e.g. tests must pass, a specific file must exist, a specific output must be produced). For simple tasks (file creation, quick edits, information queries, reviews), omit completion criteria or derive them directly from the task itself. Do not add generic criteria like "tests pass" unless the task explicitly involves testing.
- Preserve slash commands as executable command prefixes. If the user says to use workflow-auto skill, the worker prompt must start with "/workflow-auto ...", not prose such as "use /workflow-auto skill".
- If the user asks to discover, bind, import, manage, or take over existing CLI sessions, use sessions_import or sessions_list. Do NOT create add_task for that search/import operation.
- If a request implies implementation plus review/test, create separate tasks when useful: implementation, verification, summary/review.
- If the user asks broadly, create a small plan of concrete tasks rather than one vague task.
- If the user asks you to manage work autonomously, set monitor=true and monitorUntil=all_done.
- For engineering/research/checking work, use add_task with a complete prompt including scope, constraints, and expected output.
- If the user asks for a status check, progress summary, task report, or what's left to do (进度、状态、检查任务、还有什么没做完、汇报), use manager_reply to synthesize a conversational report from task data. The user expects a butler-style summary, not a raw data dump. Only use the status action if the user explicitly asks for a raw task list or table.
- If they mention a task id and result/log/events, choose the matching action.
- Never invent task ids. If no task id is given for task-specific actions, use status.
- Keep prompts complete and actionable.
- Do not ask the user to manually run manager commands; call actions instead.`
}

function parsePlannedPlan(content: string): ChatPlan | null {
  try {
    const parsed = JSON.parse(content) as Partial<ChatPlan> | ChatAction
    if (!parsed || typeof parsed !== 'object') return null
    if ('actions' in parsed && Array.isArray(parsed.actions)) {
      return {
        summary:
          typeof parsed.summary === 'string'
            ? parsed.summary
            : 'Executing plan',
        actions: parsed.actions.filter(isAction),
        monitor: Boolean(parsed.monitor),
        monitorEverySeconds:
          typeof parsed.monitorEverySeconds === 'number'
            ? parsed.monitorEverySeconds
            : 10,
        monitorUntil: parsed.monitorUntil ?? 'none',
      }
    }
    if (isAction(parsed)) {
      return {
        summary: 'Executing action',
        actions: [parsed],
        monitor: false,
        monitorUntil: 'none',
      }
    }
    return null
  } catch {
    return null
  }
}

function parseJsonObject(content: string): any | null {
  try {
    return JSON.parse(content)
  } catch {
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

function isAction(value: unknown): value is ChatAction {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as any).type === 'string',
  )
}

function summarizeTasks(
  tasks: TaskRecord[],
): Array<Record<string, string | null>> {
  if (tasks.length <= 25) {
    return tasks.map(task => summarizeOne(task))
  }
  const kept = tasks.slice(-20)
  const earlier = tasks.slice(0, -20)
  const statusCounts = new Map<string, number>()
  for (const t of earlier) statusCounts.set(t.status, (statusCounts.get(t.status) ?? 0) + 1)
  return [
    {
      id: 'SUMMARY',
      title: `(${earlier.length} earlier tasks: ${Array.from(statusCounts.entries()).map(([s, c]) => `${s}:${c}`).join(', ')})`,
      status: 'summarized',
      waitingQuestion: null,
    },
    ...kept.map(task => summarizeOne(task)),
  ]
}

function summarizeOne(task: TaskRecord): Record<string, string | null> {
  const summary = task.resultSummary
    ? task.resultSummary.replace(/\s+/g, ' ').trim().slice(0, 500)
    : null
  const error = task.errorMessage
    ? task.errorMessage.replace(/\s+/g, ' ').trim().slice(0, 300)
    : null
  const verdict = task.completionVerdict ?? null
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    waitingQuestion: task.waitingQuestion,
    resultSummary: summary,
    errorMessage: error,
    completionVerdict: verdict,
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
