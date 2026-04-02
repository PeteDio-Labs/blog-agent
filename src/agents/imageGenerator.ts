/**
 * Image Generator Agent
 * Generates cover images via NanoBanana 2 (Gemini Flash image generation),
 * uploads to MinIO, and returns the public URL.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { MinioClient } from '../clients/minioClient.js';
import { logger } from '../utils/logger.js';
import type { BlogDraft } from '../types.js';

const log = logger.child('image-generator');

const IMAGE_MODEL = 'gemini-2.0-flash-preview-image-generation';

const PROMPT_TEMPLATE = (draft: BlogDraft): string => {
  const tags = draft.tags.slice(0, 5).join(', ');
  return (
    `A professional, minimal tech blog cover image for a post titled "${draft.title}". ` +
    `Theme: ${tags || draft.contentType}. ` +
    `Style: dark background, neon cyan accents, clean geometric shapes, futuristic homelab aesthetic. ` +
    `No text. No logos. Abstract and illustrative only.`
  );
};

export class ImageGeneratorAgent {
  private genai: GoogleGenerativeAI;
  private minio: MinioClient;

  constructor(minio: MinioClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is required for image generation');
    this.genai = new GoogleGenerativeAI(apiKey);
    this.minio = minio;
  }

  async generate(draft: BlogDraft, postId: number): Promise<string | null> {
    try {
      const prompt = PROMPT_TEMPLATE(draft);
      log.info(`Generating cover image for post ${postId}: "${draft.title}"`);

      const model = this.genai.getGenerativeModel({
        model: IMAGE_MODEL,
        generationConfig: {
          // @ts-expect-error — responseModalities is not yet in the type defs for all SDK versions
          responseModalities: ['IMAGE'],
        },
      });

      const result = await model.generateContent(prompt);
      const parts = result.response.candidates?.[0]?.content?.parts ?? [];

      const imagePart = parts.find(
        (p: { inlineData?: { mimeType?: string; data?: string } }) =>
          p.inlineData?.mimeType?.startsWith('image/'),
      );

      if (!imagePart?.inlineData?.data) {
        log.warn(`No image data returned from Gemini for post ${postId}`);
        return null;
      }

      const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
      return await this.minio.uploadImage(postId, imageBuffer);
    } catch (err) {
      log.warn(`Cover image generation failed for post ${postId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
