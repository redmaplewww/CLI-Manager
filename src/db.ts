import { Database, type SQLQueryBindings } from 'bun:sqlite'
import type {
  EventType,
  TaskCategory,
  TaskPriority,
  TaskRecord,
  TaskKind,
  TaskSource,
  TaskStatus,
  WorkerRecord,
} from './types'

export class TaskLedger {
  private db: Database

  constructor(databasePath: string) {
    this.db = new Database(databasePath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        project_root TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        cli_session_id TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        last_output_at TEXT,
        waiting_question TEXT,
        result_summary TEXT,
        result_artifact TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        stdout_path TEXT NOT NULL,
        stderr_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_output_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT,
        text TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_cli_session ON tasks(cli_session_id);
      CREATE INDEX IF NOT EXISTS idx_events_task_created ON events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_workers_task ON workers(task_id);
    `)
    this.ensureTaskColumn('source', "TEXT NOT NULL DEFAULT 'spawned'")
    this.ensureTaskColumn('display_name', 'TEXT')
    this.ensureTaskColumn('task_group', 'TEXT')
    this.ensureTaskColumn('task_kind', "TEXT NOT NULL DEFAULT 'session'")
    this.ensureTaskColumn('parent_task_id', 'TEXT')
    this.ensureTaskColumn('completion_criteria', 'TEXT')
    this.ensureTaskColumn('progress_summary', 'TEXT')
    this.ensureTaskColumn('progress_updated_at', 'TEXT')
    this.ensureTaskColumn('completion_verdict', 'TEXT')
    this.ensureTaskColumn('completion_reason', 'TEXT')
    this.ensureTaskColumn('last_progress_notified_at', 'TEXT')
    this.ensureTaskColumn('inspection_enabled', 'INTEGER NOT NULL DEFAULT 1')
    this.ensureTaskColumn('user_archived_at', 'TEXT')
    this.ensureTaskColumn('user_archive_note', 'TEXT')
    this.ensureTaskColumn('session_path', 'TEXT')
    this.ensureTaskColumn('session_pid', 'INTEGER')
    this.ensureTaskColumn('imported_at', 'TEXT')
  }

  private ensureTaskColumn(name: string, definition: string): void {
    const rows = this.db
      .query<{ name: string }, []>('PRAGMA table_info(tasks)')
      .all()
    if (rows.some(row => row.name === name)) return
    this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`)
  }

  nextTaskId(): string {
    const rows = this.db
      .query<{ id: string }, []>('SELECT id FROM tasks WHERE parent_task_id IS NULL')
      .all()
    let max = 0
    for (const row of rows) {
      const match = row.id.match(/^T(\d+)$/)
      if (match) max = Math.max(max, Number(match[1]))
    }
    return `T${String(max + 1).padStart(3, '0')}`
  }

