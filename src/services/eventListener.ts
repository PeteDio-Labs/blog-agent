/**
 * SSE Event Listener
 *
 * Connects to MC Backend's SSE stream and triggers the content pipeline
 * when deploy-related events arrive. Debounces rapid-fire deploys into
 * a single changelog generation.
 */

import { SseListener } from '@petedio/shared';
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

/** Ignore events originating from this agent to prevent feedback loops */
const SELF_SERVICE = 'blog-agent';

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
  private sse: SseListener;

  constructor(
    mcBackendUrl: string,
    private pipeline: PipelineOrchestrator,
    options?: EventListenerOptions,
  ) {
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    this.sse = new SseListener(`${mcBackendUrl}/api/v1/events/stream`, {
      onConnect: () => {
        sseConnected.set(1);
        log.info('Connected to SSE stream');
      },
      onDisconnect: () => {
        sseConnected.set(0);
      },
      onError: (err) => {
        log.error(`SSE connection error: ${err instanceof Error ? err.message : err}`);
      },
      onEvent: (data) => {
        if ((data as { type?: string }).type === 'connected') return;
        const event = data as InfraEvent;
        sseEventsReceived.inc({
          source: event.source ?? 'unknown',
          type: event.type ?? 'unknown',
        });
        this.handleEvent(event);
      },
    });
  }

  start(): void {
    this.sse.start();
    log.info(`Event listener started — debounce: ${this.debounceMs / 1000}s`);
  }

  stop(): void {
    this.sse.stop();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    log.info('Event listener stopped');
  }

  private handleEvent(event: InfraEvent): void {
    if (!DEPLOY_EVENT_TYPES.has(event.type)) {
      log.debug(`Ignoring non-deploy event: ${event.source}/${event.type}`);
      return;
    }

    if (event.affected_service === SELF_SERVICE || event.source === 'agent') {
      log.debug(`Ignoring self-generated event: ${event.source}/${event.type} (${event.affected_service})`);
      return;
    }

    log.info(
      `Deploy event: ${event.source}/${event.type} — ${event.affected_service ?? 'unknown'} in ${event.namespace ?? 'unknown'}`,
    );

    this.pendingEvents.push(event);

    if (this.debounceTimer) clearTimeout(this.debounceTimer);

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
      .runWithReporting('deploy-changelog', 'event', topic, { triggerEvents: events })
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
