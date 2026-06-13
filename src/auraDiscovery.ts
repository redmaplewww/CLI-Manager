import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { ButlerConfig, ResolvedAuraLaunch } from './types'

const ENTRYPOINT = join('src', 'entrypoints', 'cli.tsx')
const DIST_NODE = join('dist', 'cli-node.js')

export function resolveAuraLaunch(
  config: ButlerConfig,
  configPath: string,
): ResolvedAuraLaunch {
  const explicit = tryExplicitLaunch(config)
  if (explicit) return explicit

  const roots = candidateRoots(config, configPath)
  for (const root of roots) {
    const devEntrypoint = join(root, ENTRYPOINT)
    if (existsSync(devEntrypoint)) {
      return {
        mode: 'dev',
        command: 'bun',
        args: ['run', ENTRYPOINT],
        cwd: root,
        source: `discovered:${devEntrypoint}`,
      }
    }

    const distEntrypoint = join(root, DIST_NODE)
    if (existsSync(distEntrypoint)) {
      return {
        mode: 'dist',
        command: 'node',
        args: [DIST_NODE],
        cwd: root,
        source: `discovered:${distEntrypoint}`,
      }
    }
  }

  if (config.aura.mode === 'global') {
    return {
      mode: 'global',
      command: config.aura.command ?? 'aura',
      args: config.aura.args ?? [],
      cwd: config.workspace.root,
      source: 'global',
    }
  }

  throw new Error(
    [
      'Unable to discover Aura CLI.',
      'Set AURA_CLI_ROOT to the CLI repository root, or configure aura.command/aura.args/aura.cwd.',
      `Searched roots: ${roots.join(', ')}`,
    ].join('\n'),
  )
}

export function discoverAuraRoots(
  config: ButlerConfig,
  configPath: string,
): string[] {
  return candidateRoots(config, configPath).filter(
    root =>
      existsSync(join(root, ENTRYPOINT)) || existsSync(join(root, DIST_NODE)),
  )
}

function tryExplicitLaunch(config: ButlerConfig): ResolvedAuraLaunch | null {
  if (!config.aura.command || !config.aura.args || !config.aura.cwd) return null
  const mode =
    config.aura.mode === 'auto' ? inferMode(config.aura.args) : config.aura.mode
  if (mode === 'auto') return null
  return {
    mode,
    command: config.aura.command,
    args: config.aura.args,
    cwd: config.aura.cwd,
    source: 'config',
  }
}

function inferMode(args: string[]): ResolvedAuraLaunch['mode'] | 'auto' {
  const joined = args.join(' ')
  if (
    joined.includes(ENTRYPOINT.replace(/\\/g, '/')) ||
    joined.includes('src/entrypoints/cli.tsx')
  )
    return 'dev'
  if (
    joined.includes(DIST_NODE.replace(/\\/g, '/')) ||
    joined.includes('dist/cli-node.js')
  )
    return 'dist'
  return 'auto'
}

function candidateRoots(config: ButlerConfig, configPath: string): string[] {
  const roots = new Set<string>()
  addMaybe(roots, process.env.AURA_CLI_ROOT)
  addMaybe(roots, process.env.CLI_SELF_ROOT)
  addMaybe(roots, process.env.OPENCODE_CLI_ROOT)
  addMaybe(roots, config.workspace.root)
  addMaybe(roots, config.aura.cwd)
  for (const root of config.aura.searchRoots ?? []) addMaybe(roots, root)

  const configDir = dirname(resolve(configPath))
  const baseDirs = new Set<string>()
  addMaybe(baseDirs, configDir)
  addMaybe(baseDirs, process.cwd())
  addMaybe(baseDirs, homedir())
  addMaybe(baseDirs, dirname(configDir))
  addMaybe(baseDirs, dirname(homedir()))
  addMaybe(baseDirs, '/opt')
  addMaybe(baseDirs, '/workspace')

  for (const base of baseDirs) {
    for (const name of likelyCliNames()) addMaybe(roots, resolve(base, name))
  }
  addMaybe(roots, process.cwd())

  for (const parent of parentDirs(configDir)) {
    for (const name of likelyCliNames()) addMaybe(roots, join(parent, name))
  }

  for (const root of [...roots]) {
    for (const child of likelyChildren(root)) addMaybe(roots, child)
  }

  return [...roots]
}

function parentDirs(start: string): string[] {
  const dirs: string[] = []
  let current = resolve(start)
  for (let i = 0; i < 4; i++) {
    const parent = dirname(current)
    if (parent === current) break
    dirs.push(parent)
    current = parent
  }
  return dirs
}

function likelyChildren(root: string): string[] {
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return []
    return readdirSync(root, { withFileTypes: true })
      .filter(
        entry =>
          entry.isDirectory() && /cli|aura|claude|opencode|codex|deploy/i.test(entry.name),
      )
      .slice(0, 80)
      .map(entry => join(root, entry.name))
  } catch {
    return []
  }
}

function likelyCliNames(): string[] {
  return [
    'CLI-self',
    'CLI-self-deploy-src',
    'cli-self',
    'cli-self-deploy-src',
    'opencode',
    'opencode-src',
    'claude-code-main',
    'claude-code',
    'aura-cli',
  ]
}

function addMaybe(set: Set<string>, value: string | undefined): void {
  if (!value) return
  set.add(resolve(value))
}
