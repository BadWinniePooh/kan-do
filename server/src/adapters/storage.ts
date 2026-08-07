/** Object storage behind an interface so domain/services never see the SDK. */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export interface ObjectStorage {
  presignUpload(key: string, contentType: string): Promise<string>;
  presignDownload(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  healthy(): Promise<boolean>;
  ensureBucket(): Promise<void>;
}

function client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.s3.region,
    forcePathStyle: true, // MinIO
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  });
}

export function createS3Storage(): ObjectStorage {
  const internal = client(config.s3.endpoint);
  // presigned URLs are fetched by the browser -> sign against public endpoint
  const publicClient = client(config.s3.publicEndpoint);
  const Bucket = config.s3.bucket;

  return {
    async presignUpload(key, contentType) {
      return getSignedUrl(publicClient, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn: 600 });
    },
    async presignDownload(key) {
      return getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: 3600 });
    },
    async delete(key) {
      await internal.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async healthy() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket }));
        return true;
      } catch {
        return false;
      }
    },
    async ensureBucket() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await internal.send(new CreateBucketCommand({ Bucket }));
      }
    },
  };
}
