import { Registry, Counter, Gauge, Histogram } from 'prom-client';

export const register = new Registry();

// Application health
export const appUp = new Gauge({
  name: 'blog_agent_up',
  help: '1=service running, 0=offline',
  registers: [register],
});

// Pipeline execution metrics
export const pipelineRunsTotal = new Counter({
  name: 'blog_agent_pipeline_runs_total',
  help: 'Total pipeline executions',
  labelNames: ['content_type', 'trigger', 'status'],
  registers: [register],
});

export const pipelineDuration = new Histogram({
  name: 'blog_agent_pipeline_duration_seconds',
  help: 'End-to-end pipeline duration in seconds',
  labelNames: ['content_type', 'trigger'],
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

// Agent-level metrics
export const agentCallsTotal = new Counter({
  name: 'blog_agent_agent_calls_total',
  help: 'Total LLM agent invocations',
  labelNames: ['agent', 'status'],
  registers: [register],
});

export const agentDuration = new Histogram({
  name: 'blog_agent_agent_duration_seconds',
  help: 'Individual agent call duration in seconds',
  labelNames: ['agent'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

// LLM token usage
export const llmTokensUsed = new Counter({
  name: 'blog_agent_llm_tokens_total',
  help: 'Total LLM tokens consumed',
  labelNames: ['agent', 'direction'],
  registers: [register],
});

// Draft metrics
export const draftsCreatedTotal = new Counter({
  name: 'blog_agent_drafts_created_total',
  help: 'Total drafts saved to blog API',
  labelNames: ['content_type'],
  registers: [register],
});

// Review loop metrics
export const reviewRevisionsTotal = new Counter({
  name: 'blog_agent_review_revisions_total',
  help: 'Total revision rounds triggered by Review Agent',
  registers: [register],
});

// API endpoint metrics
export const apiRequestsTotal = new Counter({
  name: 'blog_agent_api_requests_total',
  help: 'Total HTTP API requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

export const apiRequestDuration = new Histogram({
  name: 'blog_agent_api_request_duration_seconds',
  help: 'HTTP API request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// SSE event listener metrics
export const sseEventsReceived = new Counter({
  name: 'blog_agent_sse_events_received_total',
  help: 'Total SSE events received from MC Backend',
  labelNames: ['source', 'type'],
  registers: [register],
});

export const sseConnected = new Gauge({
  name: 'blog_agent_sse_connected',
  help: '1=connected to SSE stream, 0=disconnected',
  registers: [register],
});

export const sseTriggeredPipelines = new Counter({
  name: 'blog_agent_sse_triggered_pipelines_total',
  help: 'Total pipeline runs triggered by SSE deploy events',
  registers: [register],
});

export async function getMetrics(): Promise<string> {
  return register.metrics();
}

export function resetMetrics(): void {
  register.resetMetrics();
}
