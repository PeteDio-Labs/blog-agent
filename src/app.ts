/**
 * Express Application
 * Configures middleware and mounts routes.
 */

import express from 'express';
import type { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { logger } from './utils/logger.js';
import { createRoutes } from './api/routes/index.js';
import type { PipelineOrchestrator } from './services/pipeline.js';
import type { LLMProvider } from './providers/llm.js';

export function createApp(pipeline: PipelineOrchestrator, llmProvider: LLMProvider): Application {
  const app: Application = express();

  // Morgan HTTP logger integration with Pino
  const morganStream = {
    write: (message: string) => logger.info(message.trim()),
  };

  // Middleware
  app.use(helmet());
  app.use(
    cors({
      origin: process.env.CORS_ORIGINS?.split(',') || '*',
      credentials: true,
    })
  );
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan('combined', { stream: morganStream }));

  // Root endpoint
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'Blog Agent API',
      version: '1.0.0',
      status: 'running',
      timestamp: new Date().toISOString(),
    });
  });

  // Routes
  app.use(createRoutes(pipeline, llmProvider));

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      path: req.path,
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  });

  return app;
}
