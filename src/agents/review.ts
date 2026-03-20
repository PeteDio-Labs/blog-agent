/**
 * Review Agent
 * Quality gate that validates drafts against context data.
 * Returns approved or revision suggestions for the Writer to iterate on.
 */

import { logger } from '../utils/logger.js';
import { agentCallsTotal, agentDuration, llmTokensUsed } from '../metrics/index.js';
import type { BlogDraft, ContextAgentOutput, ReviewAgentOutput, ReviewFeedback, ReviewResult } from '../types.js';
import type { LLMProvider } from '../providers/llm.js';

const log = logger.child('review-agent');

const SYSTEM_PROMPT = `You are the PeteDio Labs blog reviewer — a quality gate for auto-generated content.

Your job:
1. Check factual accuracy against the provided cluster context data
2. Validate markdown formatting (code blocks have language tags, headers are consistent, links are well-formed)
3. Score readability and tone consistency with a personal homelab blog
4. Check for completeness — does the post match the requested content type?

Scoring:
- 80+ = approved, ready to publish as draft
- 60-79 = needs minor revisions, provide specific suggestions
- Below 60 = needs significant rework, provide detailed feedback

Output Format:
Respond with valid JSON matching this structure:
{
  "approved": boolean,
  "score": number (0-100),
  "feedback": [
    {
      "category": "accuracy" | "formatting" | "readability" | "tone" | "completeness",
      "severity": "info" | "warning" | "error",
      "message": "description of the issue",
      "suggestion": "optional fix suggestion"
    }
  ]
}

Do NOT wrap the JSON in markdown code fences. Return raw JSON only.
Be constructive but honest. This is a quality gate, not a rubber stamp.`;

export class ReviewAgent {
  constructor(private llm: LLMProvider) {
    log.info(`Review agent configured with provider: ${llm.name}`);
  }

  async review(draft: BlogDraft, context: ContextAgentOutput): Promise<ReviewAgentOutput> {
    const start = Date.now();
    log.info(`Reviewing draft: "${draft.title}"`);

    const userPrompt = this.buildPrompt(draft, context);

    try {
      const response = await this.llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 2048,
        temperature: 0.2,
      });

      const result = this.parseReview(response.text);
      const tokensUsed = response.tokensUsed;

      llmTokensUsed.inc({ agent: 'review', direction: 'input' }, tokensUsed.input);
      llmTokensUsed.inc({ agent: 'review', direction: 'output' }, tokensUsed.output);

      const durationSec = (Date.now() - start) / 1000;
      agentCallsTotal.inc({ agent: 'review', status: 'success' });
      agentDuration.observe({ agent: 'review' }, durationSec);

      log.info(
        `Review complete in ${durationSec.toFixed(1)}s — ` +
        `score: ${result.score}, approved: ${result.approved}, ` +
        `${result.feedback.length} feedback items`
      );

      return { result, tokensUsed };
    } catch (err) {
      agentCallsTotal.inc({ agent: 'review', status: 'error' });
      log.error('Review agent failed', err);
      throw err;
    }
  }

  private buildPrompt(draft: BlogDraft, context: ContextAgentOutput): string {
    const parts: string[] = [];

    parts.push('## Blog Draft to Review');
    parts.push(`**Title:** ${draft.title}`);
    parts.push(`**Slug:** ${draft.slug}`);
    parts.push(`**Content Type:** ${draft.contentType}`);
    parts.push(`**Tags:** ${draft.tags.join(', ')}`);
    parts.push(`**Excerpt:** ${draft.excerpt}`);
    parts.push('');
    parts.push('### Content');
    parts.push(draft.content);
    parts.push('');

    parts.push('## Cluster Context (ground truth for accuracy check)');
    parts.push(`Data gathered at: ${context.cluster.timestamp}`);
    parts.push('');

    if (context.cluster.argocdApps.length > 0) {
      parts.push('### ArgoCD Applications');
      for (const app of context.cluster.argocdApps) {
        parts.push(`- ${app.name} (${app.namespace}): ${app.status}/${app.health}`);
      }
      parts.push('');
    }

    if (context.cluster.recentDeploys.length > 0) {
      parts.push('### Recent Deployments');
      for (const deploy of context.cluster.recentDeploys.slice(0, 10)) {
        parts.push(`- ${deploy.service} in ${deploy.namespace}: ${deploy.image}`);
      }
      parts.push('');
    }

    if (context.cluster.recentEvents.length > 0) {
      parts.push('### Recent Events');
      for (const event of context.cluster.recentEvents.slice(0, 10)) {
        parts.push(`- [${event.severity}] ${event.source}/${event.type}: ${event.message}`);
      }
      parts.push('');
    }

    const health = context.cluster.clusterHealth;
    parts.push('### Cluster Health');
    parts.push(`Nodes: ${health.nodes}, Pods running: ${health.podsRunning}, Not ready: ${health.podsNotReady}`);

    return parts.join('\n');
  }

  private parseReview(text: string): ReviewResult {
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();

    try {
      const parsed = JSON.parse(cleaned) as {
        approved: boolean;
        score: number;
        feedback: ReviewFeedback[];
      };

      return {
        approved: parsed.approved,
        score: Math.min(100, Math.max(0, parsed.score)),
        feedback: parsed.feedback ?? [],
      };
    } catch (err) {
      log.warn('Failed to parse review output as JSON, defaulting to approved with warning');
      return {
        approved: true,
        score: 70,
        feedback: [{
          category: 'completeness',
          severity: 'warning',
          message: 'Review agent output could not be parsed — auto-approved with reduced confidence',
        }],
      };
    }
  }
}
