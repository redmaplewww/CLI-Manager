import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { loadConfig } from '../config'
import { discoverAuraRoots } from '../auraDiscovery'

export function inspectCommand(): void {
  const config = loadConfig()
  console.log(`Config: ok`)
  console.log(
    `Workspace: ${config.workspace.root} ${existsSync(config.workspace.root) ? 'ok' : 'missing'}`,
  )
  console.log(
    `Aura launch: ${config.aura.command} ${config.aura.args.join(' ')}`,
  )
  console.log(`Aura cwd: ${config.aura.cwd}`)
  console.log(`Aura source: ${config.aura.source}`)
  const roots = discoverAuraRoots(config, 'butler.config.json')
  console.log(`Discovered roots: ${roots.length ? roots.join(', ') : 'none'}`)
  const version = spawnSync(
    config.aura.command,
    [...config.aura.args, '--version'],
    { cwd: config.aura.cwd, encoding: 'utf-8' },
  )
  console.log(`Aura version exit: ${version.status}`)
  if (version.stdout.trim()) console.log(version.stdout.trim())
  if (version.stderr.trim()) console.error(version.stderr.trim())
}
