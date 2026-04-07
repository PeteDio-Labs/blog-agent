/**
 * MC Dispatch Route — POST /run
 *
 * MC Backend POSTs a TaskPayload here to trigger the blog pipeline as a
 * managed agent task. The reporter sends status + result back to MC.
 * Completely separate from the existing /api/v1/generate REST route.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { AgentReporter } from '@petedio/shared/agents';
import { TaskPayloadSchema } from '@petedio/shared/agents';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import type { PipelineOrchestrator } from '../../services/pipeline.js';

const log = logger.child('mc-dispatch');

const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';

const BlogAgentInputSchema = z.object({
  contentType: z.enum(['deploy-changelog', 'weekly-recap', 'how-to', 'docs-audit', 'incident-postmortem'])
    .default('weekly-recap'),
  topic: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export function createMCDispatchRouter(pipeline: PipelineOrchestrator): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const parsed = TaskPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;
    const input = BlogAgentInputSchema.safeParse(payload.input);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid blog-agent input', details: input.error.flatten() });
      return;
    }

    // Acknowledge immediately — pipeline runs async
    res.json({ accepted: true, taskId: payload.taskId });

    const reporter = new AgentReporter({
      mcUrl: MC_BACKEND_URL,
      taskId: payload.taskId,
      agentName: 'blog-agent',
    });

    const { contentType, topic, context } = input.data;

    setImmediate(async () => {
      const startMs = Date.now();
      try {
        await reporter.running(`Generating ${contentType}${topic ? `: "${topic}"` : ''}...`);
        log.info(`MC-dispatched pipeline starting — taskId: ${payload.taskId}, contentType: ${contentType}${topic ? `, topic: "${topic}"` : ''}`);

        const run = await pipeline.run(contentType as Parameters<typeof pipeline.run>[0], 'api', topic, context ?? {}, (msg) => reporter.running(msg));

        const durationMs = Date.now() - startMs;

        if (run.status === 'failed') {
          await reporter.fail(run.error ?? 'Pipeline failed (unknown error)');
          return;
        }

        const draft = run.draft;
        const postId = run.blogPostId;

        await reporter.complete({
          taskId: payload.taskId,
          agentName: 'blog-agent',
          status: 'complete',
          summary: draft
            ? `"${draft.title}" saved as ${postId ? `post #${postId}` : 'draft'}`
            : `Pipeline completed (${contentType})`,
          artifacts: [
            ...(draft ? [{
              type: 'blog-draft' as const,
              label: draft.title,
              content: [
                `# ${draft.title}`,
                '',
                `**Tags:** ${draft.tags?.join(', ') ?? 'none'}`,
                `**Excerpt:** ${draft.excerpt}`,
                ...(postId ? [`**Post ID:** ${postId}`] : []),
                `**Review score:** ${run.review?.score ?? 'N/A'}`,
                '',
                '---',
                '',
                draft.content,
              ].join('\n'),
            }] : []),
            {
              type: 'log' as const,
              label: 'Pipeline stats',
              content: [
                `Duration: ${(durationMs / 1000).toFixed(1)}s`,
                `Revisions: ${run.revisionCount}`,
                `Review score: ${run.review?.score ?? 'N/A'}`,
                `Tokens: ${run.totalTokens.input + run.totalTokens.output} total`,
              ].join('\n'),
            },
          ],
          durationMs,
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`MC-dispatched pipeline error — taskId: ${payload.taskId}: ${msg}`);
        await reporter.fail(msg);
      }
    });
  });

  return router;
}
