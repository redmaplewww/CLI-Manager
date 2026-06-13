import { existsSync, readFileSync } from 'fs'
import { createContext } from './context'

export function logsCommand(taskId: string): void {
  const { ledger } = createContext()
  const worker = ledger.getLatestWorker(taskId)
  if (!worker) throw new Error(`No worker found for ${taskId}`)
  if (!existsSync(worker.stdoutPath))
    throw new Error(`Log not found: ${worker.stdoutPath}`)
  process.stdout.write(readFileSync(worker.stdoutPath, 'utf-8'))
}
