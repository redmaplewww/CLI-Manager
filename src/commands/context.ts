import { loadConfig } from '../config'
import { TaskLedger } from '../db'
import { Supervisor } from '../supervisor'

export function createContext() {
  const config = loadConfig()
  const ledger = new TaskLedger(config.storage.databasePath)
  const supervisor = new Supervisor(config, ledger)
  return { config, ledger, supervisor }
}
