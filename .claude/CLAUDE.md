# blog-agent

Multi-agent LLM content engine for PeteDio Labs blog.

## Architecture

- **Runtime**: Bun + Express 5 + TypeScript
- **Port**: 3004
- **Validation**: Zod v4
- **Logging**: Pino (structured JSON in prod, pino-pretty in dev)
- **Metrics**: prom-client with custom Registry at `/metrics`
- **LLM**: Ollama via OpenAI-compatible `/v1/chat/completions` endpoint, model: `petedio-writer`

## Multi-Agent Pipeline

```
API/Event/Cron ──→ PipelineOrchestrator
                        │
                        ├──→ ContextAgent (gathers cluster data)
                        │       ├── MCBackendClient (ArgoCD, K8s)
                        │       └── NotificationServiceClient (recent events)
                        │
                        ├──→ WriterAgent (LLMProvider → markdown draft)
                        │
                        ├──→ ReviewAgent (LLMProvider → quality gate)
                        │       └── revision loop (max 2 rounds)
                        │
                        ├──→ BlogApiClient (save draft to Postgres)
                        │
                        └──→ NotificationServiceClient (Discord alert)
```

## API Routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/generate` | Trigger on-demand content generation |
| GET | `/api/v1/generate` | List recent pipeline runs |
| GET | `/api/v1/generate/:id` | Get pipeline run status |
| GET | `/api/v1/drafts` | List drafts from pipeline runs |
| POST | `/api/v1/drafts/:id/publish` | Publish a draft |
| GET | `/health` | Health + pipeline stats |
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe |
| GET | `/metrics` | Prometheus metrics |

## Content Types

| Type | Trigger | Style |
|------|---------|-------|
| `deploy-changelog` | Event-driven | Concise, technical, bullet-point |
| `weekly-recap` | Cron: Monday 12pm CST | Narrative summary |
| `how-to` | On-demand API | Detailed, step-by-step |
| `docs-audit` | On-demand / scheduled | Analytical drift report |
| `incident-postmortem` | Event-driven | Timeline → RCA → resolution |

## Project Structure

```
src/
├── index.ts              # Entry point
├── app.ts                # Express app factory
├── types.ts              # Zod schemas + TypeScript interfaces
├── agents/
│   ├── context.ts        # Context Agent (cluster data gathering)
│   ├── writer.ts         # Writer Agent (LLMProvider → markdown)
│   └── review.ts         # Review Agent (quality gate)
├── providers/
│   ├── llm.ts            # LLMProvider interface + LLMCompletionRequest
│   ├── index.ts          # createLLMProvider() factory
│   └── ollama.ts         # Ollama provider (OpenAI-compatible API)
├── services/
│   ├── pipeline.ts       # Pipeline Orchestrator
│   └── scheduler.ts      # Cron scheduler
├── clients/
│   ├── blogApi.ts        # Blog API admin client
│   ├── notificationService.ts  # Notification service client
│   └── mcBackend.ts      # Mission Control backend client
├── api/routes/
│   ├── index.ts          # Route mounting
│   ├── generate.ts       # Content generation endpoints
│   ├── drafts.ts         # Draft management endpoints
│   └── health.ts         # Health + metrics
├── metrics/
│   └── index.ts          # prom-client registry
└── utils/
    └── logger.ts         # Pino logger
```

## Conventions

- Matches notification-service / web-search-service patterns
- Routes use factory functions that receive dependencies (PipelineOrchestrator)
- Express v5 route params typed via `Request<{ id: string }>`
- Zod v4 for request validation
- Native fetch for all HTTP clients (no axios)
- LLM via Ollama `petedio-writer` model at `http://192.168.50.59:11434` — no external API keys needed
- `LLMProvider` interface allows swapping backends if needed in the future

## Ollama Model: petedio-writer

- **Modelfile**: `gitops/ansible/roles/ollama-models/files/petedio-writer.Modelfile`
- **Base model**: `qwen-tools` (same as pete-bot)
- **Parameters**: temperature 0.7, top_p 0.9, num_predict 4096
- **Deploy**: `ansible-playbook playbooks/ollama-models.yml` (or `-e ollama_force_recreate=true` to rebuild)
- **Status**: Ollama-only — no Claude API dependency, no external API keys

## Deployment

- **Docker**: `docker.toastedbytes.com/blog-agent:latest`
- **K8s namespace**: `blog-dev`
- **GitHub repo**: `PeteDio-Labs/blog-agent`
- **ArgoCD**: tracked via app-of-apps pattern
