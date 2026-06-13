export type DaemonRequest =
  | { type: 'ping' }
  | {
      type: 'add'
      prompt: string
      parentTaskId?: string
      taskKind?: 'manager' | 'session'
      completionCriteria?: string | null
    }
  | { type: 'retry'; taskId: string; resume?: boolean }
  | { type: 'resume_message'; taskId: string; message: string }
  | { type: 'answer'; taskId: string; answer: string }
  | { type: 'stop'; taskId: string }
  | { type: 'add_batch'; title: string; prompts: string[]; completionCriteria?: string | null }
  | { type: 'project_start'; goal: string; maxIterations?: number }
  | { type: 'project_list' }
  | { type: 'progress_scan'; force?: boolean }
  | { type: 'shutdown' }

export type DaemonResponse =
  | { ok: true; message?: string; data?: unknown }
  | { ok: false; error: string }

export interface DaemonStateFile {
  pid: number
  host: string
  port: number
  startedAt: string
  cwd: string
}
