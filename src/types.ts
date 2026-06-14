export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'stuck'
  | 'failed'
  | 'completed'
  | 'cancelled'
  | 'summarized'

export type TaskSource = 'spawned' | 'imported' | 'manual'
export type TaskKind = 'manager' | 'session'

export type TaskPriority = 'low' | 'medium' | 'high'

export type TaskCategory =
  | 'coding'
  | 'review'
  | 'test'
  | 'research'
  | 'doc'
  | 'other'

export type EventType =
  | 'task_queued'
  | 'task_started'
  | 'stdout_json'
  | 'raw_stdout'
  | 'stderr'
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result'
  | 'question'
  | 'session_id'
  | 'done'
  | 'exit'
  | 'watchdog_stuck'
  | 'watchdog_observation'
  | 'task_failed'
  | 'task_completed'
  | 'task_cancelled'
  | 'retry_started'
  | 'answer_sent'

export interface ButlerConfig {
  workspace: { name: string; root: string }
  aura: {
    mode: 'auto' | 'dev' | 'dist' | 'global'
    command?: string
    args?: string[]
    cwd?: string
    searchRoots?: string[]
  }
  execution: {
    maxParallelTasks: number
    taskTimeoutMinutes: number
    stuckAfterMinutes: number
    useStdinForPrompt: boolean
    outputFormat: 'stream-json'
    verbose: boolean
    terminateGraceSeconds: number
    schedulerIntervalSeconds?: number
    watchdogIntervalSeconds?: number
    progressReportIntervalSeconds?: number
  }
  retry: { maxRetries: number; resumeOnRetry: boolean }
  llm?: {
    enabled?: boolean
    provider?: 'openai-compatible'
    baseUrl?: string
    apiKeyEnv?: string
    model?: string
    timeoutMs?: number
  }
  storage: {
    dataDir: string
    databasePath: string
    logsDir: string
    artifactsDir: string
  }
}

export interface ResolvedAuraLaunch {
  mode: 'dev' | 'dist' | 'global'
  command: string
  args: string[]
  cwd: string
  source: string
}

export type ResolvedButlerConfig = ButlerConfig & {
  aura: ButlerConfig['aura'] & ResolvedAuraLaunch
}

export interface TaskRecord {
  id: string
  title: string
  displayName: string | null
  taskGroup: string | null
  prompt: string
  projectRoot: string
  category: TaskCategory
  priority: TaskPriority
  status: TaskStatus
  pid: number | null
  cliSessionId: string | null
  retryCount: number
  createdAt: string
  startedAt: string | null
  updatedAt: string
  finishedAt: string | null
  lastOutputAt: string | null
  waitingQuestion: string | null
  resultSummary: string | null
  resultArtifact: string | null
  errorMessage: string | null
  source: TaskSource
  taskKind: TaskKind
  parentTaskId: string | null
  completionCriteria: string | null
  progressSummary: string | null
  progressUpdatedAt: string | null
  completionVerdict: string | null
  completionReason: string | null
  lastProgressNotifiedAt: string | null
  inspectionEnabled: boolean
  userArchivedAt: string | null
  userArchiveNote: string | null
  sessionPath: string | null
  sessionPid: number | null
  importedAt: string | null
}

export interface AuraSessionSummary {
  cli: string
  sessionId: string
  title: string
  summary: string
  cwd: string | null
  pid: number | null
  isLive: boolean
  kind: string | null
  entrypoint: string | null
  transcriptPath: string
  registryPath: string | null
  messageCount: number
  createdAt: string | null
  lastActiveAt: string | null
  lastPrompt: string | null
  lastAssistantText: string | null
  projectHash: string
  externalTasks: ExternalSessionTask[]
}

export interface ExternalSessionTask {
  id: string
  subject: string
  description: string
  activeForm: string | null
  status: TaskStatus
  blocks: string[]
  blockedBy: string[]
  path: string
}

export interface WorkerRecord {
  id: string
  taskId: string
  pid: number | null
  status: TaskStatus
  command: string
  cwd: string
  stdoutPath: string
  stderrPath: string
  startedAt: string
  lastOutputAt: string | null
  exitCode: number | null
  signal: string | null
}

export type MuxEngine = 'tmux' | 'windows-terminal' | 'detached'

export interface MuxSessionRecord {
  id: string
  name: string
  engine: MuxEngine
  command: string
  cwd: string
  pid: number | null
  tmuxSession: string | null
  logPath: string | null
  status: 'running' | 'stopped' | 'unknown'
  createdAt: string
  updatedAt: string
}

export interface ProjectRecord {
  id: string
  goal: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  taskIds: string[]
  maxIterations: number
  iteration: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
  finalSummary: string | null
  lastNotification: string | null
  lastNotificationAt: string | null
  errorMessage: string | null
}

export interface EventRecord {
  id: number
  taskId: string
  type: EventType
  payloadJson: string | null
  text: string | null
  createdAt: string
}

export interface NormalizedStreamEvent {
  type: EventType
  text?: string
  payload?: unknown
  cliSessionId?: string
  question?: string
}

export interface StartTaskOptions {
  task: TaskRecord
  prompt: string
  resumeSessionId?: string | undefined
}

export interface StartTaskResult {
  pid: number
  workerId: string
  stdoutPath: string
  stderrPath: string
}