  createTask(input: {
    title: string
    prompt: string
    projectRoot: string
    category?: TaskCategory
    priority?: TaskPriority
    status?: TaskStatus
    taskKind?: TaskKind
    parentTaskId?: string | null
    completionCriteria?: string | null
  }): TaskRecord {
    const now = new Date().toISOString()
    const task: TaskRecord = {
      id: input.parentTaskId
        ? this.nextChildTaskId(input.parentTaskId)
        : this.nextTaskId(),
      title: input.title,
      displayName: generateDisplayName(input.title, input.prompt),
      taskGroup: null,
      prompt: input.prompt,
      projectRoot: input.projectRoot,
      category: input.category ?? 'other',
      priority: input.priority ?? 'medium',
      status: input.status ?? 'queued',
      pid: null,
      cliSessionId: null,
      retryCount: 0,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      finishedAt: null,
      lastOutputAt: null,
      waitingQuestion: null,
      resultSummary: null,
      resultArtifact: null,
      errorMessage: null,
      source: 'spawned',
      taskKind: input.taskKind ?? 'session',
      parentTaskId: input.parentTaskId ?? null,
      completionCriteria:
        input.completionCriteria ?? inferCompletionCriteria(input.prompt),
      progressSummary: null,
      progressUpdatedAt: null,
      completionVerdict: null,
      completionReason: null,
      lastProgressNotifiedAt: null,
      inspectionEnabled: true,
      userArchivedAt: null,
      userArchiveNote: null,
      sessionPath: null,
      sessionPid: null,
      importedAt: null,
    }
    this.db
      .query(
        `INSERT INTO tasks (id, title, display_name, task_group, prompt, project_root, category, priority, status, pid, cli_session_id, retry_count, created_at, started_at, updated_at, finished_at, last_output_at, waiting_question, result_summary, result_artifact, error_message, source, task_kind, parent_task_id, completion_criteria, progress_summary, progress_updated_at, completion_verdict, completion_reason, last_progress_notified_at, inspection_enabled, user_archived_at, user_archive_note, session_path, session_pid, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.title,
        task.displayName,
        task.taskGroup,
        task.prompt,
        task.projectRoot,
        task.category,
        task.priority,
        task.status,
        task.pid,
        task.cliSessionId,
        task.retryCount,
        task.createdAt,
        task.startedAt,
        task.updatedAt,
        task.finishedAt,
        task.lastOutputAt,
        task.waitingQuestion,
        task.resultSummary,
        task.resultArtifact,
        task.errorMessage,
        task.source,
        task.taskKind,
        task.parentTaskId,
        task.completionCriteria,
        task.progressSummary,
        task.progressUpdatedAt,
        task.completionVerdict,
        task.completionReason,
        task.lastProgressNotifiedAt,
        task.inspectionEnabled ? 1 : 0,
        task.userArchivedAt,
        task.userArchiveNote,
        task.sessionPath,
        task.sessionPid,
        task.importedAt,
      )
    this.addEvent(task.id, 'task_queued', { title: task.title }, task.prompt)
    return task
  }

  nextChildTaskId(parentTaskId: string): string {
    const rows = this.db
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM tasks WHERE parent_task_id = ? OR id LIKE ? ORDER BY id',
      )
      .all(parentTaskId, `${parentTaskId}-%`)
    let max = 0
    for (const row of rows) {
      const match = row.id.match(new RegExp(`^${escapeRegex(parentTaskId)}-(\\d+)$`))
      if (!match) continue
      max = Math.max(max, Number(match[1]))
    }
    return `${parentTaskId}-${max + 1}`
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db
      .query<Record<string, unknown>, [string]>(
        'SELECT * FROM tasks WHERE id = ?',
      )
      .get(id)
    return row ? mapTask(row) : null
  }

  createManagerTask(input: {
    title: string
    prompt: string
    projectRoot: string
    completionCriteria?: string | null
  }): TaskRecord {
    const createInput: {
      title: string
      prompt: string
      projectRoot: string
      category: TaskCategory
      priority: TaskPriority
      status: TaskStatus
      taskKind: TaskKind
      completionCriteria?: string | null
    } = {
      title: input.title,
      prompt: input.prompt,
      projectRoot: input.projectRoot,
      category: 'other',
      priority: 'high',
      status: 'running',
      taskKind: 'manager',
    }
    if (input.completionCriteria !== undefined)
      createInput.completionCriteria = input.completionCriteria
    const task = this.createTask(createInput)
    this.addEvent(task.id, 'assistant_text', { managerTask: true }, '管家任务已创建，等待拆分或绑定子 session。')
    return this.getTask(task.id) ?? task
  }

  listChildTasks(parentTaskId: string): TaskRecord[] {
    const rows = this.db
      .query<Record<string, unknown>, [string]>(
        'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at',
      )
      .all(parentTaskId)
    return rows.map(mapTask)
  }

  listTasks(status?: TaskStatus, options: { includeArchived?: boolean } = {}): TaskRecord[] {
    const rows = status
      ? this.db
          .query<Record<string, unknown>, [string]>(
            `SELECT * FROM tasks WHERE status = ?${options.includeArchived ? '' : ' AND user_archived_at IS NULL'} ORDER BY created_at`,
          )
          .all(status)
      : this.db
          .query<Record<string, unknown>, []>(
            `SELECT * FROM tasks${options.includeArchived ? '' : ' WHERE user_archived_at IS NULL'} ORDER BY created_at`,
          )
          .all()
    return rows.map(mapTask)
  }

  listArchivedTasks(): TaskRecord[] {
    const rows = this.db
      .query<Record<string, unknown>, []>(
        'SELECT * FROM tasks WHERE user_archived_at IS NOT NULL ORDER BY user_archived_at DESC',
      )
      .all()
    return rows.map(mapTask)
  }

  archiveTask(id: string, note: string | null = null): void {
    this.updateTask(id, {
      userArchivedAt: new Date().toISOString(),
      userArchiveNote: note,
    })
    this.addEvent(id, 'task_completed', { userArchived: true }, note ?? '用户确认归档')
  }

  unarchiveTask(id: string): void {
    this.updateTask(id, { userArchivedAt: null, userArchiveNote: null })
    this.addEvent(id, 'retry_started', { userUnarchived: true }, '用户从归档恢复')
  }

  deleteTask(id: string): void {
    this.db.query('DELETE FROM tasks WHERE id = ?').run(id)
  }

  getTaskByCliSessionId(sessionId: string): TaskRecord | null {
    const row = this.db
      .query<Record<string, unknown>, [string]>(
        'SELECT * FROM tasks WHERE cli_session_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(sessionId)
    return row ? mapTask(row) : null
  }

  importSessionTask(input: {
    sessionId: string
    title: string
    prompt: string
    projectRoot: string
    status: TaskStatus
    sessionPath: string
    sessionPid: number | null
    lastActiveAt: string | null
    resultSummary: string | null
  }): { task: TaskRecord; created: boolean } {
    const existing = this.getTaskByCliSessionId(input.sessionId)
    const now = new Date().toISOString()
    if (existing) {
      this.updateTask(existing.id, {
        title: input.title,
        prompt: input.prompt,
        projectRoot: input.projectRoot,
        status: input.status,
        cliSessionId: input.sessionId,
        sessionPath: input.sessionPath,
        sessionPid: input.sessionPid,
        lastOutputAt: input.lastActiveAt,
        resultSummary: input.resultSummary,
        source: 'imported',
        taskKind: 'session',
      })
      return { task: this.getTask(existing.id)!, created: false }
    }
    const task = this.createTask({
      title: input.title,
      prompt: input.prompt,
      projectRoot: input.projectRoot,
      category: 'other',
      priority: 'medium',
    })
    this.updateTask(task.id, {
      status: input.status,
      cliSessionId: input.sessionId,
      sessionPath: input.sessionPath,
      sessionPid: input.sessionPid,
      lastOutputAt: input.lastActiveAt,
      resultSummary: input.resultSummary,
      source: 'imported',
      taskKind: 'session',
      importedAt: now,
      startedAt: input.lastActiveAt,
      finishedAt: input.status === 'completed' ? input.lastActiveAt : null,
    })
    this.addEvent(
      task.id,
      'session_id',
      { imported: true, sessionPath: input.sessionPath },
      input.sessionId,
    )
    return { task: this.getTask(task.id)!, created: true }
  }

  updateTask(id: string, patch: Partial<TaskRecord>): void {
    const entries = Object.entries(toDbPatch(patch))
    if (entries.length === 0) return
    entries.push(['updated_at', new Date().toISOString()])
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    const values = entries.map(([, value]) => value as SQLQueryBindings)
    this.db
      .query(`UPDATE tasks SET ${sets} WHERE id = ?`)
      .run(...([...values, id] as SQLQueryBindings[]))
  }

  addWorker(worker: WorkerRecord): void {
    this.db
      .query(`INSERT INTO workers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        worker.id,
        worker.taskId,
        worker.pid,
        worker.status,
        worker.command,
        worker.cwd,
        worker.stdoutPath,
        worker.stderrPath,
        worker.startedAt,
        worker.lastOutputAt,
        worker.exitCode,
        worker.signal,
      )
  }

