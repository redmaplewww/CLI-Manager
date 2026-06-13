import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import type { ButlerConfig, ResolvedButlerConfig } from './types'
import { resolveAuraLaunch } from './auraDiscovery'

const DEFAULT_CONFIG_PATH = resolve('butler.config.json')

export function loadConfig(
  configPath = DEFAULT_CONFIG_PATH,
): ResolvedButlerConfig {
  loadLocalEnv(resolve(configPath))
  if (!existsSync(configPath))
    throw new Error(`Config file not found: ${configPath}`)

  const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as ButlerConfig
  validateConfig(parsed, configPath)
  const aura = resolveAuraLaunch(parsed, configPath)
  const resolved: ResolvedButlerConfig = {
    ...parsed,
    workspace: {
      ...parsed.workspace,
      root: resolvePath(parsed.workspace.root, configPath),
    },
    aura: { ...parsed.aura, ...aura },
    storage: {
      ...parsed.storage,
      dataDir: resolvePath(parsed.storage.dataDir, configPath),
      databasePath: resolvePath(parsed.storage.databasePath, configPath),
      logsDir: resolvePath(parsed.storage.logsDir, configPath),
      artifactsDir: resolvePath(parsed.storage.artifactsDir, configPath),
    },
  }
  ensureStorageDirs(resolved)
  return resolved
}

export function configFilePath(): string {
  return DEFAULT_CONFIG_PATH
}

export function loadRawConfig(configPath = DEFAULT_CONFIG_PATH): ButlerConfig {
  if (!existsSync(configPath))
    throw new Error(`Config file not found: ${configPath}`)
  return JSON.parse(readFileSync(configPath, 'utf-8')) as ButlerConfig
}

export function saveRawConfig(
  config: ButlerConfig,
  configPath = DEFAULT_CONFIG_PATH,
): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}

export function saveEnvValue(
  key: string,
  value: string,
  configPath = DEFAULT_CONFIG_PATH,
): void {
  const envPath = join(dirname(resolve(configPath)), '.env')
  const lines = existsSync(envPath)
    ? readFileSync(envPath, 'utf-8').split(/\r?\n/)
    : []
  let found = false
  const next = lines.map(line => {
    if (line.trim().startsWith(`${key}=`)) {
      found = true
      return `${key}=${JSON.stringify(value)}`
    }
    return line
  })
  if (!found) next.push(`${key}=${JSON.stringify(value)}`)
  writeFileSync(envPath, next.filter((line, i, arr) => line || i < arr.length - 1).join('\n') + '\n')
  process.env[key] = value
}

function resolvePath(value: string, configPath: string): string {
  if (isAbsolute(value)) return resolve(value)
  return resolve(dirname(resolve(configPath)), value)
}

function loadLocalEnv(configPath: string): void {
  const envPath = join(dirname(configPath), '.env')
  if (!existsSync(envPath)) return
  const lines = readFileSync(envPath, 'utf-8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

function validateConfig(config: ButlerConfig, configPath: string): void {
  const missing: string[] = []
  if (!config.workspace?.root) missing.push('workspace.root')
  if (!config.aura?.mode) missing.push('aura.mode')
  if (!config.storage?.databasePath) missing.push('storage.databasePath')
  if (!config.storage?.logsDir) missing.push('storage.logsDir')
  if (!config.storage?.artifactsDir) missing.push('storage.artifactsDir')
  if (missing.length > 0)
    throw new Error(
      `Invalid config ${configPath}; missing: ${missing.join(', ')}`,
    )
}

function ensureStorageDirs(config: ResolvedButlerConfig): void {
  mkdirSync(config.storage.dataDir, { recursive: true })
  mkdirSync(dirname(config.storage.databasePath), { recursive: true })
  mkdirSync(config.storage.logsDir, { recursive: true })
  mkdirSync(config.storage.artifactsDir, { recursive: true })
}
