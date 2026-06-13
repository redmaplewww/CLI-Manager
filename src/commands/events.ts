import { createContext } from './context'
import { formatEventList } from '../ui/formatter'

export function eventsCommand(taskId: string): void {
  const { ledger } = createContext()
  console.log(formatEventList(ledger.listEvents(taskId, 500)))
}
