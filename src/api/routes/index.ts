/**
 * Route index
 * Mounts all API routers in one place so app.ts stays free of routing logic.
 */

import { Router } from 'express';
import { createGenerateRouter } from './generate.js';
import { createDraftsRouter } from './drafts.js';
import { createHealthRouter } from './health.js';
import { createTestRouter } from './test.js';
import { createMCDispatchRouter } from './mcDispatch.js';
import type { PipelineOrchestrator } from '../../services/pipeline.js';
import type { LLMProvider } from '../../providers/llm.js';

export function createRoutes(pipeline: PipelineOrchestrator, llmProvider: LLMProvider): Router {
  const routes = Router();

  // Health and metrics (no version prefix)
  routes.use(createHealthRouter(pipeline));

  // MC Backend dispatch endpoint — TaskPayload in, AgentResult reported back
  routes.use('/run', createMCDispatchRouter(pipeline));

  // Versioned API routes
  const apiV1 = Router();
  apiV1.use('/generate', createGenerateRouter(pipeline));
  apiV1.use('/drafts', createDraftsRouter(pipeline));
  apiV1.use('/test', createTestRouter(llmProvider));

  routes.use('/api/v1', apiV1);

  return routes;
}
