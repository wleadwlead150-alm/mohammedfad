"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Storage } = require("@google-cloud/storage");

const sidecarEndpoint = "http://127.0.0.1:1106";
const acceptedPurposes = new Set([
  "thumbnail",
  "video",
  "attachment",
  "paymentProof",
  "file",
]);

let storageClient;

function isConfigured() {
  return Boolean(
    process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID &&
      process.env.PRIVATE_OBJECT_DIR,
  );
}

function getPrivateObjectDir() {
  if (!isConfigured()) {
    throw new Error("Replit App Storage is not configured for this environment.");
  }
  return process.env.PRIVATE_OBJECT_DIR.replace(/\/+$/, "");
}

function parseBucketPath(fullPath) {
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("The private object storage path is invalid.");
  }
  return {
    bucketName: parts[0],
    objectName: parts.slice(1).join("/"),
  };
}

function getStorageClient() {
  if (!storageClient) {
    storageClient = new Storage({
      credentials: {
        audience: "replit",
        subject_token_type: "access_token",
        token_url: `${sidecarEndpoint}/token`,
        type: "external_account",
        credential_source: {
          url: `${sidecarEndpoint}/credential`,
          format: {
            type: "json",
            subject_token_field_name: "access_token",
          },
        },
        universe_domain: "googleapis.com",
      },
      projectId: "",
    });
  }
  return storageClient;
}

function makeObjectTarget(userId, purpose, originalName) {
  if (!acceptedPurposes.has(purpose)) {
    throw new Error("Upload purpose is not allowed.");
  }
  const ext = path.extname(String(originalName || "")).toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : "";
  const entityName = `uploads/${userId}/${purpose}/${crypto.randomUUID()}${safeExt}`;
  const { bucketName, objectName } = parseBucketPath(
    `${getPrivateObjectDir()}/${entityName}`,
  );
  return {
    bucketName,
    objectName,
    objectPath: `/objects/${entityName}`,
  };
}

function getOwnedObjectTarget(objectPath, userId, purpose) {
  if (!acceptedPurposes.has(purpose)) {
    throw new Error("Upload purpose is not allowed.");
  }
  const prefix = `/objects/uploads/${Number(userId)}/${purpose}/`;
  if (typeof objectPath !== "string" || !objectPath.startsWith(prefix)) {
    throw new Error("The uploaded object does not belong to this user and upload type.");
  }
  const filename = objectPath.slice(prefix.length);
  if (!/^[a-f0-9-]{36}(?:\.[a-z0-9]{1,12})?$/i.test(filename)) {
    throw new Error("The uploaded object path is invalid.");
  }
  const { bucketName, objectName } = parseBucketPath(
    `${getPrivateObjectDir()}/${objectPath.slice("/objects/".length)}`,
  );
  return {
    bucketName,
    objectName,
    objectPath,
    file: getStorageClient().bucket(bucketName).file(objectName),
  };
}

