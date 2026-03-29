import { logger } from '../utils/logger.js';

const log = logger.child('rag-client');

export interface RagChunk {
  id: number;
  postId: number | null;
  sourceType: string;
  sourceRef: string;
  chunkIndex: number;
  chunkText: string;
  similarity: number;
}

export class RagClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async query(opts: {
    query: string;
    topK?: number;
    sourceTypes?: Array<'post' | 'session' | 'doc'>;
  }): Promise<RagChunk[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/rag/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`RAG query failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { results: RagChunk[]; count: number };
    log.debug(`RAG query returned ${data.count} chunks`);
    return data.results;
  }

  async ingest(opts: {
    postId?: number;
    text: string;
    sourceType: 'post' | 'session' | 'doc';
    sourceRef: string;
  }): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/v1/rag/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`RAG ingest failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { chunks: number };
    return data.chunks;
  }
}
