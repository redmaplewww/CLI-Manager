import { createContext } from './context'
import { ProjectStore } from '../projectStore'
import { formatProjectList, formatTaskList } from '../ui/formatter'
import type { TaskRecord } from '../types'

export function projectCommand(subcommand = 'list', projectId?: string): void {
  const { config, ledger } = createContext()
  const store = new ProjectStore(config)
  switch (subcommand) {
    case 'list':
      console.log(formatProjectList(store.list()))
      return
    case 'status':
    case 'result': {
      if (!projectId)
        throw new Error('请提供项目编号，例如：butler project status Pxxxx')
      const project = store.get(projectId)
      if (!project) throw new Error(`未找到项目：${projectId}`)
      console.log(formatProjectList([project]))
      const tasks = project.taskIds
        .map(id => ledger.getTask(id))
        .filter((task): task is TaskRecord => Boolean(task))
      console.log('\n关联任务：')
      console.log(formatTaskList(tasks))
      if (subcommand === 'result') {
        console.log('\n最终汇报：')
        console.log(
          project.finalSummary ??
            project.lastNotification ??
            project.errorMessage ??
            '暂无最终汇报。',
        )
      }
      return
    }
    default:
      throw new Error(`未知 project 子命令：${subcommand}`)
  }
}
