/**
 * Blog Agent Schemas & Types
 * Zod v4 schemas for request validation + TypeScript interfaces
 */

import { z } from 'zod';

// ─── Content Types ───────────────────────────────────────────────

export const ContentType = z.enum([
  'deploy-changelog',
  'weekly-recap',
  'how-to',
  'docs-audit',
  'incident-postmortem',
]);
export type ContentType = z.infer<typeof ContentType>;

export const TriggerType = z.enum([
  'event',    // notification-service deploy event
  'schedule', // cron (weekly recap)
  'api',      // on-demand API call
]);
export type TriggerType = z.infer<typeof TriggerType>;

export const DraftStatus = z.enum(['draft', 'published', 'archived']);
export type DraftStatus = z.infer<typeof DraftStatus>;

// ─── Generate Request ────────────────────────────────────────────

export const GenerateRequestSchema = z.object({
  contentType: ContentType,
  topic: z.string().min(1).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

// ─── Context Agent Output ────────────────────────────────────────

export interface ClusterContext {
  argocdApps: ArgoApp[];
  recentEvents: InfraEvent[];
  recentDeploys: DeployInfo[];
  clusterHealth: ClusterHealth;
  timestamp: string;
}

export interface ArgoApp {
  name: string;
  namespace: string;
  status: string;
  health: string;
  syncedAt: string;
}

export interface InfraEvent {
  id: string;
  source: string;
  type: string;
  severity: string;
  message: string;
  namespace?: string;
  affected_service?: string;
  timestamp: string;
}

export interface DeployInfo {
  service: string;
  namespace: string;
  image: string;
  timestamp: string;
}

export interface ClusterHealth {
  nodes: number;
  podsRunning: number;
  podsNotReady: number;
}

export interface ContextAgentOutput {
  contentType: ContentType;
  cluster: ClusterContext;
  additionalContext: Record<string, unknown>;
  gatheredAt: string;
}

// ─── Writer Agent Output ─────────────────────────────────────────

export interface BlogDraft {
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  tags: string[];
  contentType: ContentType;
  frontmatter: Record<string, unknown>;
}

export interface WriterAgentOutput {
  draft: BlogDraft;
  tokensUsed: { input: number; output: number };
}

// ─── Review Agent Output ─────────────────────────────────────────

export interface ReviewResult {
  approved: boolean;
  score: number;
  feedback: ReviewFeedback[];
  revisedDraft?: BlogDraft;
}

export interface ReviewFeedback {
  category: 'accuracy' | 'formatting' | 'readability' | 'tone' | 'completeness';
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestion?: string;
}

export interface ReviewAgentOutput {
  result: ReviewResult;
  tokensUsed: { input: number; output: number };
}

// ─── Pipeline Result ─────────────────────────────────────────────

export type PipelineStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PipelineRun {
  id: string;
  contentType: ContentType;
  trigger: TriggerType;
  status: PipelineStatus;
  draft?: BlogDraft;
  blogPostId?: number;
  review?: ReviewResult;
  revisionCount: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
  totalTokens: { input: number; output: number };
}

// ─── Blog API Types ──────────────────────────────────────────────

export interface BlogPostRequest {
  title: string;
  content: string;
  excerpt: string;
  status: string;
  tags: string[];
}

export interface BlogPostResponse {
  id: number;
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  status: string;
  tags: { id: number; name: string; slug: string }[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

// ─── Notification Types ──────────────────────────────────────────

export interface NotificationEvent {
  source: string;
  type: string;
  severity: string;
  message: string;
  namespace?: string;
  affected_service?: string;
  metadata?: Record<string, unknown>;
}

// ─── Style Guide ─────────────────────────────────────────────────

export const CONTENT_STYLE: Record<ContentType, { tone: string; format: string }> = {
  'deploy-changelog': {
    tone: 'concise, technical, confident',
    format: 'bullet-point changelog with service names, version diffs, and what changed',
  },
  'weekly-recap': {
    tone: 'narrative, engaging, personal homelab voice',
    format: 'narrative summary with sections for deployments, incidents, improvements, and what\'s next',
  },
  'how-to': {
    tone: 'detailed, step-by-step, educational but opinionated',
    format: 'tutorial with numbered steps, code blocks, screenshots placeholders, and troubleshooting tips',
  },
  'docs-audit': {
    tone: 'analytical, matter-of-fact',
    format: 'structured report comparing live cluster state vs documentation, listing drift and recommended fixes',
  },
  'incident-postmortem': {
    tone: 'structured, honest, lessons-focused',
    format: 'timeline → root cause analysis → resolution → lessons learned → action items',
  },
};
