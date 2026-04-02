/**
 * MinIO S3 Client
 * Uploads images to the blog-images bucket and returns public URLs.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

const log = logger.child('minio-client');

export class MinioClient {
  private s3: S3Client;
  private bucket: string;
  private publicUrl: string;

  constructor() {
    const endpoint = process.env.MINIO_ENDPOINT;
    const accessKeyId = process.env.MINIO_ACCESS_KEY;
    const secretAccessKey = process.env.MINIO_SECRET_KEY;
    this.bucket = process.env.MINIO_BUCKET || 'blog-images';
    this.publicUrl = (process.env.MINIO_PUBLIC_URL || '').replace(/\/$/, '');

    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error('MinIO config missing: MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY required');
    }

    this.s3 = new S3Client({
      endpoint,
      region: 'us-east-1', // MinIO ignores region but SDK requires it
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true, // required for MinIO
    });
  }

  async uploadImage(postId: number, imageBuffer: Buffer): Promise<string> {
    const key = `${postId}-${randomUUID()}.png`;

    log.info(`Uploading cover image for post ${postId} → ${this.bucket}/${key}`);

    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: imageBuffer,
      ContentType: 'image/png',
    }));

    const url = `${this.publicUrl}/${this.bucket}/${key}`;
    log.info(`Cover image uploaded: ${url}`);
    return url;
  }
}
