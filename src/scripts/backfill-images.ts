/**
 * Backfill cover images for existing published posts that have no cover image.
 *
 * Usage:
 *   # 1. Port-forward blog-api
 *   kubectl port-forward -n blog-dev svc/blog-api 8080:8080
 *
 *   # 2. Run (env vars must be set or sourced from .env)
 *   BLOG_API_URL=http://localhost:8080 bun run src/scripts/backfill-images.ts
 *
 * Optional:
 *   DRY_RUN=true   — log which posts would be processed, skip generation
 *   DELAY_MS=3000  — ms between Gemini requests (default: 3000)
 */

import 'dotenv/config';
import { MinioClient } from '../clients/minioClient.js';
import { ImageGeneratorAgent } from '../agents/imageGenerator.js';
import type { BlogDraft, ContentType } from '../types.js';

const BLOG_API_URL = process.env.BLOG_API_URL || 'http://localhost:8080';
const DRY_RUN = process.env.DRY_RUN === 'true';
const DELAY_MS = parseInt(process.env.DELAY_MS || '3000', 10);

interface PostSummary {
  id: number;
  title: string;
  slug: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  tags: Array<{ name: string }>;
}

interface ListResponse {
  data: PostSummary[];
  pagination: { totalElements: number; totalPages: number };
}

async function listPostsMissingImages(): Promise<PostSummary[]> {
  const missing: PostSummary[] = [];
  let page = 0;
  const size = 20;

  while (true) {
    const params = new URLSearchParams({ status: 'PUBLISHED', page: String(page), size: String(size) });
    const res = await fetch(`${BLOG_API_URL}/api/v1/admin/posts?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`Failed to list posts (${res.status}): ${await res.text()}`);

    const data = await res.json() as ListResponse;
    const posts = data.data ?? [];

    for (const post of posts) {
      if (!post.coverImageUrl) missing.push(post);
    }

    page++;
    if (posts.length < size) break;
  }

  return missing;
}

async function updatePostImage(postId: number, imageUrl: string): Promise<void> {
  const res = await fetch(`${BLOG_API_URL}/api/v1/admin/posts/${postId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coverImageUrl: imageUrl }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Failed to update post ${postId} (${res.status}): ${await res.text()}`);
}

function toDraft(post: PostSummary): BlogDraft {
  return {
    title: post.title,
    slug: post.slug,
    content: '',
    excerpt: post.excerpt ?? '',
    tags: post.tags.map(t => t.name),
    contentType: 'how-to' as ContentType, // best-effort default for prompt context
    frontmatter: {},
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log(`Blog API : ${BLOG_API_URL}`);
  console.log(`Dry run  : ${DRY_RUN}`);
  console.log(`Delay    : ${DELAY_MS}ms between requests\n`);

  // Pre-flight
  const health = await fetch(`${BLOG_API_URL}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!health?.ok) {
    console.error('Blog API not reachable. Run: kubectl port-forward -n blog-dev svc/blog-api 8080:8080');
    process.exit(1);
  }

  const posts = await listPostsMissingImages();
  console.log(`Found ${posts.length} published post(s) without a cover image.\n`);

  if (posts.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    for (const post of posts) {
      console.log(`  [dry] ${post.id} — "${post.title}"`);
    }
    return;
  }

  const minio = new MinioClient();
  const generator = new ImageGeneratorAgent(minio);

  let succeeded = 0;
  let failed = 0;

  for (const post of posts) {
    console.log(`[${succeeded + failed + 1}/${posts.length}] Generating image for post ${post.id}: "${post.title}"`);

    const imageUrl = await generator.generate(toDraft(post), post.id);

    if (imageUrl) {
      await updatePostImage(post.id, imageUrl);
      console.log(`  ✓ ${imageUrl}`);
      succeeded++;
    } else {
      console.log(`  ✗ Generation failed — skipping`);
      failed++;
    }

    if (succeeded + failed < posts.length) await sleep(DELAY_MS);
  }

  console.log(`\nDone: ${succeeded} succeeded, ${failed} failed.`);
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
