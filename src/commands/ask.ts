import { loadConfig } from '../config'
import { TaskLedger } from '../db'
import { ButlerAgent } from '../butlerAgent'

export async function askCommand(input: string[]): Promise<void> {
  const text = input.join(' ').trim()
  if (!text)
    throw new Error(
      '请输入要发送给管家的内容，例如：bun run src/cli.ts ask test',
    )
  const config = loadConfig()
  const ledger = new TaskLedger(config.storage.databasePath)
  const agent = new ButlerAgent(config, ledger)
  const response = await agent.handle(text)
  console.log(response.reply)
}
