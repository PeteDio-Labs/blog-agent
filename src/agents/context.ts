/**
 * Context Agent
 * Gathers live cluster data before writing.
 * Queries MC Backend (ArgoCD, K8s) + notification-service (recent events).
 */

import { logger } from '../utils/logger.js';
import { agentCallsTotal, agentDuration } from '../metrics/index.js';
import type { MCBackendClient } from '../clients/mcBackend.js';
import type { NotificationServiceClient } from '../clients/notificationService.js';
import type { ContentType, ContextAgentOutput, DeployInfo, InfraEvent } from '../types.js';

const log = logger.child('context-agent');

export class ContextAgent {
  constructor(
    private mcBackend: MCBackendClient,
    private notifications: NotificationServiceClient,
  ) {}

  async gather(contentType: ContentType, additionalContext: Record<string, unknown> = {}): Promise<ContextAgentOutput> {
    const start = Date.now();
    log.info(`Gathering context for content type: ${contentType}`);

    try {
      // Fetch cluster data in parallel
      const [argocdApps, recentEvents, clusterHealth] = await Promise.all([
        this.mcBackend.getArgoApps(),
        this.notifications.getRecentEvents(100),
        this.mcBackend.getClusterHealth(),
      ]);

      // Extract deploy-related events
      const recentDeploys = this.extractDeploys(recentEvents);

      const output: ContextAgentOutput = {
        contentType,
        cluster: {
          argocdApps,
          recentEvents,
          recentDeploys,
          clusterHealth,
          timestamp: new Date().toISOString(),
        },
        additionalContext,
        gatheredAt: new Date().toISOString(),
      };

      const durationSec = (Date.now() - start) / 1000;
      agentCallsTotal.inc({ agent: 'context', status: 'success' });
      agentDuration.observe({ agent: 'context' }, durationSec);

      log.info(
        `Context gathered in ${durationSec.toFixed(1)}s — ` +
        `${argocdApps.length} apps, ${recentEvents.length} events, ${recentDeploys.length} deploys`
      );

      return output;
    } catch (err) {
      agentCallsTotal.inc({ agent: 'context', status: 'error' });
      log.error('Context gathering failed', err);
      throw err;
    }
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
