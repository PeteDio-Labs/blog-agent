import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { EventListener } from './eventListener.js';
import type { PipelineOrchestrator } from './pipeline.js';
import type { InfraEvent } from '../types.js';

// Minimal mock pipeline
function createMockPipeline() {
  const runs: Array<{ contentType: string; trigger: string; topic?: string; context?: Record<string, unknown> }> = [];
  return {
    runs,
    runWithReporting: mock(async (contentType: string, trigger: string, topic?: string, context?: Record<string, unknown>) => {
      runs.push({ contentType, trigger, topic, context });
      return {
        id: 'test-run-1',
        contentType,
        trigger,
        status: 'completed' as const,
        draft: { title: 'Test Draft' },
        blogPostId: 42,
        revisionCount: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalTokens: { input: 0, output: 0 },
      };
    }),
  };
}

describe('EventListener', () => {
  let listener: EventListener;
  let mockPipeline: ReturnType<typeof createMockPipeline>;

  beforeEach(() => {
    mockPipeline = createMockPipeline();
    // Use a short debounce for tests
    listener = new EventListener(
      'http://localhost:3001',
      mockPipeline as unknown as PipelineOrchestrator,
      { debounceMs: 50 },
    );
  });

  afterEach(() => {
    listener.stop();
  });

  it('should filter non-deploy events', () => {
    const event: InfraEvent = {
      id: 'e1',
      source: 'proxmox',
      type: 'node-status',
      severity: 'info',
      message: 'Node healthy',
      timestamp: new Date().toISOString(),
    };

    // Access private method via any for testing
    (listener as any).handleEvent(event);

    expect((listener as any).pendingEvents.length).toBe(0);
  });

  it('should buffer deployment events', () => {
    const event: InfraEvent = {
      id: 'e2',
      source: 'kubernetes',
      type: 'deployment',
      severity: 'info',
      message: 'Deployment blog-api restarted',
      affected_service: 'blog-api',
      namespace: 'blog-dev',
      timestamp: new Date().toISOString(),
    };

    (listener as any).handleEvent(event);

    expect((listener as any).pendingEvents.length).toBe(1);
  });

  it('should buffer rollout events', () => {
    const event: InfraEvent = {
      id: 'e3',
      source: 'argocd',
      type: 'rollout',
      severity: 'info',
      message: 'ArgoCD sync triggered for blog-dev',
      affected_service: 'blog-dev',
      timestamp: new Date().toISOString(),
    };

    (listener as any).handleEvent(event);

    expect((listener as any).pendingEvents.length).toBe(1);
  });

  it('should debounce multiple events and trigger pipeline once', async () => {
    const events: InfraEvent[] = [
      {
        id: 'e4',
        source: 'kubernetes',
        type: 'deployment',
        severity: 'info',
        message: 'blog-api restarted',
        affected_service: 'blog-api',
        namespace: 'blog-dev',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'e5',
        source: 'argocd',
        type: 'rollout',
        severity: 'info',
        message: 'ArgoCD sync for mission-control-dev',
        affected_service: 'mission-control-dev',
        timestamp: new Date().toISOString(),
      },
    ];

    for (const event of events) {
      (listener as any).handleEvent(event);
    }

    expect((listener as any).pendingEvents.length).toBe(2);

    // Wait for debounce to fire
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockPipeline.runWithReporting).toHaveBeenCalledTimes(1);
    expect(mockPipeline.runs[0]!.contentType).toBe('deploy-changelog');
    expect(mockPipeline.runs[0]!.trigger).toBe('event');
    expect(mockPipeline.runs[0]!.topic).toContain('blog-api');
    expect(mockPipeline.runs[0]!.topic).toContain('mission-control-dev');

    // Pending events should be drained
    expect((listener as any).pendingEvents.length).toBe(0);
  });

  it('should pass trigger events as additional context', async () => {
    const event: InfraEvent = {
      id: 'e6',
      source: 'kubernetes',
      type: 'deployment',
      severity: 'info',
      message: 'pete-bot restarted',
      affected_service: 'pete-bot',
      namespace: 'mission-control',
      timestamp: new Date().toISOString(),
    };

    (listener as any).handleEvent(event);

    await new Promise(resolve => setTimeout(resolve, 100));

    const ctx = mockPipeline.runs[0]!.context as { triggerEvents: InfraEvent[] };
    expect(ctx.triggerEvents).toHaveLength(1);
    expect(ctx.triggerEvents[0]!.affected_service).toBe('pete-bot');
  });
});
