#!/usr/bin/env bun
import { Command } from 'commander'
import { addCommand } from './commands/add'
import { answerCommand } from './commands/answer'
import { eventsCommand } from './commands/events'
import { inspectCommand } from './commands/inspect'
import { logsCommand } from './commands/logs'
import { resultCommand } from './commands/result'
import { retryCommand } from './commands/retry'
import { statusCommand } from './commands/status'
import { stopCommand } from './commands/stop'
import { workersCommand } from './commands/workers'
import { daemonCommand } from './commands/daemon'
import { muxCommand } from './commands/mux'
import { chatCommand } from './commands/chat'
import { dashboardCommand } from './commands/dashboard'
import { projectCommand } from './commands/project'
import { askCommand } from './commands/ask'
import { webCommand } from './commands/web'
import { sessionsCommand } from './commands/sessions'

const program = new Command()

program
  .name('butler')
  .description('External Aura CLI task manager')
  .version('0.1.0')
program
  .command('daemon')
  .argument('[subcommand]', 'start|stop|status|run', 'status')
  .description('Manage the persistent Butler daemon')
  .action(daemonCommand)
program
  .command('chat')
  .description('Talk to the AI Butler manager')
  .action(chatCommand)
program
  .command('ask')
  .argument('<input...>')
  .description('Send one message to the Butler agent and print the reply')
  .action(askCommand)
program
  .command('dashboard')
  .alias('ui')
  .description('Open the unified Butler management window')
  .action(dashboardCommand)
program
  .command('web')
  .option('--port <port>', 'web dashboard port')
  .description('Start the browser-based Butler dashboard')
  .action((opts: { port?: string }) => webCommand(opts.port))
program
  .command('project')
  .argument('[subcommand]', 'list|status|result', 'list')
  .argument('[projectId]')
  .description('查看自主项目状态和结果')
  .action(projectCommand)
program
  .command('sessions')
  .argument('[subcommand]', 'list|import', 'list')
  .description('扫描并导入已有 Aura CLI sessions')
  .action(sessionsCommand)
program
  .command('mux')
  .argument('[subcommand]', 'engines|start|list|attach|stop', 'list')
  .option('--name <name>', 'session name')
  .option('--engine <engine>', 'tmux|windows-terminal|detached')
  .option('--prompt <prompt>', 'run a headless prompt in the mux session')
  .option(
    '--print',
    'start as print/headless session instead of interactive REPL',
  )
  .option('--target <target>', 'session target for attach/stop')
  .description('Manage multiple interactive Aura CLI windows')
  .action(muxCommand)
program
  .command('inspect')
  .description('Validate Butler and Aura launch config')
  .action(inspectCommand)
program
  .command('add')
  .argument('<prompt...>')
  .description('Create and start a task')
  .action((parts: string[]) => addCommand(parts.join(' ')))
program.command('status').description('List tasks').action(statusCommand)
program
  .command('logs')
  .argument('<taskId>')
  .description('Show task stdout log')
  .action(logsCommand)
program
  .command('events')
  .argument('<taskId>')
  .description('Show parsed task events')
  .action(eventsCommand)
program
  .command('result')
  .argument('<taskId>')
  .description('Show task result')
  .action(resultCommand)
program
  .command('answer')
  .argument('<taskId>')
  .argument('<answer...>')
  .description('Answer a waiting task in this process')
  .action((taskId: string, parts: string[]) =>
    answerCommand(taskId, parts.join(' ')),
  )
program
  .command('stop')
  .argument('<taskId>')
  .description('Stop a task')
  .action(stopCommand)
program
  .command('retry')
  .argument('<taskId>')
  .option('--resume', 'resume Aura session')
  .description('Retry a task')
  .action(retryCommand)
program
  .command('workers')
  .description('List latest worker attempts')
  .action(workersCommand)

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
