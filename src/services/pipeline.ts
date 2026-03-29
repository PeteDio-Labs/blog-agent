/**
 * Pipeline Orchestrator
 * Chains Context Agent → Writer Agent → Review Agent with revision loop.
 * Manages pipeline runs, saves drafts to Blog API, notifies via notification-service.
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import {
  pipelineRunsTotal,
  pipelineDuration,
  draftsCreatedTotal,
  reviewRevisionsTotal,
} from '../metrics/index.js';
import { ContextAgent } from '../agents/context.js';
import { WriterAgent } from '../agents/writer.js';
import { ReviewAgent } from '../agents/review.js';
import { BlogApiClient } from '../clients/blogApi.js';
import { NotificationServiceClient } from '../clients/notificationService.js';
import type {
  ContentType,
  TriggerType,
  PipelineRun,
  BlogDraft,
} from '../types.js';

const log = logger.child('pipeline');

const MAX_REVISIONS = 2;

export class PipelineOrchestrator {
  private runs: Map<string, PipelineRun> = new Map();

  constructor(
    private contextAgent: ContextAgent,
    private writerAgent: WriterAgent,
    private reviewAgent: ReviewAgent,
    private blogApi: BlogApiClient,
    private notifications: NotificationServiceClient,
    private blogUrl: string,
  ) {}

  async run(
    contentType: ContentType,
    trigger: TriggerType,
    topic?: string,
    additionalContext: Record<string, unknown> = {},
  ): Promise<PipelineRun> {
    const id = randomUUID();
    const run: PipelineRun = {
      id,
      contentType,
      trigger,
      status: 'running',
      revisionCount: 0,
      startedAt: new Date().toISOString(),
      totalTokens: { input: 0, output: 0 },
    };

    this.runs.set(id, run);
    log.info(`Pipeline ${id} started — ${contentType} (${trigger})`);

    try {
      // Pre-flight: verify blog-api is reachable before starting expensive LLM work
      const apiHealthy = await this.blogApi.healthCheck();
      if (!apiHealthy) {
        throw new Error('Blog API is unreachable — aborting pipeline to avoid wasting LLM tokens');
      }
      log.info('Pre-flight check passed — blog-api is reachable');

      // Phase 1: Context
      const context = await this.contextAgent.gather(contentType, additionalContext);

      // Phase 2: Write
      let writerOutput = await this.writerAgent.write(context, topic);
      run.totalTokens.input += writerOutput.tokensUsed.input;
      run.totalTokens.output += writerOutput.tokensUsed.output;

      let currentDraft: BlogDraft = writerOutput.draft;

      // Phase 3: Review + revision loop
      for (let i = 0; i <= MAX_REVISIONS; i++) {
        const reviewOutput = await this.reviewAgent.review(currentDraft, context);
        run.totalTokens.input += reviewOutput.tokensUsed.input;
        run.totalTokens.output += reviewOutput.tokensUsed.output;
        run.review = reviewOutput.result;

        if (reviewOutput.result.approved) {
          log.info(`Draft approved on ${i === 0 ? 'first pass' : `revision ${i}`} — score: ${reviewOutput.result.score}`);
          break;
        }

        if (i < MAX_REVISIONS) {
          // Build feedback string for writer
          const feedback = reviewOutput.result.feedback
            .map(f => `[${f.severity}] ${f.category}: ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ''}`)
            .join('\n');

          log.info(`Revision ${i + 1}/${MAX_REVISIONS} — score: ${reviewOutput.result.score}`);
          reviewRevisionsTotal.inc();
          run.revisionCount++;

          writerOutput = await this.writerAgent.revise(currentDraft, feedback, context);
          run.totalTokens.input += writerOutput.tokensUsed.input;
          run.totalTokens.output += writerOutput.tokensUsed.output;
          currentDraft = writerOutput.draft;
        } else {
          log.warn(`Max revisions reached — publishing anyway (score: ${reviewOutput.result.score})`);
        }
      }

      run.draft = currentDraft;

      // Phase 4: Save draft to Blog API
      const savedPost = await this.blogApi.createDraft({
        title: currentDraft.title,
        content: currentDraft.content,
        excerpt: currentDraft.excerpt,
        status: 'DRAFT',
        tags: currentDraft.tags,
      });

      run.blogPostId = savedPost.id;
      draftsCreatedTotal.inc({ content_type: contentType });
      log.info(`Draft saved to blog API — post ID: ${savedPost.id}`);

      // Phase 5: Notify via notification-service
      await this.notifications.notifyDraftReady(
        currentDraft.title,
        savedPost.id,
        this.blogUrl,
      );

      run.status = 'completed';
      run.completedAt = new Date().toISOString();

      const durationSec = (Date.now() - new Date(run.startedAt).getTime()) / 1000;
      pipelineRunsTotal.inc({ content_type: contentType, trigger, status: 'completed' });
      pipelineDuration.observe({ content_type: contentType, trigger }, durationSec);

      log.info(
        `Pipeline ${id} completed in ${durationSec.toFixed(1)}s — ` +
        `"${currentDraft.title}" (post ${savedPost.id}, ` +
        `${run.totalTokens.input + run.totalTokens.output} total tokens, ` +
        `${run.revisionCount} revisions)`
      );

      return run;
    } catch (err) {
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      run.completedAt = new Date().toISOString();

      pipelineRunsTotal.inc({ content_type: contentType, trigger, status: 'failed' });
      log.error(`Pipeline ${id} failed: ${run.error}`);

      return run;
    }
  }

  async publishDraft(postId: number): Promise<void> {
    await this.blogApi.publishPost(postId);
    log.info(`Published post ${postId}`);
  }

  getRun(id: string): PipelineRun | undefined {
    return this.runs.get(id);
  }

  getRecentRuns(limit = 20): PipelineRun[] {
    return Array.from(this.runs.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  getStats(): PipelineStats {
    const runs = Array.from(this.runs.values());
    return {
      totalRuns: runs.length,
      completed: runs.filter(r => r.status === 'completed').length,
      failed: runs.filter(r => r.status === 'failed').length,
      running: runs.filter(r => r.status === 'running').length,
    };
  }
}

export interface PipelineStats {
  totalRuns: number;
  completed: number;
  failed: number;
  running: number;
}
