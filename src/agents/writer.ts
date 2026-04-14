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

FACTUAL GROUNDING RULES:
- The "TRIGGER FACTS" section is what this post is ABOUT. Write about those events and ONLY those events.
- The "BACKGROUND CONTEXT" section is supporting data — use it for color (e.g., "all 6 ArgoCD apps healthy") but do NOT invent incidents from it.
- If you see events in "RECENT ACTIVITY" that are unrelated to the trigger service/namespace, do NOT mention them.
- NEVER invent problems that aren't in the data. If the deploy was clean, say it was clean.
- NEVER report metric values you didn't receive. If no CPU/memory data is provided, don't mention CPU/memory.
- NEVER dramatize or escalate. A routine deploy is a routine deploy, not a crisis.
- When in doubt, be boring and accurate rather than dramatic and wrong.

BAD example (fabricated incident from unrelated data):
{"title":"...", "content":"The deploy caused CPU spikes to 4000% and memory alerts fired across the cluster..."}
This is WRONG because the CPU data came from an unrelated monitoring event, not from this deploy.

GOOD example (accurate, grounded):
{"title":"...", "content":"blog-agent deployed clean to blog-dev. ArgoCD synced on first try, pod healthy within 30s. Nothing broke — exactly how a deploy should go."}

Rules:
- The ENTIRE response must be valid JSON — nothing before or after it
- The "content" field must contain the FULL blog post as markdown with \\n for line breaks
- Never leave "content" empty — that is where ALL the writing goes
- Write in first person, casual but technical, with real opinions
- Weave data into narrative prose — do not dump bullet lists of raw data`;

/** Content-type-specific LLM temperature */
const TEMPERATURE: Record<ContentType, number> = {
  'deploy-changelog': 0.4, // factual, low creativity
  'incident-postmortem': 0.4,
  'docs-audit': 0.4,
  'weekly-recap': 0.7, // narrative, moderate creativity
  'how-to': 0.7,
};

export class WriterAgent {
  constructor(private llm: LLMProvider) {
    log.info(`Writer agent configured with provider: ${llm.name}`);
  }

  async write(context: ContextAgentOutput, topic?: string): Promise<WriterAgentOutput> {
    const start = Date.now();
    const style = CONTENT_STYLE[context.contentType];
    const temperature = TEMPERATURE[context.contentType] ?? 0.7;

    log.info(`Writing ${context.contentType} draft${topic ? ` — topic: "${topic}"` : ''} (temp: ${temperature})`);

    const userPrompt = this.buildPrompt(context, style, topic);

    try {
      const response = await this.llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 4096,
        temperature,
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
    const temperature = TEMPERATURE[context.contentType] ?? 0.7;
    log.info(`Revising draft: "${draft.title}"`);

    const userPrompt = `You previously wrote the following blog draft. The review agent has provided feedback. Revise the draft accordingly.

IMPORTANT: Fix accuracy issues FIRST. If the reviewer says something is fabricated or unverifiable, REMOVE it. Do not try to reword fabricated claims — delete them entirely.

## Original Draft
Title: ${draft.title}
Content:
${draft.content}

## Review Feedback
${feedback}

## Trigger Facts (what this post is about)
${context.triggerFacts.length > 0
  ? context.triggerFacts.map(e => `- ${e.source}/${e.type}: ${e.message} [${e.affected_service ?? 'unknown'} in ${e.namespace ?? 'unknown'}]`).join('\n')
  : 'No specific trigger — general content'}

