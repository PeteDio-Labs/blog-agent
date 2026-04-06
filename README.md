# Blog Agent

Multi-agent LLM content pipeline for PeteDio Labs blog. Orchestrates context gathering, writing, and review agents to generate portfolio-quality posts and publish them via the Blog API.

## Quick Start

```bash
bun install
cp .env.example .env  # configure BLOG_API_URL, OLLAMA_HOST, etc.
bun dev               # http://localhost:3004
```

## Scripts

```bash
bun dev          # dev server (port 3004, hot reload)
bun build        # production build
bun start        # run production build
bun test         # run tests
bun run typecheck
```

## Stack

- **Runtime:** Bun
- **Framework:** Express 5, TypeScript
- **AI:** Ollama (multi-agent tool-calling loop)
- **Logging:** Pino
- **Metrics:** prom-client (Prometheus)

## Architecture

```
Trigger (schedule / webhook / manual)
    │
    └──→ PipelineOrchestrator
              │
              ├──→ ContextAgent   (gathers homelab context from MC Backend)
              ├──→ WriterAgent    (drafts post via Ollama)
              └──→ ReviewAgent    (refines + scores content)
                        │
                        └──→ BlogApiClient → Blog API (publish)
                        └──→ NotificationServiceClient → Discord alert
```

## Agents

| Agent | Role |
|-------|------|
| `ContextAgent` | Pulls recent infra events, project status, K8s activity from MC Backend |
| `WriterAgent` | Generates post draft using Ollama LLM with structured prompts |
| `ReviewAgent` | Reviews draft for quality, technical accuracy, and portfolio value |

## Services

| Service | Role |
|---------|------|
| `PipelineOrchestrator` | Coordinates the agent pipeline end-to-end |
| `Scheduler` | Cron-based pipeline triggers |
| `EventListener` | Listens for real-time infra events to trigger reactive posts |

## API

- `POST /api/v1/pipeline/trigger` — Trigger a content pipeline run
- `GET /api/v1/pipeline/status` — Pipeline run status
- `GET /health` — Health check
- `GET /metrics` — Prometheus metrics

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3004` | Server port |
| `BLOG_API_URL` | `http://blog-api.blog-dev.svc.cluster.local:8080` | Blog API endpoint |
| `MC_BACKEND_URL` | `http://mission-control-backend.mission-control.svc.cluster.local:3000` | MC Backend endpoint |
| `NOTIFICATION_SERVICE_URL` | `http://notification-service.mission-control.svc.cluster.local:3002` | Notification service |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `petedio-writer` | Ollama model |

## Deployment

Pushed to `docker.toastedbytes.com/blog-agent` via GitHub Actions on push to `main`. ArgoCD Image Updater handles digest pinning. K8s manifests live in `infrastructure/kubernetes/blog`. Deployed in `blog-dev` namespace.
