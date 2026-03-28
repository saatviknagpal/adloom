import { Client } from "minio";

const ENDPOINT = process.env.MINIO_ENDPOINT ?? "localhost";
const PORT = parseInt(process.env.MINIO_PORT ?? "9000", 10);
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "adloom";
const SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "adloom123";
const BUCKET = process.env.MINIO_BUCKET ?? "adloom-assets";

const globalForMinio = globalThis as unknown as { minioClient: Client | undefined };

function getClient(): Client {
  if (!globalForMinio.minioClient) {
    globalForMinio.minioClient = new Client({
      endPoint: ENDPOINT,
      port: PORT,
      useSSL: false,
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
    });
  }
  return globalForMinio.minioClient;
}

let bucketReady = false;

async function ensureBucket() {
  if (bucketReady) return;
  const client = getClient();
  const exists = await client.bucketExists(BUCKET);
  if (!exists) {
    await client.makeBucket(BUCKET);
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: ["*"] },
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${BUCKET}/*`],
        },
      ],
    };
    await client.setBucketPolicy(BUCKET, JSON.stringify(policy));
  }
  bucketReady = true;
}

export function getPublicUrl(key: string): string {
  return `http://${ENDPOINT}:${PORT}/${BUCKET}/${key}`;
}

/**
 * Extract the object key from a full MinIO public URL.
 * e.g. "http://localhost:9000/adloom-assets/session123/img.png" → "session123/img.png"
 */
export function extractKeyFromUri(uri: string): string {
  const prefix = `/${BUCKET}/`;
  const idx = uri.indexOf(prefix);
  if (idx !== -1) return uri.slice(idx + prefix.length);
  return uri;
}

export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  await ensureBucket();
  const client = getClient();
  await client.putObject(BUCKET, key, buffer, buffer.length, {
    "Content-Type": contentType,
  });
  return getPublicUrl(key);
}

export async function downloadBuffer(key: string): Promise<Buffer> {
  await ensureBucket();
  const client = getClient();
  const stream = await client.getObject(BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
