import { createContext } from './context'
import { sendDaemonRequest } from '../daemonClient'

export async function addCommand(prompt: string): Promise<void> {
  const { config, ledger, supervisor } = createContext()
  const response = await sendDaemonRequest(
    config,
    { type: 'add', prompt },
    5000,
  )
  if (response) {
    if (!response.ok) throw new Error(response.error)
    console.log(response.message ?? 'Task queued')
    return
  }

  const task = ledger.createTask({
    title: prompt.slice(0, 80),
    prompt,
    projectRoot: config.workspace.root,
  })
  supervisor.startTaskNow(task.id)
  console.log(`Started ${task.id}: ${task.title}`)
}
