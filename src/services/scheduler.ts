/**
 * Scheduler
 * Simple interval-based cron for scheduled content generation.
 * Weekly recap: Monday 12:00 PM CST (18:00 UTC)
 */

import { logger } from '../utils/logger.js';
import type { PipelineOrchestrator } from './pipeline.js';
import type { ContentType } from '../types.js';

const log = logger.child('scheduler');

interface ScheduledJob {
  name: string;
  contentType: ContentType;
  intervalMs: number;
  lastRun?: Date;
  timer?: ReturnType<typeof setInterval>;
}

export class Scheduler {
  private jobs: ScheduledJob[] = [];
  private checkInterval?: ReturnType<typeof setInterval>;

  constructor(private pipeline: PipelineOrchestrator) {}

  start(): void {
    // Check every minute if a scheduled job should run
    this.checkInterval = setInterval(() => this.tick(), 60_000);
    log.info(`Scheduler started — ${this.jobs.length} jobs registered`);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    for (const job of this.jobs) {
      if (job.timer) {
        clearInterval(job.timer);
        job.timer = undefined;
      }
    }
    log.info('Scheduler stopped');
  }

  registerWeeklyRecap(): void {
    this.jobs.push({
      name: 'weekly-recap',
      contentType: 'weekly-recap',
      intervalMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    log.info('Registered weekly recap — runs Monday 12:00 PM CST');
  }

  private tick(): void {
    const now = new Date();

    for (const job of this.jobs) {
      if (this.shouldRun(job, now)) {
        job.lastRun = now;
        log.info(`Running scheduled job: ${job.name}`);

        this.pipeline.run(job.contentType, 'schedule').catch(err => {
          log.error(`Scheduled job ${job.name} failed:`, err);
        });
      }
    }
  }

  private shouldRun(job: ScheduledJob, now: Date): boolean {
    // Weekly recap: Monday at 18:00 UTC (12:00 PM CST)
    if (job.name === 'weekly-recap') {
      const isMonday = now.getUTCDay() === 1;
      const isNoon = now.getUTCHours() === 18 && now.getUTCMinutes() === 0;

      if (!isMonday || !isNoon) return false;

      // Don't run if already ran today
      if (job.lastRun) {
        const lastRunDate = job.lastRun.toISOString().split('T')[0];
        const todayDate = now.toISOString().split('T')[0];
        if (lastRunDate === todayDate) return false;
      }

      return true;
    }

    // Generic interval-based check
    if (!job.lastRun) return true;
    return now.getTime() - job.lastRun.getTime() >= job.intervalMs;
  }

  getJobs(): Array<{ name: string; contentType: ContentType; lastRun?: string }> {
    return this.jobs.map(j => ({
      name: j.name,
      contentType: j.contentType,
      lastRun: j.lastRun?.toISOString(),
    }));
  }
}