async function signUrl({ bucketName, objectName, method, ttlSeconds }) {
  const response = await fetch(`${sidecarEndpoint}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`App Storage could not sign the upload request (${response.status}).`);
  }
  const data = await response.json();
  if (typeof data.signed_url !== "string") {
    throw new Error("App Storage returned an invalid upload URL.");
  }
  return data.signed_url;
}

async function getUploadUrl({ userId, purpose, originalName }) {
  const target = makeObjectTarget(userId, purpose, originalName);
  return {
    uploadURL: await signUrl({
      bucketName: target.bucketName,
      objectName: target.objectName,
      method: "PUT",
      ttlSeconds: 900,
    }),
    objectPath: target.objectPath,
  };
}

async function uploadLocalFile(file, userId, purpose) {
  const target = makeObjectTarget(userId, purpose, file.originalname);
  const destination = getStorageClient()
    .bucket(target.bucketName)
    .file(target.objectName);
  await pipeline(
    fs.createReadStream(file.path),
    destination.createWriteStream({
      resumable: Number(file.size) > 8 * 1024 * 1024,
      metadata: {
        contentType: file.mimetype || "application/octet-stream",
        metadata: {
          originalName: String(file.originalname || "").slice(0, 255),
        },
      },
    }),
  );
  return target.objectPath;
}

async function verifyUploadedObject({
  objectPath,
  userId,
  purpose,
  maxSize,
  expectedSize,
  originalName,
}) {
  const target = getOwnedObjectTarget(objectPath, userId, purpose);
  try {
    const [metadata] = await target.file.getMetadata();
    const size = Number(metadata.size);
    if (!Number.isFinite(size) || size < 1 || size > maxSize) {
      const tooLarge = new Error("The uploaded file is larger than the allowed limit.");
      tooLarge.statusCode = 413;
      throw tooLarge;
    }
    if (Number(expectedSize) !== size) {
      const mismatch = new Error("The uploaded file size does not match the submitted file.");
      mismatch.statusCode = 400;
      throw mismatch;
    }
    const mimeType = String(metadata.contentType || "application/octet-stream");
    if (
      !isAllowedMimeForPurpose({
        purpose,
        originalName,
        mimeType,
      })
    ) {
      const unsupported = new Error("The uploaded file type is not allowed.");
      unsupported.statusCode = 400;
      throw unsupported;
    }
    return {
      objectPath: target.objectPath,
      size,
      mimeType,
      file: target.file,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    if (Number(error.code) === 404) {
      const missing = new Error("The uploaded file was not found in App Storage.");
      missing.statusCode = 400;
      throw missing;
    }
    throw error;
  }
}

function isAllowedMimeForPurpose({ purpose, originalName, mimeType }) {
  const ext = path.extname(String(originalName || "")).toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  if (
    [".html", ".htm", ".js", ".mjs", ".cjs", ".svg", ".exe", ".dll", ".bat", ".cmd", ".sh", ".ps1", ".msi", ".com"].includes(ext) ||
    [
      "text/html",
      "application/javascript",
      "text/javascript",
      "image/svg+xml",
      "application/x-msdownload",
      "application/x-executable",
      "application/x-sh",
    ].includes(mime)
  ) {
    return false;
  }
  if (purpose === "thumbnail") return mime.startsWith("image/");
  if (purpose === "video") return mime.startsWith("video/");
  if (purpose === "attachment" || purpose === "paymentProof") {
    return mime.startsWith("image/") || mime === "application/pdf";
  }
  return true;
}

async function getObjectFile(objectPath) {
  if (typeof objectPath !== "string" || !objectPath.startsWith("/objects/uploads/")) {
    throw new Error("The stored object reference is invalid.");
  }
  const parts = objectPath.split("/");
  if (
    parts.length !== 6 ||
    parts[1] !== "objects" ||
    parts[2] !== "uploads" ||
    !/^\d+$/.test(parts[3]) ||
    !acceptedPurposes.has(parts[4]) ||
    !/^[a-f0-9-]{36}(?:\.[a-z0-9]{1,12})?$/i.test(parts[5])
  ) {
    throw new Error("The stored object reference is invalid.");
  }
  const entityName = parts.slice(2).join("/");
  const { bucketName, objectName } = parseBucketPath(
    `${getPrivateObjectDir()}/${entityName}`,
  );
  return getStorageClient().bucket(bucketName).file(objectName);
}

async function deleteObject(objectPath, userId, purpose) {
  try {
    const target = getOwnedObjectTarget(objectPath, userId, purpose);
    await target.file.delete({ ignoreNotFound: true });
  } catch {
    // A failed cleanup must not hide the original validation or database error.
  }
}

module.exports = {
  deleteObject,
  getObjectFile,
  getUploadUrl,
  isConfigured,
  uploadLocalFile,
  verifyUploadedObject,
};
