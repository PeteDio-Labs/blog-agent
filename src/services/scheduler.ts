/**
 * Scheduler
 * Day-of-week + hour based cron for content generation.
 * All times in UTC. Jobs are deduplicated per calendar day.
 *
 * Current schedule:
 *   weekly-recap  — Monday    18:00 UTC (12:00 PM CST)
 *   how-to        — Wednesday 18:00 UTC (12:00 PM CST)
 *   how-to        — Saturday  18:00 UTC (12:00 PM CST)
 */

import { logger } from '../utils/logger.js';
import type { PipelineOrchestrator } from './pipeline.js';
import type { ContentType } from '../types.js';

const log = logger.child('scheduler');

interface ScheduledJob {
  name: string;
  contentType: ContentType;
  /** UTC day of week: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat */
  utcDay: number;
  /** UTC hour to fire (0–23) */
  utcHour: number;
  additionalContext?: Record<string, unknown>;
  lastRun?: Date;
}

export class Scheduler {
  private jobs: ScheduledJob[] = [];
  private checkInterval?: ReturnType<typeof setInterval>;

  constructor(private pipeline: PipelineOrchestrator) {}

  start(): void {
    this.checkInterval = setInterval(() => this.tick(), 60_000);
    log.info(`Scheduler started — ${this.jobs.length} jobs registered`);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    log.info('Scheduler stopped');
  }

  registerWeeklyRecap(): void {
    this.jobs.push({ name: 'weekly-recap', contentType: 'weekly-recap', utcDay: 1, utcHour: 18 });
    log.info('Registered: weekly-recap — Monday 18:00 UTC');
  }

  registerHowTo(): void {
    const howToContext = {
      topicBias: 'Focus on platform engineering, SRE, observability, GitOps, multi-agent systems, or homelab automation. Write for engineers who already know the basics — avoid generic intro-to-Kubernetes topics. Good topics: deterministic agent runners, event-driven changelog automation, RAG pipelines for operational context, multi-service Kubernetes networking, GitOps approval workflows.',
    };
    // Two how-to posts per week — writer self-selects topic from cluster context, biased toward platform/SRE topics
    this.jobs.push({ name: 'how-to-wed', contentType: 'how-to', utcDay: 3, utcHour: 18, additionalContext: howToContext });
    this.jobs.push({ name: 'how-to-sat', contentType: 'how-to', utcDay: 6, utcHour: 18, additionalContext: howToContext });
    log.info('Registered: how-to — Wednesday + Saturday 18:00 UTC');
  }

  private tick(): void {
    const now = new Date();
    for (const job of this.jobs) {
      if (this.shouldRun(job, now)) {
        job.lastRun = now;
        log.info(`Running scheduled job: ${job.name}`);
        this.pipeline.runWithReporting(job.contentType, 'schedule', undefined, job.additionalContext ?? {}).catch(err => {
          log.error(`Scheduled job ${job.name} failed:`, err);
        });
      }
    }
  }

  private shouldRun(job: ScheduledJob, now: Date): boolean {
    if (now.getUTCDay() !== job.utcDay) return false;
    if (now.getUTCHours() !== job.utcHour) return false;

    // Deduplicate: only fire once per calendar day
    if (job.lastRun) {
      const lastRunDate = job.lastRun.toISOString().split('T')[0];
      const todayDate = now.toISOString().split('T')[0];
      if (lastRunDate === todayDate) return false;
    }

    return true;
  }

  getJobs(): Array<{ name: string; contentType: ContentType; lastRun?: string }> {
    return this.jobs.map(j => ({
      name: j.name,
      contentType: j.contentType,
      lastRun: j.lastRun?.toISOString(),
    }));
  }
}
