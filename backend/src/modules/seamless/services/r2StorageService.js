const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { readR2Config } = require("../config");

function buildClient() {
  const r2 = readR2Config();
  const configured = !!(r2.endpoint && r2.accessKeyId && r2.secretAccessKey && r2.bucket);

  if (!configured) {
    return { configured: false, client: null, r2 };
  }

  return {
    configured: true,
    r2,
    client: new S3Client({
      region: "auto",
      endpoint: r2.endpoint,
      forcePathStyle: r2.forcePathStyle,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    }),
  };
}

// Re-evaluated on every access (not cached at require time) so tests can toggle env vars
// between cases without needing to re-require the module.
Object.defineProperty(module.exports, "r2Configured", {
  get() {
    return buildClient().configured;
  },
});

function buildKey(kind, uniqueName) {
  const { r2 } = buildClient();
  const prefix = r2.keyPrefix.replace(/^\/+|\/+$/g, "");
  return `${prefix}/${kind}/${uniqueName}`;
}

async function uploadBuffer(key, buffer, mimeType) {
  const { client, r2 } = buildClient();
  await client.send(
    new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType || "application/octet-stream",
    }),
  );
}

async function getObjectStream(key) {
  const { client, r2 } = buildClient();
  const result = await client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
  return result.Body;
}

async function getObjectBuffer(key) {
  const stream = await getObjectStream(key);
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

module.exports.buildKey = buildKey;
module.exports.getObjectBuffer = getObjectBuffer;
module.exports.getObjectStream = getObjectStream;
module.exports.uploadBuffer = uploadBuffer;
