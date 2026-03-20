/**
 * Writer Agent
 * Produces markdown blog drafts using the configured LLM provider.
 * Selects tone/style based on content type, receives context from Context Agent.
 */

import { logger } from '../utils/logger.js';
import { agentCallsTotal, agentDuration, llmTokensUsed } from '../metrics/index.js';
import { CONTENT_STYLE, type ContentType, type ContextAgentOutput, type BlogDraft, type WriterAgentOutput } from '../types.js';
import type { LLMProvider } from '../providers/llm.js';

const log = logger.child('writer-agent');

const SYSTEM_PROMPT = `You write blog posts for PeteDio Labs — a personal homelab blog about Kubernetes, self-hosting, and DevOps.

CRITICAL INSTRUCTION — OUTPUT FORMAT:
You MUST respond with a single JSON object. ALL blog content goes INSIDE the "content" field as a string. Use \\n for newlines inside the content string. Do NOT write anything outside the JSON object.

Example of CORRECT output:
{"title":"Shipped the Blog Agent Tonight","slug":"shipped-blog-agent-tonight","content":"The blog-agent went live at 2am. Watched it roll out in ArgoCD — synced clean on the first try, both nodes healthy, 24 pods humming along.\\n\\nThe fact that this service wrote its own deploy changelog is the kind of recursive homelab nonsense I live for.\\n\\n## What's Next\\n\\nHooking up the weekly recap cron so this thing writes itself every Monday.","excerpt":"The blog-agent deployed clean and wrote its own changelog. Peak homelab recursion.","tags":["blog-agent","argocd","deploy"]}

Rules:
- The ENTIRE response must be valid JSON — nothing before or after it
- The "content" field must contain the FULL blog post as markdown with \\n for line breaks
- Never leave "content" empty — that is where ALL the writing goes
- Write in first person, casual but technical, with real opinions
- Weave data into narrative prose — do not dump bullet lists of raw data`;

export class WriterAgent {
  constructor(private llm: LLMProvider) {
    log.info(`Writer agent configured with provider: ${llm.name}`);
  }

  async write(context: ContextAgentOutput, topic?: string): Promise<WriterAgentOutput> {
    const start = Date.now();
    const style = CONTENT_STYLE[context.contentType];

    log.info(`Writing ${context.contentType} draft${topic ? ` — topic: "${topic}"` : ''}`);

    const userPrompt = this.buildPrompt(context, style, topic);

    try {
      const response = await this.llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 4096,
        temperature: 0.7,
      });

      const draft = this.parseDraft(response.text, context.contentType);
      const tokensUsed = response.tokensUsed;

      llmTokensUsed.inc({ agent: 'writer', direction: 'input' }, tokensUsed.input);
      llmTokensUsed.inc({ agent: 'writer', direction: 'output' }, tokensUsed.output);

      const durationSec = (Date.now() - start) / 1000;
      agentCallsTotal.inc({ agent: 'writer', status: 'success' });
      agentDuration.observe({ agent: 'writer' }, durationSec);

      log.info(
        `Draft written in ${durationSec.toFixed(1)}s — ` +
        `"${draft.title}" (${draft.content.length} chars, ${tokensUsed.input + tokensUsed.output} tokens)`
      );

