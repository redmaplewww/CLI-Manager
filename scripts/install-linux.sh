#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${BUTLER_WEB_PORT:-8800}"
WORKSPACE="${BUTLER_WORKSPACE:-$HOME/butler-workspace}"
CONFIG="$ROOT/butler.config.json"

info() { printf '\033[1;34m[butler]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[butler]\033[0m %s\n' "$*"; }

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    info "Bun found: $(bun --version)"
    return
  fi
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun install finished but bun is not on PATH. Run: source ~/.bashrc" >&2
    exit 1
  fi
}

write_config() {
  if [ -f "$CONFIG" ]; then
    info "Using existing butler.config.json"
    return
  fi
  info "Creating butler.config.json"
  mkdir -p "$WORKSPACE"
  cat > "$CONFIG" <<EOF
{
  "workspace": {
    "name": "workspace",
    "root": "$WORKSPACE"
  },
  "aura": {
    "mode": "auto",
    "searchRoots": ["$WORKSPACE", "$HOME", "$HOME/CLI-self-deploy-src", "$HOME/CLI-self", "/opt", "/workspace"]
  },
  "execution": {
    "maxParallelTasks": 3,
    "taskTimeoutMinutes": 60,
    "stuckAfterMinutes": 10,
    "useStdinForPrompt": false,
    "outputFormat": "stream-json",
    "verbose": true,
    "terminateGraceSeconds": 10,
    "schedulerIntervalSeconds": 5,
    "watchdogIntervalSeconds": 300,
    "progressReportIntervalSeconds": 900
  },
  "retry": {
    "maxRetries": 2,
    "resumeOnRetry": true
  },
  "llm": {
    "enabled": false,
    "provider": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4o-mini",
    "timeoutMs": 20000
  },
  "storage": {
    "dataDir": "./data",
    "databasePath": "./data/butler.sqlite",
    "logsDir": "./data/logs",
    "artifactsDir": "./data/artifacts"
  }
}
EOF
}

install_dependencies() {
  info "Installing dependencies..."
  if [ -f bun.lock ]; then
    bun install --frozen-lockfile || bun install
  else
    bun install
  fi
}

start_services() {
  info "Starting daemon..."
  bun run src/cli.ts daemon stop >/dev/null 2>&1 || true
  bun run src/cli.ts daemon start
  info "Starting web dashboard on port $PORT..."
  info "Open: http://127.0.0.1:$PORT"
  exec bun run src/cli.ts web --port "$PORT"
}

install_bun
write_config
install_dependencies

if [ "${BUTLER_INSTALL_ONLY:-0}" = "1" ]; then
  info "Install complete. Start with: bun run src/cli.ts web --port $PORT"
  exit 0
fi

warn "LLM planner is disabled by default. To enable it, edit butler.config.json and export OPENAI_API_KEY."
start_services
