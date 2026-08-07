const { Readable } = require("node:stream");
const { readR2Config } = require("../src/modules/seamless/config");
const r2Storage = require("../src/modules/seamless/services/r2StorageService");
const fileStorage = require("../src/modules/seamless/services/fileStorageService");

const R2_ENV_KEYS = [
  "SEAMLESS_R2_ENDPOINT",
  "SEAMLESS_R2_ACCESS_KEY_ID",
  "SEAMLESS_R2_SECRET_ACCESS_KEY",
  "SEAMLESS_R2_BUCKET",
  "SHOPEE_R2_BUCKET",
];
const originalEnv = Object.fromEntries(R2_ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of R2_ENV_KEYS) {
    if (typeof originalEnv[key] === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
}

function configureR2() {
  process.env.SEAMLESS_R2_ENDPOINT = "https://r2.example.test";
  process.env.SEAMLESS_R2_ACCESS_KEY_ID = "test-access-key";
  process.env.SEAMLESS_R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.SEAMLESS_R2_BUCKET = "default-bucket";
  process.env.SHOPEE_R2_BUCKET = "shopee-bucket";
}

function installR2Recorder() {
  const calls = [];
  const originals = {
    uploadBuffer: r2Storage.uploadBuffer,
    getObjectBuffer: r2Storage.getObjectBuffer,
    getObjectStream: r2Storage.getObjectStream,
    buildKey: r2Storage.buildKey,
  };

  r2Storage.uploadBuffer = async (key, _buffer, _mimeType, bucket) => {
    calls.push({ op: "upload", Bucket: bucket || readR2Config().bucket, Key: key });
  };
  r2Storage.getObjectBuffer = async (key, bucket) => {
    calls.push({ op: "getBuffer", Bucket: bucket || readR2Config().bucket, Key: key });
    return Buffer.from("file-content");
  };
  r2Storage.getObjectStream = async (key, bucket) => {
    calls.push({ op: "getStream", Bucket: bucket || readR2Config().bucket, Key: key });
    return Readable.from([Buffer.from("file-content")]);
  };
  r2Storage.buildKey = (kind, uniqueName) => `prefix/${kind}/${uniqueName}`;

  return {
    calls,
    restore() {
      Object.assign(r2Storage, originals);
    },
  };
}

function shopeeStorageOptionsFor(requestedVariant) {
  const { shopeeBucket } = readR2Config();
  return requestedVariant === "shopee" && shopeeBucket
    ? { bucket: shopeeBucket }
    : undefined;
}

beforeEach(configureR2);
afterAll(restoreEnv);

test("reads SHOPEE_R2_BUCKET separately from the default Seamless bucket", () => {
  expect(readR2Config()).toEqual(
    expect.objectContaining({
      bucket: "default-bucket",
      shopeeBucket: "shopee-bucket",
    }),
  );
});

test("writeStoredFile routes an override and records the actual bucket", async () => {
  const recorder = installR2Recorder();
  try {
    const overridden = await fileStorage.writeStoredFile(
      "processed_xlsx",
      "shopee.xlsx",
      Buffer.from("x"),
      { bucket: "shopee-bucket" },
    );
    const standard = await fileStorage.writeStoredFile(
      "processed_xlsx",
      "standard.xlsx",
      Buffer.from("y"),
    );

    expect(recorder.calls.map((call) => call.Bucket)).toEqual([
      "shopee-bucket",
      "default-bucket",
    ]);
    expect(overridden.storageBucket).toBe("shopee-bucket");
    expect(standard.storageBucket).toBe("default-bucket");
  } finally {
    recorder.restore();
  }
});

test("readStoredFile and createStoredFileStream honor a persisted per-file bucket", async () => {
  const recorder = installR2Recorder();
  try {
    await fileStorage.readStoredFile("r2", "legacy-key");
    await fileStorage.readStoredFile("r2", "shopee-key", "shopee-bucket");
    await fileStorage.createStoredFileStream("r2", "shopee-stream", "shopee-bucket");

    expect(recorder.calls.map((call) => call.Bucket)).toEqual([
      "default-bucket",
      "shopee-bucket",
      "shopee-bucket",
    ]);
  } finally {
    recorder.restore();
  }
});

test("unset SHOPEE_R2_BUCKET falls back, while non-Shopee modes never get the override", () => {
  expect(shopeeStorageOptionsFor("shopee")).toEqual({ bucket: "shopee-bucket" });
  expect(shopeeStorageOptionsFor("individual")).toBeUndefined();
  expect(shopeeStorageOptionsFor("summary")).toBeUndefined();

  delete process.env.SHOPEE_R2_BUCKET;
  expect(shopeeStorageOptionsFor("shopee")).toBeUndefined();
});

test("the bucket recorded at write time is reused for the read round-trip", async () => {
  const recorder = installR2Recorder();
  try {
    const written = await fileStorage.writeStoredFile(
      "processed_xlsx",
      "roundtrip.xlsx",
      Buffer.from("roundtrip"),
      { bucket: "shopee-bucket" },
    );
    await fileStorage.readStoredFile(
      written.storageProvider,
      written.storagePath,
      written.storageBucket,
    );

    expect(recorder.calls[1].Bucket).toBe("shopee-bucket");
    expect(recorder.calls[1].Bucket).toBe(written.storageBucket);
  } finally {
    recorder.restore();
  }
});
