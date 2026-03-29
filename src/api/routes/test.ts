/**
 * Test Routes
 * Smoke test for LLM round-trip — skips Blog API and notification-service.
 * GET  /api/v1/test/ollama  — check Ollama connectivity + model availability
 * POST /api/v1/test/write   — run Writer Agent with mock context, return draft
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import type { LLMProvider } from '../../providers/llm.js';
import { OllamaProvider } from '../../providers/ollama.js';
import { WriterAgent } from '../../agents/writer.js';
import type { ContextAgentOutput } from '../../types.js';

const log = logger.child('test-route');

const MOCK_CONTEXT: ContextAgentOutput = {
  contentType: 'deploy-changelog',
  triggerFacts: [
    { id: 'test-1', source: 'kubernetes', type: 'deployment', severity: 'info', message: 'blog-agent deployed to blog-dev namespace', timestamp: new Date().toISOString(), processed: false },
  ],
  cluster: {
    argocdApps: [
      { name: 'blog-dev', namespace: 'blog-dev', status: 'Synced', health: 'Healthy', syncedAt: new Date().toISOString() },
      { name: 'mission-control-dev', namespace: 'mission-control', status: 'Synced', health: 'Healthy', syncedAt: new Date().toISOString() },
    ],
    recentEvents: [
      { id: 'test-1', source: 'kubernetes', type: 'deployment', severity: 'info', message: 'blog-agent deployed to blog-dev namespace', timestamp: new Date().toISOString(), processed: false },
    ],
    recentDeploys: [
      { service: 'blog-agent', namespace: 'blog-dev', image: 'docker.toastedbytes.com/blog-agent:latest', timestamp: new Date().toISOString() },
    ],
    clusterHealth: { nodes: 2, podsRunning: 24, podsNotReady: 0 },
    timestamp: new Date().toISOString(),
  },
  additionalContext: { test: true },
  historicalContext: [],
  gatheredAt: new Date().toISOString(),
};

export function createTestRouter(llmProvider: LLMProvider): Router {
  const router = Router();

  // Check Ollama connectivity and model availability
  router.get('/ollama', async (_req: Request, res: Response) => {
    if (!(llmProvider instanceof OllamaProvider)) {
      res.json({ provider: llmProvider.name, ollama: false, message: 'Not using Ollama provider' });
      return;
    }

    const available = await llmProvider.isAvailable();
    res.json({
      provider: llmProvider.name,
      ollama: true,
      modelAvailable: available,
      message: available ? 'Ollama is reachable and model is loaded' : 'Ollama unreachable or model not found — run: ansible-playbook playbooks/ollama-models.yml',
    });
  });

  // Smoke test: Writer Agent with mock context
  router.post('/write', async (req: Request, res: Response) => {
    const topic = (req.body as { topic?: string } | undefined)?.topic ?? 'blog-agent first deploy';
    const contentType = 'deploy-changelog';

    log.info(`Test write — topic: "${topic}"`);

    const context: ContextAgentOutput = {
      ...MOCK_CONTEXT,
      contentType,
    };

    try {
      const writer = new WriterAgent(llmProvider);
      const start = Date.now();
      const result = await writer.write(context, topic);
      const durationSec = (Date.now() - start) / 1000;

      res.json({
        success: true,
        durationSeconds: durationSec,
        provider: llmProvider.name,
        tokensUsed: result.tokensUsed,
        draft: {
          title: result.draft.title,
          slug: result.draft.slug,
          excerpt: result.draft.excerpt,
          tags: result.draft.tags,
          contentLength: result.draft.content.length,
          contentPreview: result.draft.content.slice(0, 500),
        },
      });
    } catch (err) {
      log.error('Test write failed', err);
      res.status(500).json({
        success: false,
        provider: llmProvider.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
