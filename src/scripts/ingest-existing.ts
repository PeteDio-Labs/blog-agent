/**
 * One-shot RAG ingestion script.
 * Run with: bun run src/scripts/ingest-existing.ts
 *
 * Ingests:
 *   1. All PUBLISHED blog posts via blog-api admin endpoint
 *   2. All session summaries from docs/sessions/
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { RagClient } from '../clients/ragClient.js';

const BLOG_API_URL = process.env.BLOG_API_URL || 'http://localhost:8080';
const DOCS_PATH = process.env.DOCS_PATH || join(process.cwd(), '..', '..', '..', 'docs');

const rag = new RagClient(BLOG_API_URL);

async function ingestPosts(): Promise<void> {
  console.log('=== Ingesting published blog posts ===');

  let page = 0;
  const size = 20;
  let total = 0;
  let ingested = 0;

  while (true) {
    const params = new URLSearchParams({ status: 'PUBLISHED', page: String(page), size: String(size) });
    const res = await fetch(`${BLOG_API_URL}/api/v1/admin/posts?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`Failed to list posts: ${res.status}`);

    const data = await res.json() as { data: Array<{ id: number; title: string; slug: string; content: string; excerpt?: string }>; pagination: { total: number } };
    const posts = data.data ?? [];
    if (page === 0) total = data.pagination?.total ?? posts.length;

    if (posts.length === 0) break;

    for (const post of posts) {
      const text = [post.title, post.excerpt, post.content].filter(Boolean).join('\n\n');
      const chunks = await rag.ingest({ postId: post.id, text, sourceType: 'post', sourceRef: post.slug });
      console.log(`  ✓ [${post.id}] "${post.title}" — ${chunks} chunks`);
      ingested++;
    }

    page++;
    if (posts.length < size) break;
  }

  console.log(`Posts: ${ingested}/${total} ingested\n`);
}

async function ingestSessions(): Promise<void> {
  console.log('=== Ingesting session summaries ===');

  const sessionsDir = join(DOCS_PATH, 'sessions');
  let files: string[];

  try {
    files = (await readdir(sessionsDir))
      .filter(f => f.endsWith('.md') && f.startsWith('SESSION-SUMMARY-'))
      .sort();
  } catch {
    console.log('  Sessions dir not found, skipping');
    return;
  }

  let ingested = 0;
  for (const file of files) {
    const text = await readFile(join(sessionsDir, file), 'utf8');
    const chunks = await rag.ingest({ text, sourceType: 'session', sourceRef: basename(file, '.md') });
    console.log(`  ✓ ${file} — ${chunks} chunks`);
    ingested++;
  }

  console.log(`Sessions: ${ingested}/${files.length} ingested\n`);
}

async function main(): Promise<void> {
  console.log(`Blog API: ${BLOG_API_URL}`);
  console.log(`Docs: ${DOCS_PATH}\n`);

  // Verify RAG endpoint is reachable
  const health = await fetch(`${BLOG_API_URL}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!health?.ok) {
    console.error('Blog API not reachable. Make sure port-forward is active: kubectl port-forward -n blog-dev svc/blog-api 8080:8080');
    process.exit(1);
  }

  await ingestPosts();
  await ingestSessions();

  console.log('=== Ingest complete ===');
}

main().catch((err) => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
