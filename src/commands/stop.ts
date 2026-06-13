import { createContext } from './context'
import { sendDaemonRequest } from '../daemonClient'

export async function stopCommand(taskId: string): Promise<void> {
  const { supervisor, ledger } = createContext()
  const response = await sendDaemonRequest(
    supervisor.config,
    { type: 'stop', taskId },
    5000,
  )
  if (response) {
    if (!response.ok) throw new Error(response.error)
    console.log(response.message ?? `Stopped ${taskId}`)
    return
  }

  const ok = supervisor.adapter.stop(taskId)
  if (!ok) {
    ledger.updateTask(taskId, {
      status: 'cancelled',
      pid: null,
      finishedAt: new Date().toISOString(),
    })
    ledger.addEvent(taskId, 'task_cancelled')
  }
  console.log(`Stopped ${taskId}`)
}
