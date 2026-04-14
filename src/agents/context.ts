/**
 * Context Agent
 * Gathers live cluster data before writing.
 * Queries MC Backend (ArgoCD, K8s) + notification-service (recent events).
 *
 * For event-triggered pipelines, filters context to only include data
 * relevant to the trigger events — prevents unrelated noise from
 * polluting the writer's source material.
 */

import { logger } from '../utils/logger.js';
import { agentCallsTotal, agentDuration } from '../metrics/index.js';
import type { MCBackendClient } from '../clients/mcBackend.js';
import type { NotificationServiceClient } from '../clients/notificationService.js';
import type { RagClient } from '../clients/ragClient.js';
import type { ContentType, ContextAgentOutput, DeployInfo, HistoricalChunk, InfraEvent } from '../types.js';

const log = logger.child('context-agent');

/** Max age for events included in deploy-changelog context (10 minutes) */
const DEPLOY_EVENT_WINDOW_MS = 10 * 60 * 1000;

/** Event patterns that should never reach the writer (pre-bugfix artifacts) */
const BLOCKED_PATTERNS = [
  /CPU at \d{4,}/, // CPU values > 999% are bogus
  /memory at \d{4,}/, // memory values > 999% are bogus
];

export class ContextAgent {
  constructor(
    private mcBackend: MCBackendClient,
    private notifications: NotificationServiceClient,
    private ragClient?: RagClient,
  ) {}

  async gather(contentType: ContentType, additionalContext: Record<string, unknown> = {}): Promise<ContextAgentOutput> {
    const start = Date.now();
    log.info(`Gathering context for content type: ${contentType}`);

    try {
      // Try to gather live cluster data — gracefully degrade if services are unreachable
      let argocdApps: Awaited<ReturnType<MCBackendClient['getArgoApps']>> = [];
      let allEvents: InfraEvent[] = [];
      let clusterHealth: Awaited<ReturnType<MCBackendClient['getClusterHealth']>> | null = null;

      try {
        const results = await Promise.all([
          this.mcBackend.getArgoApps(),
          this.notifications.getRecentEvents(100),
          this.mcBackend.getClusterHealth(),
        ]);
        argocdApps = results[0];
        allEvents = results[1];
        clusterHealth = results[2];
      } catch (clusterErr) {
        log.warn(`Cluster services unreachable — using additionalContext only: ${clusterErr instanceof Error ? clusterErr.message : String(clusterErr)}`);
      }

      // Extract trigger events from additional context (set by EventListener)
      const triggerEvents = (additionalContext.triggerEvents as InfraEvent[] | undefined) ?? [];

      // Filter events based on content type and trigger
      const cleanEvents = this.filterBlockedEvents(allEvents);
      const recentEvents = this.filterByRelevance(cleanEvents, contentType, triggerEvents);
      const recentDeploys = this.extractDeploys(recentEvents);

      // RAG retrieval — query for semantically relevant past posts/sessions
      let historicalContext: HistoricalChunk[] = [];
      if (this.ragClient) {
        const ragQuery = this.buildRagQuery(contentType, triggerEvents, additionalContext);
        try {
          // Include 'doc' chunks for content types that benefit from architecture/knowledge context
          const ragSourceTypes: Array<'post' | 'session' | 'doc'> = ['post', 'session'];
          if (contentType === 'how-to' || contentType === 'weekly-recap' || contentType === 'docs-audit') {
            ragSourceTypes.push('doc');
          }
          const chunks = await this.ragClient.query({ query: ragQuery, topK: 5, sourceTypes: ragSourceTypes });
          historicalContext = chunks.map(c => ({
            sourceRef: c.sourceRef,
            sourceType: c.sourceType,
            chunkText: c.chunkText,
            similarity: c.similarity,
          }));
          log.info(`RAG retrieved ${historicalContext.length} historical chunks for query: "${ragQuery.slice(0, 80)}"`);
        } catch (ragErr) {
          log.warn(`RAG query failed, continuing without historical context: ${ragErr instanceof Error ? ragErr.message : String(ragErr)}`);
        }
      }

      const output: ContextAgentOutput = {
        contentType,
        triggerFacts: triggerEvents,
        cluster: {
          argocdApps,
          recentEvents,
          recentDeploys,
          clusterHealth,
          timestamp: new Date().toISOString(),
        },
        additionalContext: this.cleanAdditionalContext(additionalContext),
        historicalContext,
        gatheredAt: new Date().toISOString(),
      };

      const durationSec = (Date.now() - start) / 1000;
      agentCallsTotal.inc({ agent: 'context', status: 'success' });
      agentDuration.observe({ agent: 'context' }, durationSec);

      log.info(
        `Context gathered in ${durationSec.toFixed(1)}s — ` +
        `${argocdApps.length} apps, ${recentEvents.length}/${allEvents.length} events (filtered), ` +
        `${recentDeploys.length} deploys, ${triggerEvents.length} trigger events`
      );

      return output;
    } catch (err) {
      agentCallsTotal.inc({ agent: 'context', status: 'error' });
      log.error('Context gathering failed', err);
      throw err;
    }
  }

