/**
 * Health and Metrics Routes
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMetrics } from '../../metrics/index.js';
import type { PipelineOrchestrator } from '../../services/pipeline.js';

export function createHealthRouter(pipeline: PipelineOrchestrator): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    const stats = pipeline.getStats();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      stats,
    });
  });

  router.get('/health/live', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  router.get('/health/ready', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  router.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', 'text/plain');
    res.send(await getMetrics());
  });

  return router;
}