  updateWorker(id: string, patch: Partial<WorkerRecord>): void {
    const entries = Object.entries(toDbPatch(patch))
    if (entries.length === 0) return
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    const values = entries.map(([, value]) => value as SQLQueryBindings)
    this.db
      .query(`UPDATE workers SET ${sets} WHERE id = ?`)
      .run(...([...values, id] as SQLQueryBindings[]))
  }

  getLatestWorker(taskId: string): WorkerRecord | null {
    const row = this.db
      .query<Record<string, unknown>, [string]>(
        'SELECT * FROM workers WHERE task_id = ? ORDER BY started_at DESC LIMIT 1',
      )
      .get(taskId)
    return row ? mapWorker(row) : null
  }

  addEvent(
    taskId: string,
    type: EventType,
    payload?: unknown,
    text?: string,
  ): void {
    this.db
      .query(
        'INSERT INTO events (task_id, type, payload_json, text, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        taskId,
        type,
        payload === undefined ? null : JSON.stringify(payload),
        text ?? null,
        new Date().toISOString(),
      )
  }

  listEvents(
    taskId: string,
    limit = 200,
  ): Array<{
    type: string
    text: string | null
    payloadJson: string | null
    createdAt: string
  }> {
    return this.db
      .query<any, [string, number]>(
        'SELECT type, text, payload_json as payloadJson, created_at as createdAt FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(taskId, limit)
      .reverse()
  }
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    displayName: nullableString(row.display_name),
    taskGroup: nullableString(row.task_group),
    prompt: String(row.prompt),
    projectRoot: String(row.project_root),
    category: row.category as TaskCategory,
    priority: row.priority as TaskPriority,
    status: row.status as TaskStatus,
    pid: nullableNumber(row.pid),
    cliSessionId: nullableString(row.cli_session_id),
    retryCount: Number(row.retry_count ?? 0),
    createdAt: String(row.created_at),
    startedAt: nullableString(row.started_at),
    updatedAt: String(row.updated_at),
    finishedAt: nullableString(row.finished_at),
    lastOutputAt: nullableString(row.last_output_at),
    waitingQuestion: nullableString(row.waiting_question),
    resultSummary: nullableString(row.result_summary),
    resultArtifact: nullableString(row.result_artifact),
    errorMessage: nullableString(row.error_message),
    source: (row.source ?? 'spawned') as TaskSource,
    taskKind: (row.task_kind ?? 'session') as TaskKind,
    parentTaskId: nullableString(row.parent_task_id),
    completionCriteria: nullableString(row.completion_criteria),
    progressSummary: nullableString(row.progress_summary),
    progressUpdatedAt: nullableString(row.progress_updated_at),
    completionVerdict: nullableString(row.completion_verdict),
    completionReason: nullableString(row.completion_reason),
    lastProgressNotifiedAt: nullableString(row.last_progress_notified_at),
    inspectionEnabled: Number(row.inspection_enabled ?? 1) !== 0,
    userArchivedAt: nullableString(row.user_archived_at),
    userArchiveNote: nullableString(row.user_archive_note),
    sessionPath: nullableString(row.session_path),
    sessionPid: nullableNumber(row.session_pid),
    importedAt: nullableString(row.imported_at),
  }
}

