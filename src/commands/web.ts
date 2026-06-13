import { startWebServer } from '../web/server'

export function webCommand(port?: string): void {
  startWebServer(port ? Number(port) : undefined)
}