      return { draft, tokensUsed };
    } catch (err) {
      agentCallsTotal.inc({ agent: 'writer', status: 'error' });
      log.error('Writer agent failed', err);
      throw err;
    }
  }

  async revise(draft: BlogDraft, feedback: string, context: ContextAgentOutput): Promise<WriterAgentOutput> {
    const start = Date.now();
    log.info(`Revising draft: "${draft.title}"`);

    const userPrompt = `You previously wrote the following blog draft. The review agent has provided feedback. Revise the draft accordingly.

## Original Draft
Title: ${draft.title}
Content:
${draft.content}

## Review Feedback
${feedback}

## Original Context
Content type: ${context.contentType}
Cluster data timestamp: ${context.cluster.timestamp}

Respond with the same JSON format as before — the full revised draft.`;

    try {
      const response = await this.llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 4096,
        temperature: 0.7,
      });

      const revised = this.parseDraft(response.text, context.contentType);
      const tokensUsed = response.tokensUsed;

      llmTokensUsed.inc({ agent: 'writer', direction: 'input' }, tokensUsed.input);
      llmTokensUsed.inc({ agent: 'writer', direction: 'output' }, tokensUsed.output);

      const durationSec = (Date.now() - start) / 1000;
      agentCallsTotal.inc({ agent: 'writer', status: 'success' });
      agentDuration.observe({ agent: 'writer' }, durationSec);

      log.info(`Revision complete in ${durationSec.toFixed(1)}s`);

      return { draft: revised, tokensUsed };
    } catch (err) {
      agentCallsTotal.inc({ agent: 'writer', status: 'error' });
      log.error('Writer revision failed', err);
      throw err;
    }
  }

  private buildPrompt(context: ContextAgentOutput, style: { tone: string; format: string }, topic?: string): string {
    const parts: string[] = [];

    parts.push(`Write a ${context.contentType} blog post.`);
    if (topic) parts.push(`Topic: ${topic}`);
    parts.push(`Tone: ${style.tone}. Format: ${style.format}.`);
    parts.push('');
    parts.push('IMPORTANT: The data below is your SOURCE MATERIAL. Do NOT copy it as-is. Transform it into a narrative story. Write paragraphs, not bullet lists. Tell the reader what happened and why it matters.');
    parts.push('');
    parts.push('--- SOURCE DATA (do not copy verbatim) ---');

    // Compact cluster data as JSON so the model treats it as raw data, not template
    const sourceData: Record<string, unknown> = {
      timestamp: context.cluster.timestamp,
      clusterHealth: context.cluster.clusterHealth,
    };

    if (context.cluster.argocdApps.length > 0) {
      sourceData.argocdApps = context.cluster.argocdApps.map(a => `${a.name} (${a.namespace}): ${a.status}/${a.health}`);
    }
    if (context.cluster.recentDeploys.length > 0) {
      sourceData.recentDeploys = context.cluster.recentDeploys.slice(0, 10).map(d => `${d.service} → ${d.namespace}: ${d.image}`);
    }
    if (context.cluster.recentEvents.length > 0) {
      sourceData.recentEvents = context.cluster.recentEvents.slice(0, 15).map(e => `[${e.severity}] ${e.source}: ${e.message}`);
    }
    if (Object.keys(context.additionalContext).length > 0) {
      sourceData.additionalContext = context.additionalContext;
    }

    parts.push(JSON.stringify(sourceData, null, 2));
    parts.push('--- END SOURCE DATA ---');
    parts.push('');
    parts.push('Now write the blog post as a JSON object with title, slug, content (markdown string with \\n), excerpt, and tags. Remember: content must be narrative prose, not a data dump.');

    return parts.join('\n');
  }

  private parseDraft(text: string, contentType: ContentType): BlogDraft {
    // Strip potential markdown fences
    let cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();

    // Try 1: direct JSON parse
    const parsed = this.tryParseJson(cleaned);
    if (parsed) return this.jsonToDraft(parsed, contentType);

    // Try 2: extract first JSON object from the response (model sometimes writes text after the JSON)
    const jsonMatch = cleaned.match(/\{[\s\S]*?"title"\s*:\s*"[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}/);
    if (jsonMatch) {
      const extracted = this.tryParseJson(jsonMatch[0]);
      if (extracted) {
        // If content field is empty/short but there's text after the JSON, use the trailing text
        const contentStr = String(extracted.content ?? '');
        if (contentStr.length < 50 && cleaned.length > jsonMatch[0].length + 50) {
          const trailing = cleaned.slice(cleaned.indexOf(jsonMatch[0]) + jsonMatch[0].length).trim();
          if (trailing.length > 50) {
            extracted.content = trailing;
            log.info('Recovered content from text after JSON object');
          }
        }
        return this.jsonToDraft(extracted, contentType);
      }
    }

    // Try 3: find title/content fields individually with regex
    const titleMatch = cleaned.match(/"title"\s*:\s*"([^"]+)"/);
    const contentMatch = cleaned.match(/"content"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"(?:excerpt|tags))/);
    const slugMatch = cleaned.match(/"slug"\s*:\s*"([^"]+)"/);
    const excerptMatch = cleaned.match(/"excerpt"\s*:\s*"([^"]+)"/);

    if (titleMatch) {
      log.info('Partially parsed JSON fields from malformed output');
      return {
        title: titleMatch[1],
        slug: slugMatch?.[1] ?? `draft-${Date.now()}`,
        content: contentMatch?.[1] ?? cleaned,
        excerpt: excerptMatch?.[1] ?? cleaned.slice(0, 200),
        tags: [contentType],
        contentType,
        frontmatter: {},
      };
    }

    log.warn('Failed to parse writer output as JSON, falling back to raw text');
    const slug = `draft-${Date.now()}`;
    return {
      title: `Draft — ${contentType}`,
      slug,
      content: text,
      excerpt: text.slice(0, 200),
      tags: [contentType],
      contentType,
      frontmatter: {},
    };
  }

  private tryParseJson(text: string): Record<string, unknown> | null {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private jsonToDraft(parsed: Record<string, unknown>, contentType: ContentType): BlogDraft {
    return {
      title: String(parsed.title ?? `Draft — ${contentType}`),
      slug: String(parsed.slug ?? `draft-${Date.now()}`),
      content: String(parsed.content ?? ''),
      excerpt: String(parsed.excerpt ?? '').slice(0, 200),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [contentType],
      contentType,
      frontmatter: {},
    };
  }
}
