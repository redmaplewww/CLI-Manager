import type { MuxEngine } from '../types'
import { createContext } from './context'
import { MuxManager } from '../muxManager'

export function muxCommand(
  subcommand = 'list',
  opts: Record<string, unknown> = {},
): void {
  const { config } = createContext()
  const mux = new MuxManager(config)
  switch (subcommand) {
    case 'engines': {
      for (const engine of mux.availableEngines()) {
        console.log(
          `${engine.engine.padEnd(16)} ${engine.available ? 'available' : 'missing'}  ${engine.note}`,
        )
      }
      return
    }
    case 'start': {
      const startOptions: {
        name?: string
        engine?: MuxEngine
        prompt?: string
        interactive?: boolean
      } = { interactive: opts.print ? false : true }
      if (typeof opts.name === 'string') startOptions.name = opts.name
      if (typeof opts.engine === 'string')
        startOptions.engine = opts.engine as MuxEngine
      if (typeof opts.prompt === 'string') startOptions.prompt = opts.prompt
      const record = mux.start(startOptions)
      console.log(`Mux session started: ${record.name}`)
      console.log(`  Engine: ${record.engine}`)
      console.log(`  Command: ${record.command}`)
      if (record.tmuxSession)
        console.log(`  Attach: bun run src/cli.ts mux attach ${record.name}`)
      if (record.logPath) console.log(`  Log: ${record.logPath}`)
      return
    }
    case 'list': {
      const sessions = mux.list()
      if (sessions.length === 0) {
        console.log('No mux sessions.')
        return
      }
      for (const s of sessions) {
        console.log(
          `${s.name.padEnd(24)} ${s.engine.padEnd(16)} ${s.status.padEnd(10)} ${s.cwd}`,
        )
      }
      return
    }
    case 'attach': {
      const target = typeof opts.target === 'string' ? opts.target : undefined
      if (!target) throw new Error('Usage: butler mux attach --target <name>')
      mux.attach(target)
      return
    }
    case 'stop': {
      const target = typeof opts.target === 'string' ? opts.target : undefined
      if (!target) throw new Error('Usage: butler mux stop --target <name>')
      mux.stop(target)
      console.log(`Stopped mux session: ${target}`)
      return
    }
    default:
      throw new Error(`Unknown mux subcommand: ${subcommand}`)
  }
}
