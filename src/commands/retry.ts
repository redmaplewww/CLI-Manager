import { createContext } from './context'
import { sendDaemonRequest } from '../daemonClient'

export async function retryCommand(
  taskId: string,
  opts: { resume?: boolean },
): Promise<void> {
  const { ledger, supervisor } = createContext()
  const response = await sendDaemonRequest(
    supervisor.config,
    { type: 'retry', taskId, resume: opts.resume ?? false },
    5000,
  )
  if (response) {
    if (!response.ok) throw new Error(response.error)
    console.log(response.message ?? `Retried ${taskId}`)
    return
  }

  const task = ledger.getTask(taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  ledger.updateTask(taskId, {
    status: 'queued',
    retryCount: task.retryCount + 1,
    errorMessage: null,
  })
  ledger.addEvent(taskId, 'retry_started', { resume: opts.resume ?? false })
  supervisor.startTaskNow(taskId, undefined, opts.resume ?? false)
  console.log(`Retried ${taskId}${opts.resume ? ' with --resume' : ''}`)
}