  /** Remove events with known-bad patterns (pre-bugfix health poller artifacts) */
  private filterBlockedEvents(events: InfraEvent[]): InfraEvent[] {
    return events.filter(e => {
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(e.message)) {
          log.debug(`Blocked event: ${e.message}`);
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Filter events by relevance to the content type and trigger.
   *
   * - deploy-changelog: only events matching trigger service/namespace within ±10 min
   * - weekly-recap / docs-audit: all events (broad scope)
   * - incident-postmortem: events matching trigger service/namespace
   */
  private filterByRelevance(events: InfraEvent[], contentType: ContentType, triggerEvents: InfraEvent[]): InfraEvent[] {
    if (contentType === 'weekly-recap' || contentType === 'docs-audit' || contentType === 'how-to') {
      return events;
    }

    if (triggerEvents.length === 0) {
      // No trigger context (API/schedule trigger) — return all events
      return events;
    }

    // Build set of relevant services and namespaces from trigger events
    const triggerServices = new Set(triggerEvents.map(e => e.affected_service).filter(Boolean));
    const triggerNamespaces = new Set(triggerEvents.map(e => e.namespace).filter(Boolean));

    // Time window: ±10 minutes around the earliest trigger event
    const triggerTimestamps = triggerEvents
      .map(e => new Date(e.timestamp ?? Date.now()).getTime())
      .filter(t => !isNaN(t));
    const earliest = triggerTimestamps.length > 0 ? Math.min(...triggerTimestamps) : Date.now();
    const windowStart = earliest - DEPLOY_EVENT_WINDOW_MS;
    const windowEnd = earliest + DEPLOY_EVENT_WINDOW_MS;

    const filtered = events.filter(e => {
      const eventTime = new Date(e.timestamp ?? Date.now()).getTime();

      // Must be within time window
      if (eventTime < windowStart || eventTime > windowEnd) return false;

      // Must match a trigger service or namespace
      const matchesService = e.affected_service && triggerServices.has(e.affected_service);
      const matchesNamespace = e.namespace && triggerNamespaces.has(e.namespace);

      return matchesService || matchesNamespace;
    });

    log.info(`Relevance filter: ${filtered.length}/${events.length} events match trigger context`);
    return filtered;
  }

  /** Build a RAG query string from trigger events and content type */
  private buildRagQuery(contentType: ContentType, triggerEvents: InfraEvent[], additionalContext: Record<string, unknown>): string {
    if (triggerEvents.length > 0) {
      const parts = triggerEvents.map(e =>
        [e.source, e.type, e.affected_service, e.namespace, e.message].filter(Boolean).join(' ')
      );
      return parts.join(' | ');
    }
    // For schedule/API triggers, use content type + any topic from additionalContext
    const topic = (additionalContext.topic as string | undefined) ?? '';
    return `${contentType} ${topic}`.trim();
  }

  /** Remove triggerEvents from additionalContext (it's now a top-level field) */
  private cleanAdditionalContext(ctx: Record<string, unknown>): Record<string, unknown> {
    const { triggerEvents: _, ...rest } = ctx;
    return rest;
  }

  private extractDeploys(events: InfraEvent[]): DeployInfo[] {
    return events
      .filter(e => e.type === 'deployment' || e.type === 'rollout')
      .map(e => ({
        service: e.affected_service ?? 'unknown',
        namespace: e.namespace ?? 'default',
        image: (e as unknown as Record<string, unknown>).metadata
          ? String((e as unknown as { metadata?: { image?: string } }).metadata?.image ?? 'unknown')
          : 'unknown',
        timestamp: e.timestamp ?? new Date().toISOString(),
      }));
  }
}
