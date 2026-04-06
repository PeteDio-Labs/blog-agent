/**
 * Image Generator Agent
 * Generates cover images via Automatic1111 Stable Diffusion API,
 * uploads to MinIO, and returns the public URL.
 */

import { MinioClient } from '../clients/minioClient.js';
import { logger } from '../utils/logger.js';
import type { BlogDraft } from '../types.js';

const log = logger.child('image-generator');

const NEGATIVE_PROMPT =
  'text, watermark, logo, signature, blurry, low quality, ugly, distorted, jpeg artifacts, cropped';

const buildPrompt = (draft: BlogDraft): string => {
  const tags = draft.tags.slice(0, 5).join(', ');
  return (
    `professional minimal tech blog cover image for a post titled "${draft.title}", ` +
    `theme ${tags || draft.contentType}, ` +
    `dark background, neon cyan accents, clean geometric shapes, futuristic homelab aesthetic, ` +
    `no text, no logos, abstract illustrative`
  );
};

interface Txt2ImgResponse {
  images: string[]; // base64-encoded PNGs
}

export class ImageGeneratorAgent {
  private sdApiUrl: string;
  private minio: MinioClient;

  constructor(minio: MinioClient) {
    this.sdApiUrl = (process.env.SDAPI_URL || 'http://192.168.50.59:7860').replace(/\/$/, '');
    this.minio = minio;
  }

  async generate(draft: BlogDraft, postId: number): Promise<string | null> {
    try {
      const prompt = buildPrompt(draft);
      log.info(`Generating cover image for post ${postId}: "${draft.title}"`);

      const res = await fetch(`${this.sdApiUrl}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          negative_prompt: NEGATIVE_PROMPT,
          width: 1200,
          height: 630,
          steps: 20,
          cfg_scale: 7,
          sampler_name: 'DPM++ 2M Karras',
        }),
      });

      if (!res.ok) {
        log.warn(`SD API returned ${res.status} for post ${postId}`);
        return null;
      }

      const data = (await res.json()) as Txt2ImgResponse;
      const b64 = data.images?.[0];

      if (!b64) {
        log.warn(`No image data returned from SD API for post ${postId}`);
        return null;
      }

      const imageBuffer = Buffer.from(b64, 'base64');
      return await this.minio.uploadImage(postId, imageBuffer);
    } catch (err) {
      log.warn(`Cover image generation failed for post ${postId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
