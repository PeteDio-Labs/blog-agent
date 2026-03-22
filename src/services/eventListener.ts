/**
 * SSE Event Listener
 *
 * Connects to MC Backend's SSE stream and triggers the content pipeline
 * when deploy-related events arrive. Debounces rapid-fire deploys into
 * a single changelog generation.
 */

import { logger } from '../utils/logger.js';
import type { PipelineOrchestrator } from './pipeline.js';
import type { InfraEvent } from '../types.js';
import {
  sseEventsReceived,
  sseConnected,
  sseTriggeredPipelines,
} from '../metrics/index.js';

const log = logger.child('event-listener');

/** Event types that should trigger a deploy-changelog */
const DEPLOY_EVENT_TYPES = new Set(['deployment', 'rollout']);

/** Default debounce window — collect deploys for 2 minutes before generating */
const DEFAULT_DEBOUNCE_MS = 2 * 60 * 1000;

export interface EventListenerOptions {
  /** Debounce window in ms (default: 120_000 = 2 min) */
  debounceMs?: number;
}

export class EventListener {
  private debounceMs: number;
  private pendingEvents: InfraEvent[] = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;
  private stopped = false;

  constructor(
    private mcBackendUrl: string,
    private pipeline: PipelineOrchestrator,
    options?: EventListenerOptions,
  ) {
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    log.info(`Event listener started — debounce: ${this.debounceMs / 1000}s`);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    sseConnected.set(0);
    log.info('Event listener stopped');
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const streamUrl = `${this.mcBackendUrl}/api/v1/events/stream`;
    log.info(`Connecting to ${streamUrl}`);

    try {
      const response = await fetch(streamUrl, {
        headers: { Accept: 'text/event-stream' },
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      sseConnected.set(1);
      this.retryDelay = 1000;
      log.info('Connected to SSE stream');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'connected') continue;

            const event = data as InfraEvent;
            sseEventsReceived.inc({
              source: event.source ?? 'unknown',
              type: event.type ?? 'unknown',
            });

            this.handleEvent(event);
          } catch {
            // Ignore malformed SSE data
          }
        }
      }

      sseConnected.set(0);
      log.warn('SSE stream ended, reconnecting...');
    } catch (err) {
      sseConnected.set(0);
      log.error(`Connection error: ${err instanceof Error ? err.message : err}`);
    }

    if (!this.stopped) {
      log.info(`Reconnecting in ${this.retryDelay / 1000}s...`);
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    }
  }

  private handleEvent(event: InfraEvent): void {
    if (!DEPLOY_EVENT_TYPES.has(event.type)) {
      log.debug(`Ignoring non-deploy event: ${event.source}/${event.type}`);
      return;
    }

    log.info(
      `Deploy event: ${event.source}/${event.type} — ${event.affected_service ?? 'unknown'} in ${event.namespace ?? 'unknown'}`,
    );

    this.pendingEvents.push(event);

    // Reset debounce timer — wait for more deploys to batch together
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.triggerPipeline();
    }, this.debounceMs);

    log.debug(
      `${this.pendingEvents.length} deploy event(s) buffered — generating in ${this.debounceMs / 1000}s`,
    );
  }

  private triggerPipeline(): void {
    const events = this.pendingEvents.splice(0);
    this.debounceTimer = undefined;

    if (events.length === 0) return;

    const services = [...new Set(events.map(e => e.affected_service).filter(Boolean))];
    const topic = services.length > 0
      ? `Deploy update: ${services.join(', ')}`
      : `Deploy changelog (${events.length} events)`;

    log.info(`Triggering deploy-changelog pipeline — ${events.length} event(s): ${topic}`);
    sseTriggeredPipelines.inc();

    this.pipeline
      .run('deploy-changelog', 'event', topic, {
        triggerEvents: events,
      })
      .then(run => {
        if (run.status === 'completed') {
          log.info(`Event-triggered pipeline completed — "${run.draft?.title}" (post ${run.blogPostId})`);
        } else {
          log.error(`Event-triggered pipeline failed: ${run.error}`);
        }
      })
      .catch(err => {
        log.error(`Event-triggered pipeline threw: ${err instanceof Error ? err.message : err}`);
      });
  }
}
