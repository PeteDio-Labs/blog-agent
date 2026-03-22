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
import type { ContentType, ContextAgentOutput, DeployInfo, InfraEvent } from '../types.js';

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
  ) {}

  async gather(contentType: ContentType, additionalContext: Record<string, unknown> = {}): Promise<ContextAgentOutput> {
    const start = Date.now();
    log.info(`Gathering context for content type: ${contentType}`);

    try {
      const [argocdApps, allEvents, clusterHealth] = await Promise.all([
        this.mcBackend.getArgoApps(),
        this.notifications.getRecentEvents(100),
        this.mcBackend.getClusterHealth(),
      ]);

      // Extract trigger events from additional context (set by EventListener)
      const triggerEvents = (additionalContext.triggerEvents as InfraEvent[] | undefined) ?? [];

      // Filter events based on content type and trigger
      const cleanEvents = this.filterBlockedEvents(allEvents);
      const recentEvents = this.filterByRelevance(cleanEvents, contentType, triggerEvents);
      const recentDeploys = this.extractDeploys(recentEvents);

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
      .map(e => new Date(e.timestamp).getTime())
      .filter(t => !isNaN(t));
    const earliest = triggerTimestamps.length > 0 ? Math.min(...triggerTimestamps) : Date.now();
    const windowStart = earliest - DEPLOY_EVENT_WINDOW_MS;
    const windowEnd = earliest + DEPLOY_EVENT_WINDOW_MS;

    const filtered = events.filter(e => {
      const eventTime = new Date(e.timestamp).getTime();

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
        timestamp: e.timestamp,
      }));
  }
}
