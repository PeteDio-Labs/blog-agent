/**
 * Blog API Client
 * Interacts with the Spring Boot blog-api admin endpoints for draft CRUD.
 */

import { fetchWithRetry } from '@petedio/shared';
import { logger } from '../utils/logger.js';
import type { BlogPostRequest, BlogPostResponse } from '../types.js';

type BlogPostUpdate = Partial<BlogPostRequest> & { coverImageUrl?: string | null };

const log = logger.child('blog-api-client');

export class BlogApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async createDraft(post: BlogPostRequest): Promise<BlogPostResponse> {
    log.info(`Creating draft: "${post.title}"`);
    const res = await fetchWithRetry(`${this.baseUrl}/api/v1/admin/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(post),
    }, { onRetry: (n, e) => log.warn(`POST /admin/posts retry ${n}: ${e instanceof Error ? e.message : e}`) });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Blog API POST /admin/posts failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<BlogPostResponse>;
  }

  async updatePost(id: number, update: BlogPostUpdate): Promise<BlogPostResponse> {
    log.info(`Updating post ${id}`);
    const res = await fetchWithRetry(`${this.baseUrl}/api/v1/admin/posts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Blog API PUT /admin/posts/${id} failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<BlogPostResponse>;
  }

  async getPost(id: number): Promise<BlogPostResponse> {
    const res = await fetchWithRetry(`${this.baseUrl}/api/v1/admin/posts/${id}`, {});

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Blog API GET /admin/posts/${id} failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<BlogPostResponse>;
  }

  async listDrafts(page = 0, size = 20): Promise<BlogPostResponse[]> {
    const params = new URLSearchParams({
      status: 'DRAFT',
      page: String(page),
      size: String(size),
    });

    const res = await fetchWithRetry(`${this.baseUrl}/api/v1/admin/posts?${params}`, {});

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Blog API GET /admin/posts failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { content: BlogPostResponse[] };
    return data.content;
  }

  async publishPost(id: number): Promise<BlogPostResponse> {
    log.info(`Publishing post ${id}`);
    return this.updatePost(id, { status: 'PUBLISHED' });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
