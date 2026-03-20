/**
 * Logger utility with Pino for structured JSON logging
 * Matches notification-service / web-search-service Logger pattern
 */

import pino, { type Logger as PinoLogger } from 'pino';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
  silent: LogLevel.SILENT,
};

const levelToPino: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
  [LogLevel.SILENT]: 'silent',
};

const pinoToLevel: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
  silent: LogLevel.SILENT,
};

export class Logger {
  private pino: PinoLogger;

  constructor(level?: LogLevel, prefix?: string) {
    const pinoLevel = level !== undefined ? levelToPino[level] : getLogLevel();

    this.pino = pino({
      level: pinoLevel,
      name: prefix || 'blog-agent',
      transport: process.env.NODE_ENV !== 'production' ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      } : undefined,
    });
  }

  debug(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pino.debug({ args }, message);
    } else {
      this.pino.debug(message);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pino.info({ args }, message);
    } else {
      this.pino.info(message);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pino.warn({ args }, message);
    } else {
      this.pino.warn(message);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pino.error({ args }, message);
    } else {
      this.pino.error(message);
    }
  }

  raw(message: string): void {
    // eslint-disable-next-line no-console
    console.log(message);
  }

  child(prefix: string): Logger {
    const child = new Logger();
    child.pino = this.pino.child({ name: prefix });
    return child;
  }

  getLevel(): LogLevel {
    const currentLevel = this.pino.level;
    return pinoToLevel[currentLevel] ?? LogLevel.INFO;
  }
}

function parseLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();

  if (envLevel && envLevel in LOG_LEVEL_MAP) {
    return LOG_LEVEL_MAP[envLevel]!;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  return isProduction ? LogLevel.INFO : LogLevel.DEBUG;
}

function getLogLevel(): string {
  const level = parseLogLevel();
  return levelToPino[level]!;
}

export const logger = new Logger(parseLogLevel());

export default logger;
