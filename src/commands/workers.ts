import { createContext } from './context'
import { formatWorker } from '../ui/formatter'

export function workersCommand(): void {
  const { ledger } = createContext()
  const rows: string[] = []
  for (const task of ledger.listTasks()) {
    const worker = ledger.getLatestWorker(task.id)
    if (worker) rows.push(formatWorker(worker))
  }
  console.log(rows.join('\n\n') || '暂无 CLI worker。')
}
