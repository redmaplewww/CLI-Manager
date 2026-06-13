import { createContext } from './context'
import { formatResult } from '../ui/formatter'

export function resultCommand(taskId: string): void {
  const { ledger } = createContext()
  const task = ledger.getTask(taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  console.log(formatResult(task))
}