function mapWorker(row: Record<string, unknown>): WorkerRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    pid: nullableNumber(row.pid),
    status: row.status as TaskStatus,
    command: String(row.command),
    cwd: String(row.cwd),
    stdoutPath: String(row.stdout_path),
    stderrPath: String(row.stderr_path),
    startedAt: String(row.started_at),
    lastOutputAt: nullableString(row.last_output_at),
    exitCode: nullableNumber(row.exit_code),
    signal: nullableString(row.signal),
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toDbPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, string> = {
    projectRoot: 'project_root',
    cliSessionId: 'cli_session_id',
    retryCount: 'retry_count',
    createdAt: 'created_at',
    startedAt: 'started_at',
    updatedAt: 'updated_at',
    finishedAt: 'finished_at',
    lastOutputAt: 'last_output_at',
    waitingQuestion: 'waiting_question',
    resultSummary: 'result_summary',
    resultArtifact: 'result_artifact',
    errorMessage: 'error_message',
    displayName: 'display_name',
    taskGroup: 'task_group',
    taskKind: 'task_kind',
    parentTaskId: 'parent_task_id',
    completionCriteria: 'completion_criteria',
    progressSummary: 'progress_summary',
    progressUpdatedAt: 'progress_updated_at',
    completionVerdict: 'completion_verdict',
    completionReason: 'completion_reason',
    lastProgressNotifiedAt: 'last_progress_notified_at',
    inspectionEnabled: 'inspection_enabled',
    userArchivedAt: 'user_archived_at',
    userArchiveNote: 'user_archive_note',
    sessionPath: 'session_path',
    sessionPid: 'session_pid',
    importedAt: 'imported_at',
    taskId: 'task_id',
    stdoutPath: 'stdout_path',
    stderrPath: 'stderr_path',
    exitCode: 'exit_code',
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) out[map[key] ?? key] = value
  return out
}

function inferCompletionCriteria(prompt: string): string {
  const text = prompt.replace(/\s+/g, ' ').trim()
  const criteria: string[] = []
  const explicit = text.match(/(?:结束判定|完成标准|验收标准|completion criteria|success criteria|done when|acceptance criteria)[:：]?\s*(.{12,260})/i)?.[1]
  if (explicit) criteria.push(explicit)
  if (/(测试|test|typecheck|lint|build)/i.test(text))
    criteria.push('相关测试、类型检查或构建命令通过，或明确说明无法运行的原因。')
  if (/(修改|实现|修复|生成|写入|创建|update|implement|fix|create|write)/i.test(text))
    criteria.push('目标文件或代码改动已完成，并说明修改位置和验证结果。')
  if (/(检查|分析|调研|review|inspect|analyze|research)/i.test(text))
    criteria.push('输出清晰结论、证据来源、风险/阻塞项和下一步建议。')
  if (criteria.length === 0)
    criteria.push('用户目标已被逐项回应；若无法完成，明确给出阻塞原因和可执行下一步。')
  return criteria.map((item, index) => `${index + 1}. ${item}`).join('\n')
}

function generateDisplayName(title: string, prompt: string): string {
  const text = (title || prompt).replace(/\s+/g, ' ').trim()
  const material = text.match(/\b(Cu|Al|Fe|Ni|Mg|Zr|Ti|MoS2)\b/i)?.[1]
  if (/拉伸|tensile/i.test(text) && material)
    return `${material} 单晶拉伸试算`
  if (/压缩|compression/i.test(text) && material)
    return `${material} 单晶压缩试算`
  if (/workflow-auto/i.test(text)) return text.replace(/^\/workflow-auto\s*/i, '').slice(0, 40)
  return text.slice(0, 40)
}
