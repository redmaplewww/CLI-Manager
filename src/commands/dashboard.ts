import blessed from 'blessed'
import { existsSync, readFileSync } from 'fs'
import { loadConfig } from '../config'
import { TaskLedger } from '../db'
import { ProjectStore } from '../projectStore'
import { daemonCommand } from './daemon'
import { ButlerAgent } from '../butlerAgent'
import {
  formatEventList,
  formatProjectList,
  formatTaskList,
  formatWorker,
} from '../ui/formatter'
import { safeLines, safeText } from '../ui/safeText'

const asciiUi =
  process.env.BUTLER_ASCII === '1' ||
  (process.platform === 'win32' && process.env.BUTLER_UNICODE !== '1')
const borderStyle = (
  asciiUi ? { type: 'line' as const, ch: '+' } : 'line'
) as blessed.Widgets.BoxOptions['border']

export async function dashboardCommand(): Promise<void> {
  await daemonCommand('start')
  const config = loadConfig()
  const ledger = new TaskLedger(config.storage.databasePath)
  const projectStore = new ProjectStore(config)
  const agent = new ButlerAgent(config, ledger)

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: !asciiUi,
    title: 'Aura Butler Dashboard',
  })
  const chat = blessed.log({
    parent: screen,
    label: safeText(
      ` 对话 ${agent.llmEnabled() ? '[LLM]' : '[规则]'} `,
      asciiUi,
    ),
    top: 0,
    left: 0,
    width: '50%',
    height: '55%',
    border: borderStyle,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: ' ',
      track: { bg: 'black' },
      style: { inverse: true },
    },
    keys: true,
    vi: true,
    mouse: true,
  })
  const tasks = blessed.box({
    parent: screen,
    label: safeText(' 任务分配 ', asciiUi),
    top: 0,
    left: '50%',
    width: '50%',
    height: '35%',
    border: borderStyle,
    scrollable: true,
    keys: true,
    vi: true,
  })
  const projects = blessed.box({
    parent: screen,
    label: safeText(' 自主项目 ', asciiUi),
    top: '35%',
    left: '50%',
    width: '50%',
    height: '20%',
    border: borderStyle,
    scrollable: true,
    keys: true,
    vi: true,
  })
  const logs = blessed.box({
    parent: screen,
    label: safeText(' CLI 工作过程 ', asciiUi),
    top: '55%',
    left: 0,
    width: '100%',
    height: '35%',
    border: borderStyle,
    scrollable: true,
    keys: true,
    vi: true,
  })
  const input = blessed.textbox({
    parent: screen,
    label: safeText(' 输入给管家 ', asciiUi),
    bottom: 0,
    left: 0,
    width: '100%',
    height: '10%',
    border: borderStyle,
    inputOnFocus: true,
    keys: true,
    mouse: true,
  })

  const focusInput = () => {
    input.focus()
    input.readInput()
    screen.render()
  }

  const say = (message: string) => chat.log(safeText(message, asciiUi))

  say('Aura Butler 统一管理窗口已启动。')
  say(
    asciiUi
      ? 'Type goals here. Examples: own whole project / current progress / show T001 result'
      : 'Type goals here. Examples: 负责当前项目全流程 / 现在进度 / 看 T001 结果',
  )
  say(
    asciiUi
      ? 'Input: type message, press Enter. Chat scroll: PgUp/PgDn or Ctrl+Up/Ctrl+Down. Keys: Ctrl+C or Esc exit.\n'
      : '输入方式：直接输入消息后按 Enter。对话滚动：PgUp/PgDn 或 Ctrl+上/下。快捷键：Ctrl+C 或 Esc 退出。\n',
  )

  const refresh = () => {
    const allTasks = ledger.listTasks()
    tasks.setContent(safeLines(formatTaskList(allTasks), asciiUi))

    projects.setContent(
      safeLines(formatProjectList(projectStore.list()), asciiUi),
    )

    const latest = allTasks.at(-1)
    if (latest) {
      const events = formatEventList(ledger.listEvents(latest.id, 25))
      const worker = ledger.getLatestWorker(latest.id)
      let tail = ''
      if (worker?.stderrPath && existsSync(worker.stderrPath))
        tail = readFileSync(worker.stderrPath, 'utf-8').slice(-2000)
      logs.setContent(
        safeLines(
          `当前观察任务：${latest.id}\n\n${formatWorker(worker)}\n\n事件摘要：\n${events}\n\n错误输出尾部：\n${tail || '无'}`,
          asciiUi,
        ),
      )
    } else {
      logs.setContent(safeText('暂无 CLI worker 日志。', asciiUi))
    }
    screen.render()
  }

  input.on('submit', async value => {
    const text = String(value).trim()
    input.clearValue()
    focusInput()
    if (!text) return
    say(`${asciiUi ? 'You' : '你'}: ${text}`)
    say(asciiUi ? 'Butler is thinking...' : '管家正在思考...')
    try {
      const response = await agent.handle(text, {
        language: asciiUi ? 'en' : 'zh',
      })
      if (response.reply === '__exit__') process.exit(0)
      say(response.reply)
    } catch (err) {
      say(
        `${asciiUi ? 'Error' : '错误'}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    refresh()
  })

  input.key('enter', () => {
    input.submit()
  })

  screen.key(['i', '/'], () => {
    focusInput()
  })

  screen.key(['pageup', 'C-up'], () => {
    chat.scroll(-Math.max(3, Math.floor(Number(chat.height) / 2) || 10))
    screen.render()
  })

  screen.key(['pagedown', 'C-down'], () => {
    chat.scroll(Math.max(3, Math.floor(Number(chat.height) / 2) || 10))
    screen.render()
  })

  screen.key(['home'], () => {
    chat.setScrollPerc(0)
    screen.render()
  })

  screen.key(['end'], () => {
    chat.setScrollPerc(100)
    screen.render()
  })

  screen.key(['escape', 'C-c'], () => process.exit(0))
  screen.on('keypress', (ch, key) => {
    if (!ch || key?.name || screen.focused === input) return
    focusInput()
    input.setValue(`${input.getValue()}${ch}`)
    screen.render()
  })
  setInterval(refresh, 3000)
  refresh()
  focusInput()
}
