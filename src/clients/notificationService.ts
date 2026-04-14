/**
 * Notification Service Client
 * Sends events and fetches recent infra events.
 */

import { logger } from '../utils/logger.js';
import type { NotificationEvent, InfraEvent } from '../types.js';

const log = logger.child('notification-client');

export class NotificationServiceClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async sendEvent(event: NotificationEvent): Promise<void> {
    log.info(`Sending notification: ${event.type} — ${event.message.slice(0, 80)}`);
    const res = await fetch(`${this.baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    if (!res.ok) {
      const body = await res.text();
      log.error(`Notification POST failed (${res.status}): ${body}`);
    }
  }

  async getRecentEvents(limit = 50): Promise<InfraEvent[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/events?limit=${limit}`);

    if (!res.ok) {
      log.warn(`Failed to fetch recent events (${res.status})`);
      return [];
    }

    const data = await res.json() as { events: InfraEvent[] };
    return data.events;
  }

  async notifyDraftReady(title: string, postId: number, blogUrl: string): Promise<void> {
    const draftUrl = `${blogUrl}/drafts/${postId}`;
    await this.sendEvent({
      source: 'kubernetes',
      type: 'deployment',
      severity: 'info',
      message: `📝 Blog draft ready for review: "${title}" — ${draftUrl}`,
      namespace: 'blog-dev',
      affected_service: 'blog-agent',
      metadata: { postId, title, action: 'draft-ready', blogUrl: draftUrl, path: `/drafts/${postId}` },
    });
  }

  async notifyPublished(title: string, postId: number, blogUrl: string, slug?: string): Promise<void> {
    const postPath = slug ? `/posts/${slug}` : `/posts/${postId}`;
    const postUrl = `${blogUrl}${postPath}`;
    await this.sendEvent({
      source: 'kubernetes',
      type: 'deployment',
      severity: 'info',
      message: `🚀 Blog post auto-published: "${title}" — ${postUrl}`,
      namespace: 'blog-dev',
      affected_service: 'blog-agent',
      metadata: { postId, title, slug, action: 'auto-published', blogUrl: postUrl, path: postPath },
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
