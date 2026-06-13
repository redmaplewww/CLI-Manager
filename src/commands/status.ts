import { createContext } from './context'
import { formatTaskList } from '../ui/formatter'

export function statusCommand(): void {
  const { ledger } = createContext()
  const tasks = ledger.listTasks()
  console.log(formatTaskList(tasks))
}
