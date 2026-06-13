import { createContext } from './context'
import { sendDaemonRequest } from '../daemonClient'

export async function answerCommand(
  taskId: string,
  answer: string,
): Promise<void> {
  const { supervisor } = createContext()
  const response = await sendDaemonRequest(
    supervisor.config,
    { type: 'answer', taskId, answer },
    5000,
  )
  if (response) {
    if (!response.ok) throw new Error(response.error)
    console.log(response.message ?? `Answered ${taskId}`)
    return
  }

  const ok = supervisor.adapter.answer(taskId, answer)
  if (!ok)
    throw new Error(
      `Task ${taskId} is not currently attached to this Butler process; retry with --resume when implemented.`,
    )
  console.log(`Sent answer to ${taskId}`)
}
