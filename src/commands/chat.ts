import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import { daemonCommand } from './daemon'
import { createContext } from './context'
import { ProjectStore } from '../projectStore'
import { ButlerAgent } from '../butlerAgent'

export async function chatCommand(): Promise<void> {
  console.log('Aura Butler AI 管家已启动。你可以直接说：')
  console.log('  帮我检查当前项目的测试命令')
  console.log('  现在进度')
  console.log('  看 T001 结果')
  console.log('  开一个 CLI 窗口 name worker-a')
  console.log('输入 exit 退出。\n')

  await daemonCommand('start')

  const { config, ledger } = createContext()
  const agent = new ButlerAgent(config, ledger)
  const projectStore = new ProjectStore(config)
  const notifiedProjects = new Set(
    projectStore
      .list()
      .filter(p => p.lastNotificationAt)
      .map(p => `${p.id}:${p.lastNotificationAt}`),
  )
  console.log(
    `LLM planner: ${agent.llmEnabled() ? 'enabled' : 'disabled, using rule fallback'}\n`,
  )
  const notificationTimer = setInterval(() => {
    void pushProjectNotifications(projectStore, notifiedProjects)
  }, 5000)
  const rl = createInterface({ input, output })
  try {
    while (true) {
      await pushProjectNotifications(projectStore, notifiedProjects)
      const line = await rl.question('butler> ')
      const response = await agent.handle(line)
      if (response.reply === '__exit__') break
      console.log(response.reply)
      await pushProjectNotifications(projectStore, notifiedProjects)
    }
  } finally {
    clearInterval(notificationTimer)
    rl.close()
  }
}

async function pushProjectNotifications(
  projectStore: ProjectStore,
  notified: Set<string>,
): Promise<void> {
  for (const project of projectStore.list()) {
    if (!project.lastNotification || !project.lastNotificationAt) continue
    const key = `${project.id}:${project.lastNotificationAt}`
    if (notified.has(key)) continue
    notified.add(key)
    console.log(
      `\n项目 ${project.id} 已${project.status === 'completed' ? '完成' : '结束'}：`,
    )
    console.log(project.lastNotification)
  }
}
