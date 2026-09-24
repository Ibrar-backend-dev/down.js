// Storage backend for downloaded files: Backblaze B2 (via its S3-compatible
// API) when configured, otherwise the local downloads directory. B2 is
// primary when its env vars are set - local disk is only the fallback, not
// a supplement - so callers don't need to know which backend is active.
const fs = require('fs-extra');

function getB2Config() {
  const { B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION } = process.env;
  if (!B2_KEY_ID || !B2_APPLICATION_KEY || !B2_BUCKET || !B2_ENDPOINT) {
    return null;
  }
  return {
    keyId: B2_KEY_ID,
    applicationKey: B2_APPLICATION_KEY,
    bucket: B2_BUCKET,
    endpoint: B2_ENDPOINT,
    region: B2_REGION || 'us-west-002'
  };
}

function isB2Enabled() {
  return getB2Config() !== null;
}

let cachedClient = null;

function getS3Client() {
  if (cachedClient) return cachedClient;
  const config = getB2Config();
  if (!config) {
    throw new Error('B2 storage is not configured');
  }
  const { S3Client } = require('@aws-sdk/client-s3');
  cachedClient = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.keyId,
      secretAccessKey: config.applicationKey
    },
    // Backblaze's S3-compatible endpoint expects path-style bucket addressing.
    forcePathStyle: true
  });
  return cachedClient;
}

// Uploads a local file to B2 under `key` as a single streamed PutObject
// (well within B2/S3's 5GB single-PUT limit for any realistic downloaded
// video) and returns the object's size.
async function uploadFile(localFilePath, key, options = {}) {
  const config = getB2Config();
  if (!config) {
    throw new Error('B2 storage is not configured');
  }
  const client = options.client || getS3Client();
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const stats = await fs.stat(localFilePath);

  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: fs.createReadStream(localFilePath),
    ContentLength: stats.size,
    ContentType: 'application/octet-stream'
  }));

  return { key, size: stats.size };
}

// Returns [{ name, size, createdAt, modifiedAt }] to match the shape the
// local-disk listing has always returned.
async function listFiles(options = {}) {
  const config = getB2Config();
  if (!config) {
    throw new Error('B2 storage is not configured');
  }
  const client = options.client || getS3Client();
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

  const objects = [];
  let continuationToken;
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      ContinuationToken: continuationToken
    }));
    for (const obj of result.Contents || []) {
      objects.push({
        name: obj.Key,
        size: obj.Size,
        createdAt: obj.LastModified,
        modifiedAt: obj.LastModified
      });
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

async function deleteFile(key, options = {}) {
  const config = getB2Config();
  if (!config) {
    throw new Error('B2 storage is not configured');
  }
  const client = options.client || getS3Client();
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

module.exports = {
  getB2Config,
  isB2Enabled,
  getS3Client,
  uploadFile,
  listFiles,
  deleteFile
};