Respond with the same JSON format as before — the full revised draft.`;

    try {
      const response = await this.llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 4096,
        temperature,
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

    // Trigger facts — what this post is ABOUT
    parts.push('--- TRIGGER FACTS (this is what you are writing about) ---');
    if (context.triggerFacts.length > 0) {
      for (const e of context.triggerFacts) {
        parts.push(`- ${e.source}/${e.type}: ${e.message} [service: ${e.affected_service ?? 'unknown'}, namespace: ${e.namespace ?? 'unknown'}, severity: ${e.severity}]`);
      }
    } else {
      parts.push('No specific trigger event — write based on the topic and background context.');
    }
    parts.push('--- END TRIGGER FACTS ---');
    parts.push('');

    // Background context — supporting data
    parts.push('--- BACKGROUND CONTEXT (supporting data, NOT the main story) ---');
    const background: Record<string, unknown> = {
      timestamp: context.cluster.timestamp,
    };
    if (context.cluster.clusterHealth) {
      background.clusterHealth = context.cluster.clusterHealth;
    }
    if (context.cluster.argocdApps.length > 0) {
      background.argocdApps = context.cluster.argocdApps.map(a => `${a.name} (${a.namespace}): ${a.status}/${a.health}`);
    }
    if (context.cluster.recentDeploys.length > 0) {
      background.recentDeploys = context.cluster.recentDeploys.slice(0, 10).map(d => `${d.service} → ${d.namespace}: ${d.image}`);
    }
    parts.push(JSON.stringify(background, null, 2));
    parts.push('--- END BACKGROUND CONTEXT ---');
    parts.push('');

    // Recent activity — optional color, clearly labeled
    if (context.cluster.recentEvents.length > 0) {
      parts.push('--- RECENT ACTIVITY (optional color — only mention if directly related to the trigger) ---');
      for (const e of context.cluster.recentEvents.slice(0, 10)) {
        parts.push(`- [${e.severity}] ${e.source}/${e.type}: ${e.message}`);
      }
      parts.push('--- END RECENT ACTIVITY ---');
      parts.push('');
    }

    // Historical context — semantically relevant past posts/sessions from RAG
    if (context.historicalContext && context.historicalContext.length > 0) {
      parts.push('--- HISTORICAL CONTEXT (past posts about this topic — for continuity only, do NOT copy) ---');
      for (const chunk of context.historicalContext) {
        parts.push(`[${chunk.sourceRef}] ${chunk.chunkText.slice(0, 400).replace(/\n/g, ' ')}`);
      }
      parts.push('--- END HISTORICAL CONTEXT ---');
      parts.push('');
    }

    // Project documentation context (injected by MCP docs-context server)
    if (context.additionalContext.projectDocs) {
      const docs = context.additionalContext.projectDocs;
      if (typeof docs === 'string') {
        // Pre-formatted readable text from MCP server
        parts.push('--- PROJECT CONTEXT (what happened this week — use this for narrative) ---');
        parts.push(docs);
        parts.push('--- END PROJECT CONTEXT ---');
      } else {
        // Structured object fallback
        parts.push('--- PROJECT CONTEXT ---');
        parts.push(JSON.stringify(docs, null, 2));
        parts.push('--- END PROJECT CONTEXT ---');
      }
      parts.push('');
    }

    // Topic bias — explicit guidance for scheduled how-to posts
    if (context.additionalContext.topicBias) {
      parts.push(`TOPIC GUIDANCE: ${context.additionalContext.topicBias}`);
      parts.push('');
    }

    // Other additional context (generic fallback)
    const otherContext = { ...context.additionalContext };
    delete otherContext.projectDocs;
    delete otherContext.topicBias;
    if (Object.keys(otherContext).length > 0) {
      parts.push('Additional context: ' + JSON.stringify(otherContext));
      parts.push('');
    }

    parts.push('Now write the blog post as a JSON object with title, slug, content (markdown string with \\n), excerpt, and tags.');
    parts.push('Remember: write ONLY about the trigger facts. Be accurate. Do not invent incidents.');

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
      return this.jsonToDraft({
        title: titleMatch[1],
        slug: slugMatch?.[1] ?? `draft-${Date.now()}`,
        content: contentMatch?.[1] ?? cleaned,
        excerpt: excerptMatch?.[1] ?? cleaned.slice(0, 200),
        tags: [contentType],
      }, contentType);
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
    let content = String(parsed.content ?? '');

    // Fix double-wrapped JSON: LLM sometimes returns the entire JSON object as the content string
    let unwrapDepth = 0;
    while (content.trimStart().startsWith('{') && unwrapDepth < 3) {
      const inner = this.tryParseJson(content) ?? this.parseJsonLikeObject(content);
      if (inner && typeof inner.content === 'string' && inner.content.length > 0) {
        log.info('Unwrapped double-wrapped JSON in content field');
        content = inner.content;
        // Also pull inner fields if outer ones are missing/generic
        if (!parsed.title && inner.title) parsed.title = inner.title;
        if (!parsed.slug && inner.slug) parsed.slug = inner.slug;
        if (!parsed.excerpt && inner.excerpt) parsed.excerpt = inner.excerpt;
        if (!parsed.tags && inner.tags) parsed.tags = inner.tags;
        unwrapDepth++;
        continue;
      }
      break;
    }

    let excerpt = String(parsed.excerpt ?? '').slice(0, 200);
    if (!excerpt || excerpt.trimStart().startsWith('{')) {
      excerpt = content.slice(0, 200);
    }

    return {
      title: String(parsed.title ?? `Draft — ${contentType}`),
      slug: String(parsed.slug ?? `draft-${Date.now()}`),
      content,
      excerpt,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [contentType],
      contentType,
      frontmatter: {},
    };
  }

  /**
   * Best-effort parser for almost-JSON objects where inner content has unescaped quotes.
   * Extracts fields by delimiters instead of full JSON parsing.
   */
  private parseJsonLikeObject(text: string): Record<string, unknown> | null {
    const title = this.extractDelimited(text, '"title":"', ['","slug":', '","content":', '"}']);
    const slug = this.extractDelimited(text, '"slug":"', ['","content":', '","excerpt":', '"}']);
    const content = this.extractDelimited(text, '"content":"', ['","excerpt":', '","tags":', '"}']);
    const excerpt = this.extractDelimited(text, '"excerpt":"', ['","tags":', '"}']);

    if (!content) return null;

    let tags: string[] = [];
    const tagsStart = text.indexOf('"tags":[');
    if (tagsStart >= 0) {
      const tagsEnd = text.indexOf(']', tagsStart);
      if (tagsEnd > tagsStart) {
        const tagsRaw = text.slice(tagsStart + '"tags":['.length, tagsEnd).trim();
        if (tagsRaw.length > 0) {
          tags = tagsRaw
            .split(',')
            .map((tag) => tag.trim().replace(/^"|"$/g, ''))
            .filter(Boolean);
        }
      }
    }

    return {
      ...(title ? { title: this.unescapeJsonString(title) } : {}),
      ...(slug ? { slug: this.unescapeJsonString(slug) } : {}),
      content: this.unescapeJsonString(content),
      ...(excerpt ? { excerpt: this.unescapeJsonString(excerpt) } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    };
  }

  private extractDelimited(text: string, startToken: string, endTokens: string[]): string | null {
    const start = text.indexOf(startToken);
    if (start < 0) return null;
    const valueStart = start + startToken.length;

    const endCandidates = endTokens
      .map((token) => text.indexOf(token, valueStart))
      .filter((idx) => idx >= 0);

    if (endCandidates.length === 0) {
      const trailing = text.slice(valueStart).replace(/"\s*\}?$/, '').trim();
      return trailing.length > 0 ? trailing : null;
    }
    const end = Math.min(...endCandidates);
    return text.slice(valueStart, end);
  }

  private unescapeJsonString(value: string): string {
    return value
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r');
  }
}
