# Aura Butler Linux Deploy

## Requirements

- Linux x86_64 or ARM64
- Bun 1.1+
- Optional: tmux for interactive mux windows
- Optional: OpenAI-compatible API key for planner/progress summaries

## Package

On Linux or WSL:

```bash
bash scripts/make-linux-package.sh
```

This creates `dist/aura-butler-linux.tar.gz` excluding `node_modules`, `data`, `.env`, and Windows `.cmd` helpers.

## One-command install after git clone

```bash
git clone https://github.com/redmaplewww/CLI-Manager.git
cd CLI-Manager
bash scripts/install-linux.sh
```

Optional environment variables:

```bash
BUTLER_WEB_PORT=8810 bash scripts/install-linux.sh
BUTLER_WORKSPACE=/data/workspace bash scripts/install-linux.sh
BUTLER_INSTALL_ONLY=1 bash scripts/install-linux.sh
```

The installer will install Bun if missing, create `butler.config.json`, install dependencies, start the daemon, and launch the web dashboard.

## Manual install

```bash
tar -xzf aura-butler-linux.tar.gz
cd aura-butler-linux
cp butler.config.example.linux.json butler.config.json
```

Edit `butler.config.json`:

- `workspace.root`: your working project directory
- `aura.searchRoots`: directories containing Aura/OpenCode/Claude/Codex checkouts or session stores
- `llm.baseUrl`, `llm.model`, `llm.apiKeyEnv`: your LLM provider

Set secrets in `.env` or the service environment:

```bash
OPENAI_API_KEY=...
```

## Run

```bash
bash scripts/linux-start.sh
```

Open:

```text
http://127.0.0.1:8800
```

## systemd

```bash
sudo cp scripts/linux-systemd.service.example /etc/systemd/system/aura-butler.service
sudo systemctl daemon-reload
sudo systemctl enable --now aura-butler
```

Adjust `WorkingDirectory` and `ExecStart` in the service file if not installed at `/opt/aura-butler`.

## Linux Notes

- Windows-specific `start-web-8799.cmd`, `data/`, and `.env` are excluded from the package.
- `windowsHide` spawn options are harmless in Bun/Node on Linux.
- `windows-terminal` mux engine is Windows-only; Linux will prefer `tmux`, then `detached`.
- Relative storage paths in config are resolved relative to `butler.config.json`.
- Do not copy `data/daemon.json` between machines; it contains stale local PID/port state.
