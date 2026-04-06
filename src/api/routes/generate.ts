/**
 * Generate Routes
 * POST /api/v1/generate — trigger on-demand content generation
 * GET /api/v1/generate/:id — get pipeline run status
 * GET /api/v1/generate — list recent pipeline runs
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { GenerateRequestSchema } from '../../types.js';
import { logger } from '../../utils/logger.js';
import type { PipelineOrchestrator } from '../../services/pipeline.js';

const log = logger.child('generate-route');

export function createGenerateRouter(pipeline: PipelineOrchestrator): Router {
  const router = Router();

  // Trigger content generation
  router.post('/', async (req: Request, res: Response) => {
    const parsed = GenerateRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.issues,
      });
      return;
    }

    const { contentType, topic, context } = parsed.data;
    log.info(`Generate request: ${contentType}${topic ? ` — "${topic}"` : ''}`);

    // Run pipeline async — return immediately with run ID
    const runPromise = pipeline.runWithReporting(contentType, 'api', topic, context);

    // Wait a short moment to see if it fails immediately
    const run = await Promise.race([
      runPromise,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
    ]);

    if (run) {
      // Pipeline completed (or failed) quickly
      res.status(run.status === 'failed' ? 500 : 201).json(run);
    } else {
      // Pipeline is still running — return 202 Accepted
      res.status(202).json({
        message: 'Pipeline started — content generation in progress',
        hint: 'Poll GET /api/v1/generate to check status',
      });
    }
  });

  // List recent pipeline runs
  router.get('/', (_req: Request, res: Response) => {
    const runs = pipeline.getRecentRuns();
    res.json({ runs, count: runs.length });
  });

  // Get specific pipeline run
  router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
    const run = pipeline.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Pipeline run not found' });
      return;
    }
    res.json(run);
  });

  return router;
}
