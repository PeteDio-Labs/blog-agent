/**
 * Blog Agent Entry Point
 */

import 'dotenv/config';
import { createApp } from './app.js';
import { ContextAgent } from './agents/context.js';
import { WriterAgent } from './agents/writer.js';
import { ReviewAgent } from './agents/review.js';
import { createLLMProvider } from './providers/index.js';
import { PipelineOrchestrator } from './services/pipeline.js';
import { Scheduler } from './services/scheduler.js';
import { EventListener } from './services/eventListener.js';
import { BlogApiClient } from './clients/blogApi.js';
import { NotificationServiceClient } from './clients/notificationService.js';
import { MCBackendClient } from './clients/mcBackend.js';
import { RagClient } from './clients/ragClient.js';
import { MinioClient } from './clients/minioClient.js';
import { ImageGeneratorAgent } from './agents/imageGenerator.js';
import { appUp } from './metrics/index.js';
import { logger } from './utils/logger.js';

const PORT = parseInt(process.env.PORT || '3004', 10);

const BLOG_API_URL = process.env.BLOG_API_URL || 'http://blog-api.blog-dev.svc.cluster.local:8080';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service.mission-control.svc.cluster.local:3002';
const MC_BACKEND_URL = process.env.MC_BACKEND_URL || 'http://mission-control-backend.mission-control.svc.cluster.local:3000';
const BLOG_URL = process.env.BLOG_URL || 'http://192.168.50.241';

let llmProvider;

try {
  llmProvider = createLLMProvider();
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Initialize clients
const blogApi = new BlogApiClient(BLOG_API_URL);
const notifications = new NotificationServiceClient(NOTIFICATION_SERVICE_URL);
const mcBackend = new MCBackendClient(MC_BACKEND_URL);
const ragClient = new RagClient(BLOG_API_URL);

// Initialize agents
const contextAgent = new ContextAgent(mcBackend, notifications, ragClient);
const writerAgent = new WriterAgent(llmProvider);
const reviewAgent = new ReviewAgent(llmProvider);

// Initialize image generator (optional — skipped if env vars missing)
let imageGenerator: ImageGeneratorAgent | undefined;
try {
  const minio = new MinioClient();
  imageGenerator = new ImageGeneratorAgent(minio);
  logger.info('Image generator initialized (NanoBanana 2 + MinIO)');
} catch (err) {
  logger.warn(`Image generator disabled: ${err instanceof Error ? err.message : String(err)}`);
}

// Initialize pipeline
const pipeline = new PipelineOrchestrator(
  contextAgent,
  writerAgent,
  reviewAgent,
  blogApi,
  notifications,
  BLOG_URL,
  imageGenerator,
);

// Initialize scheduler
const scheduler = new Scheduler(pipeline);
scheduler.registerWeeklyRecap();

// Initialize event listener (SSE → deploy changelogs)
const eventListener = new EventListener(MC_BACKEND_URL, pipeline);

// Create Express app
const app = createApp(pipeline, llmProvider);

// Start server
app.listen(PORT, () => {
  appUp.set(1);
  scheduler.start();
  eventListener.start();

  logger.raw('');
  logger.raw('═══════════════════════════════════════════════════════');
  logger.raw('  Blog Agent v1.0.0');
  logger.raw(`  Started: ${new Date().toISOString()}`);
  logger.raw(`  Port: ${PORT}`);
  logger.raw(`  Blog API: ${BLOG_API_URL}`);
  logger.raw(`  Notifications: ${NOTIFICATION_SERVICE_URL}`);
  logger.raw(`  MC Backend: ${MC_BACKEND_URL}`);
  logger.raw(`  LLM: ${llmProvider.name}`);
  logger.raw(`  Scheduler: ${scheduler.getJobs().length} jobs`);
  logger.raw(`  Event Listener: SSE → deploy changelogs (2m debounce)`);
  logger.raw('═══════════════════════════════════════════════════════');
  logger.raw('');
});
