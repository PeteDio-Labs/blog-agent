/**
 * Drafts Routes
 * Proxies draft management through to the Blog API.
 * GET /api/v1/drafts — list pending drafts
 * POST /api/v1/drafts/:id/publish — approve and publish a draft
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import type { PipelineOrchestrator } from '../../services/pipeline.js';

const log = logger.child('drafts-route');

export function createDraftsRouter(pipeline: PipelineOrchestrator): Router {
  const router = Router();

  // List recent pipeline runs that produced drafts
  router.get('/', (_req: Request, res: Response) => {
    const runs = pipeline.getRecentRuns(50);
    const drafts = runs
      .filter(r => r.draft && r.blogPostId)
      .map(r => ({
        pipelineId: r.id,
        blogPostId: r.blogPostId,
        title: r.draft!.title,
        contentType: r.contentType,
        trigger: r.trigger,
        status: r.status,
        reviewScore: r.review?.score,
        revisionCount: r.revisionCount,
        createdAt: r.startedAt,
      }));

    res.json({ drafts, count: drafts.length });
  });

  // Publish a draft
  router.post('/:id/publish', async (req: Request<{ id: string }>, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    if (isNaN(postId)) {
      res.status(400).json({ error: 'Invalid post ID' });
      return;
    }

    try {
      await pipeline.publishDraft(postId);
      log.info(`Published post ${postId}`);
      res.json({ message: 'Post published', postId });
    } catch (err) {
      log.error(`Failed to publish post ${postId}`, err);
      res.status(500).json({
        error: 'Failed to publish',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
