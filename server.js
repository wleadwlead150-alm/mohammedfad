"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const objectStorage = require("./lib/objectStorage");

const app = express();
const port = Number(process.env.PORT || 3000);
const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const configuredUploadsDir = process.env.UPLOADS_DIR?.trim();
const uploadsDir = path.resolve(configuredUploadsDir || path.join(rootDir, "uploads"));
const stagingDir = path.join(os.tmpdir(), "fadil-trading-staging");
const usesAppStorage = objectStorage.isConfigured();
const uploadStorageDir = usesAppStorage ? stagingDir : uploadsDir;
const sessionDays = 14;
const sessionCookie = "ft_session";
const sessionDurationMs = sessionDays * 24 * 60 * 60 * 1000;
const scrypt = promisify(crypto.scrypt);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.");
  process.exit(1);
}

if (
  process.env.NODE_ENV === "production" &&
  !usesAppStorage &&
  !configuredUploadsDir
) {
  console.error(
    "Production uploads require Replit App Storage or UPLOADS_DIR pointing to a persistent mounted volume.",
  );
  process.exit(1);
}

fs.mkdirSync(uploadStorageDir, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl:
    process.env.PGSSLMODE === "require"
      ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

app.use(
  "/api",
  cors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean)
      : false,
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

function sqlIdentifierSafe(value) {
  return /^[a-z_]+$/.test(value);
}

async function initDatabase() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
      is_subscribed BOOLEAN NOT NULL DEFAULT FALSE,
      activated_at TIMESTAMPTZ,
      session_token_hash TEXT,
      session_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      thumbnail_path TEXT,
      attachment_path TEXT,
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      is_free BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (title, category)
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      video_url TEXT,
      video_path TEXT,
      attachment_path TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS resources (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS quiz_files (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS result_files (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS progress (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'completed')),
      watched_seconds INTEGER NOT NULL DEFAULT 0 CHECK (watched_seconds >= 0),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, lesson_id)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL DEFAULT 'standard',
      payment_proof TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL CHECK (sender_role IN ('student', 'admin')),
      body TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      category TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      attachment_path TEXT,
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS courses_published_created_idx
      ON courses (is_published, created_at DESC);
    CREATE INDEX IF NOT EXISTS lessons_course_created_idx
      ON lessons (course_id, created_at, id);
    CREATE INDEX IF NOT EXISTS resources_course_idx ON resources (course_id);
    CREATE INDEX IF NOT EXISTS progress_user_idx ON progress (user_id);
    CREATE INDEX IF NOT EXISTS subscriptions_user_created_idx
      ON subscriptions (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS subscriptions_status_created_idx
      ON subscriptions (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS messages_user_created_idx
      ON messages (user_id, created_at, id);
    CREATE INDEX IF NOT EXISTS news_published_created_idx
      ON news (is_published, created_at DESC);
    CREATE INDEX IF NOT EXISTS analyses_published_created_idx
      ON analyses (is_published, created_at DESC);
  `;

  await pool.query(schema);

  const adminPassword =
    process.env.ADMIN_PASSWORD ||
    (process.env.NODE_ENV === "production" ? "" : "123456");
  if (!adminPassword || adminPassword.length < 8) {
    throw new Error(
      "Set ADMIN_PASSWORD to at least 8 characters before starting in production.",
    );
  }

  const adminPasswordHash = await hashPassword(adminPassword);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_subscribed, activated_at)
     VALUES ($1, $2, $3, 'admin', TRUE, NOW())
     ON CONFLICT (email) DO UPDATE
     SET name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         role = 'admin'`,
    ["مدير FADIL TRADING", "admin@fadilschool.local", adminPasswordHash],
  );

  const defaultCourses = [
    [
      "مدخل إلى عالم التداول",
      "دورة مجانية للتعرّف على المصطلحات الأساسية، قراءة الشموع، وكيفية استخدام المنصة التعليمية.",
      "Fundamentals",
      true,
    ],
    [
      "منهج SMC / ICT",
      "دراسة بنية السوق والسيولة ومناطق الاهتمام ضمن منهج منظم.",
      "SMC / ICT",
      false,
    ],
    [
      "التحليل الهارمونيك",
      "مبادئ النماذج التوافقية والنسب السعرية وطرق قراءة الحركة.",
      "Harmonic",
      false,
    ],
    [
      "أساسيات التداول",
      "مفاهيم السوق وأنواع الأوامر وخطوات بناء خطة تداول.",
      "Fundamentals",
      false,
    ],
    [
      "إدارة رأس المال والمخاطر",
      "التخطيط للمخاطر وحجم الصفقة والانضباط في إدارة رأس المال.",
      "Capital Management",
      false,
    ],
    [
      "الكتيبات والكتب التعليمية",
      "مجموعة موارد تعليمية وملفات مراجعة يضيفها فريق الأكاديمية.",
      "Resources",
      false,
    ],
  ];

  for (const [title, description, category, isFree] of defaultCourses) {
    await pool.query(
      `INSERT INTO courses (title, description, category, is_published, is_free)
       VALUES ($1, $2, $3, TRUE, $4)
       ON CONFLICT (title, category) DO NOTHING`,
      [title, description, category, isFree],
    );
  }

  console.log("Database schema ready: 11 tables; admin and starter courses seeded.");
}

async function migrateLegacyUploads() {
  if (!usesAppStorage) return;
  const legacyFiles = await pool.query(`
    SELECT 'courses'::text AS table_name, id AS row_id,
           'thumbnail_path'::text AS column_name, thumbnail_path AS file_path,
           'thumbnail'::text AS purpose, thumbnail_path AS original_name,
           NULL::text AS mime_type
    FROM courses WHERE thumbnail_path IS NOT NULL AND thumbnail_path NOT LIKE '/objects/%'
    UNION ALL
    SELECT 'courses', id, 'attachment_path', attachment_path, 'attachment',
           attachment_path, NULL::text
    FROM courses WHERE attachment_path IS NOT NULL AND attachment_path NOT LIKE '/objects/%'
    UNION ALL
    SELECT 'lessons', id, 'video_path', video_path, 'video',
           video_path, NULL::text
    FROM lessons WHERE video_path IS NOT NULL AND video_path NOT LIKE '/objects/%'
    UNION ALL
    SELECT 'lessons', id, 'attachment_path', attachment_path, 'attachment',
           attachment_path, NULL::text
    FROM lessons WHERE attachment_path IS NOT NULL AND attachment_path NOT LIKE '/objects/%'
    UNION ALL
    SELECT 'resources', id, 'file_path', file_path, 'file',
           COALESCE(original_name, file_path), mime_type
    FROM resources WHERE file_path IS NOT NULL AND file_path NOT LIKE '/objects/%'
    UNION ALL
    SELECT 'quiz_files', id, 'file_path', file_path, 'file',
           COALESCE(original_name, file_path), mime_type
    FROM quiz_files WHERE file_path IS NOT NULL AND file_path NOT LIKE '/objects/%'
    UNION ALL
    SELECT 'result_files', id, 'file_path', file_path, 'file',
           COALESCE(original_name, file_path), mime_type
    FROM result_files WHERE file_path IS NOT NULL AND file_path NOT LIKE '/objects/%'
    UNION ALL
    SELECT 'subscriptions', id, 'payment_proof', payment_proof, 'paymentProof',
           payment_proof, NULL::text
    FROM subscriptions WHERE payment_proof IS NOT NULL AND payment_proof NOT LIKE '/objects/%'
    UNION ALL
    SELECT 'analyses', id, 'attachment_path', attachment_path, 'attachment',
           attachment_path, NULL::text
    FROM analyses WHERE attachment_path IS NOT NULL AND attachment_path NOT LIKE '/objects/%'
  `);
  const allowedColumns = {
    courses: new Set(["thumbnail_path", "attachment_path"]),
    lessons: new Set(["video_path", "attachment_path"]),
    resources: new Set(["file_path"]),
    quiz_files: new Set(["file_path"]),
    result_files: new Set(["file_path"]),
    subscriptions: new Set(["payment_proof"]),
    analyses: new Set(["attachment_path"]),
  };
  const mimeByExtension = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
  };
  let migratedCount = 0;
  for (const row of legacyFiles.rows) {
    const oldFilename = String(row.file_path);
    if (
      path.basename(oldFilename) !== oldFilename ||
      !allowedColumns[row.table_name]?.has(row.column_name)
    ) {
      continue;
    }
    const sourcePath = path.resolve(uploadsDir, oldFilename);
    if (!sourcePath.startsWith(`${uploadsDir}${path.sep}`)) continue;
    let stat;
    try {
      stat = await fs.promises.stat(sourcePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const originalName = String(row.original_name || oldFilename)
      .split(/[\\/]/)
      .pop()
      .slice(0, 255);
    const extension = path.extname(originalName).toLowerCase();
    const file = {
      path: sourcePath,
      originalname: originalName,
      mimetype: row.mime_type || mimeByExtension[extension] || "application/octet-stream",
      size: stat.size,
    };
    const objectPath = await objectStorage.uploadLocalFile(file, 0, row.purpose);
    try {
      await pool.query(
        `UPDATE ${row.table_name} SET ${row.column_name} = $1 WHERE id = $2`,
        [objectPath, row.row_id],
      );
    } catch (error) {
      await objectStorage.deleteObject(objectPath, 0, row.purpose);
      throw error;
    }
    migratedCount += 1;
  }
  if (migratedCount) {
    console.log(`Migrated ${migratedCount} legacy upload(s) into private App Storage.`);
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(key).toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string") return false;
  const [algorithm, salt, expectedHex] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !/^[a-f0-9]{128}$/i.test(expectedHex || "")) {
    return false;
  }
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(expectedHex, "hex");
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

function parseCookies(header = "") {
  const cookies = Object.create(null);
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function tokenFromRequest(req) {
  const auth = req.get("authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie)[sessionCookie] || "";
}

function publicUser(row) {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    role: row.role,
    isSubscribed: Boolean(row.is_subscribed),
    activatedAt: row.activated_at,
  };
}

async function attachCurrentUser(req, res, next) {
  try {
    const token = tokenFromRequest(req);
    if (!token || token.length > 256) {
      req.user = null;
      next();
      return;
    }
    const result = await pool.query(
      `SELECT id, name, email, role, is_subscribed, activated_at
       FROM users
       WHERE session_token_hash = $1 AND session_expires_at > NOW()
       LIMIT 1`,
      [hashToken(token)],
    );
    req.user = result.rows[0] ? publicUser(result.rows[0]) : null;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "سجّل الدخول للمتابعة." });
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    res.status(req.user ? 403 : 401).json({
      error: req.user ? "هذه الصفحة مخصصة للإدارة." : "سجّل الدخول للمتابعة.",
    });
    return;
  }
  next();
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDurationMs / 1000}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

async function startSession(userId, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + sessionDurationMs);
  await pool.query(
    `UPDATE users SET session_token_hash = $1, session_expires_at = $2 WHERE id = $3`,
    [hashToken(token), expiresAt, userId],
  );
  setSessionCookie(res, token);
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function asBoolean(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

function textValue(value, maxLength = 10_000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function validHttpUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

const blockedExtensions = new Set([
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".svg",
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".sh",
  ".ps1",
  ".msi",
  ".com",
]);
const blockedMimeTypes = new Set([
  "text/html",
  "application/javascript",
  "text/javascript",
  "image/svg+xml",
  "application/x-msdownload",
  "application/x-executable",
  "application/x-sh",
]);

function allowedUpload(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();
  if (blockedExtensions.has(ext) || blockedMimeTypes.has(mime)) return false;

  if (file.fieldname === "thumbnail") return mime.startsWith("image/");
  if (file.fieldname === "video") return mime.startsWith("video/");
  if (file.fieldname === "paymentProof") {
    return mime.startsWith("image/") || mime === "application/pdf";
  }
  if (file.fieldname === "attachment") {
    return mime.startsWith("image/") || mime === "application/pdf";
  }
  return true;
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadStorageDir),
  filename: (_req, file, callback) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : "";
    callback(null, `${crypto.randomUUID()}${safeExt}`);
  },
});

function uploadErrorFilter(_req, file, callback) {
  if (!allowedUpload(file)) {
    callback(new Error("نوع الملف غير مسموح به لهذا الحقل."));
    return;
  }
  callback(null, true);
}

const contentUpload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024, files: 4, fields: 30 },
  fileFilter: uploadErrorFilter,
});
const paymentUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: uploadErrorFilter,
});

function removeFile(file) {
  if (file?.remoteStorage && file.filename) {
    objectStorage.deleteObject(
      file.filename,
      file.storageUserId,
      file.storagePurpose,
    );
  }
  if (!file?.path) return;
  fs.promises.unlink(file.path).catch(() => {});
}

function getFiles(req, field) {
  return req.files?.[field]?.[0] ||
    (req.file?.fieldname === field ? req.file : null);
}

function storedDownload(kind, id) {
  return `/api/files/${kind}/${id}/download`;
}

function courseRow(row) {
  const id = Number(row.id);
  return {
    id,
    title: row.title,
    description: row.description,
    category: row.category,
    thumbnailPath: row.thumbnail_path
      ? storedDownload("course-thumbnail", id)
      : null,
    attachmentPath: row.attachment_path
      ? storedDownload("course-attachment", id)
      : null,
    isPublished: Boolean(row.is_published),
    isFree: Boolean(row.is_free),
    lessonCount: Number(row.lesson_count || 0),
  };
}

function fileRow(row, kind) {
  return {
    id: Number(row.id),
    title: row.title,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: Number(row.size),
    downloadUrl: storedDownload(kind, Number(row.id)),
  };
}

function uploadedFileData(file) {
  return {
    filePath: file.filename,
    originalName: file.originalname,
    mimeType: file.mimetype || "application/octet-stream",
    size: file.size,
  };
}

function uploadLimit(purpose) {
  return purpose === "paymentProof"
    ? 10 * 1024 * 1024
    : 250 * 1024 * 1024;
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function inlineDisposition(filename) {
  const safeName = path.basename(String(filename)).replace(/[\r\n"]/g, "_");
  const fallbackName = safeName.replace(/[^\x20-\x7e\\]/g, "_");
  const encodedName = encodeURIComponent(safeName).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}

async function resolveUploadedFile(req, field, purpose) {
  const localFile = getFiles(req, field);
  if (localFile) {
    if (!usesAppStorage) return localFile;
    try {
      localFile.filename = await objectStorage.uploadLocalFile(
        localFile,
        req.user.id,
        purpose,
      );
      localFile.remoteStorage = true;
      localFile.storageUserId = req.user.id;
      localFile.storagePurpose = purpose;
      await fs.promises.unlink(localFile.path).catch(() => {});
      return localFile;
    } catch (error) {
      removeFile(localFile);
      throw error;
    }
  }

  const objectPath = textValue(req.body[`${field}ObjectPath`], 500);
  if (!objectPath) return null;
  if (!usesAppStorage) {
    throw requestError("التخزين الدائم غير مفعّل لهذا الخادم.");
  }
  const originalName = textValue(req.body[`${field}OriginalName`], 255);
  const expectedSize = Number(req.body[`${field}Size`]);
  if (
    !originalName ||
    originalName.includes("/") ||
    originalName.includes("\\") ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1
  ) {
    await objectStorage.deleteObject(objectPath, req.user.id, purpose);
    throw requestError("بيانات الملف المرفوع غير صحيحة.");
  }
  let verified;
  try {
    verified = await objectStorage.verifyUploadedObject({
      objectPath,
      userId: req.user.id,
      purpose,
      maxSize: uploadLimit(purpose),
      expectedSize,
      originalName,
    });
  } catch (error) {
    await objectStorage.deleteObject(objectPath, req.user.id, purpose);
    throw error;
  }
  const file = {
    fieldname: field,
    filename: verified.objectPath,
    originalname: originalName,
    mimetype: verified.mimeType,
    size: verified.size,
    remoteStorage: true,
    storageUserId: req.user.id,
    storagePurpose: purpose,
  };
  if (!allowedUpload(file)) {
    removeFile(file);
    throw requestError("نوع الملف غير مسموح به لهذا الحقل.");
  }
  return file;
}

const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  let record = loginAttempts.get(key);
  if (!record || record.resetAt <= now) {
    record = { count: 0, resetAt: now + 15 * 60 * 1000 };
  }
  record.count += 1;
  loginAttempts.set(key, record);
  if (loginAttempts.size > 2000) {
    for (const [ip, entry] of loginAttempts) {
      if (entry.resetAt <= now) loginAttempts.delete(ip);
    }
  }
  if (record.count > 12) {
    res.status(429).json({ error: "محاولات كثيرة. حاول مرة أخرى بعد قليل." });
    return;
  }
  next();
}

app.use("/api", attachCurrentUser);

app.get("/api/storage/mode", (_req, res) => {
  res.json({ directUploadsEnabled: usesAppStorage });
});

app.post("/api/storage/uploads/request-url", requireAuth, async (req, res, next) => {
  const purpose = textValue(req.body.purpose, 40);
  const originalName = textValue(req.body.name, 255);
  const mimeType = textValue(req.body.contentType, 150).toLowerCase();
  const size = Number(req.body.size);
  const validPurposes = new Set([
    "thumbnail",
    "video",
    "attachment",
    "paymentProof",
    "file",
  ]);
  if (!usesAppStorage) {
    res.status(503).json({ error: "التخزين الدائم غير مهيأ على هذا الخادم." });
    return;
  }
  if (
    purpose !== "paymentProof" &&
    req.user.role !== "admin"
  ) {
    res.status(403).json({ error: "رفع هذا النوع من الملفات مخصص للإدارة." });
    return;
  }
  if (
    !validPurposes.has(purpose) ||
    !originalName ||
    originalName.includes("/") ||
    originalName.includes("\\") ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > uploadLimit(purpose) ||
    !allowedUpload({
      fieldname: purpose,
      originalname: originalName,
      mimetype: mimeType,
    })
  ) {
    res.status(400).json({ error: "اسم الملف أو نوعه أو حجمه غير مسموح." });
    return;
  }
  try {
    const upload = await objectStorage.getUploadUrl({
      userId: req.user.id,
      purpose,
      originalName,
    });
    res.json(upload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/healthz", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/register", loginRateLimit, async (req, res) => {
  const name = textValue(req.body.name, 120);
  const email = textValue(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
    res.status(400).json({ error: "أدخل الاسم والبريد وكلمة مرور من 8 أحرف على الأقل." });
    return;
  }
  try {
    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'student')
       RETURNING id, name, email, role, is_subscribed, activated_at`,
      [name, email, passwordHash],
    );
    const user = publicUser(result.rows[0]);
    await startSession(user.id, res);
    res.status(201).json({ user });
  } catch (error) {
    if (error.code === "23505") {
      res.status(409).json({ error: "يوجد حساب مسجل بهذا البريد الإلكتروني." });
      return;
    }
    throw error;
  }
});

app.post("/api/auth/login", loginRateLimit, async (req, res) => {
  let email = textValue(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (email === "admin") email = "admin@fadilschool.local";
  if (!email || !password || password.length > 256) {
    res.status(400).json({ error: "أدخل البريد الإلكتروني وكلمة المرور." });
    return;
  }
  const result = await pool.query(
    `SELECT id, name, email, role, is_subscribed, activated_at, password_hash
     FROM users WHERE email = $1 LIMIT 1`,
    [email],
  );
  const row = result.rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    res.status(401).json({ error: "بيانات تسجيل الدخول غير صحيحة." });
    return;
  }
  await startSession(row.id, res);
  res.json({ user: publicUser(row) });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json(req.user);
});

app.post("/api/auth/logout", async (req, res) => {
  const token = tokenFromRequest(req);
  if (token) {
    await pool.query(
      `UPDATE users SET session_token_hash = NULL, session_expires_at = NULL
       WHERE session_token_hash = $1`,
      [hashToken(token)],
    );
  }
  clearSessionCookie(res);
  res.status(204).end();
});

app.get("/api/courses", async (_req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.title, c.description, c.category, c.thumbnail_path,
            c.attachment_path, c.is_published, c.is_free,
            COUNT(l.id)::int AS lesson_count
     FROM courses c
     LEFT JOIN lessons l ON l.course_id = c.id AND l.is_published = TRUE
     WHERE c.is_published = TRUE
     GROUP BY c.id
     ORDER BY c.created_at DESC, c.id`,
  );
  res.json({ courses: result.rows.map(courseRow) });
});

app.get("/api/courses/:courseId", async (req, res) => {
  const courseId = positiveId(req.params.courseId);
  if (!courseId) {
    res.status(400).json({ error: "رقم الدورة غير صحيح." });
    return;
  }
  const result = await pool.query(
    `SELECT c.id, c.title, c.description, c.category, c.thumbnail_path,
            c.attachment_path, c.is_published, c.is_free,
            COUNT(l.id)::int AS lesson_count
     FROM courses c
     LEFT JOIN lessons l ON l.course_id = c.id AND l.is_published = TRUE
     WHERE c.id = $1 AND c.is_published = TRUE
     GROUP BY c.id`,
    [courseId],
  );
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "الدورة غير موجودة." });
    return;
  }
  const canAccess =
    Boolean(row.is_free) ||
    Boolean(req.user?.isSubscribed) ||
    req.user?.role === "admin";
  const course = courseRow(row);
  if (!canAccess) {
    res.json({ course, lessons: [], resources: [], canAccess: false });
    return;
  }

  const [lessonResult, resourceResult, progressResult] = await Promise.all([
    pool.query(
      `SELECT id, course_id, title, description, category, video_url, video_path,
              attachment_path, duration_seconds
       FROM lessons
       WHERE course_id = $1 AND is_published = TRUE
       ORDER BY created_at, id`,
      [courseId],
    ),
    pool.query(
      `SELECT id, course_id, lesson_id, title
       FROM resources WHERE course_id = $1 ORDER BY created_at, id`,
      [courseId],
    ),
    req.user
      ? pool.query(
          `SELECT lesson_id FROM progress
           WHERE user_id = $1 AND status = 'completed'`,
          [req.user.id],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const completed = new Set(progressResult.rows.map((item) => Number(item.lesson_id)));
  const lessons = lessonResult.rows.map((lesson) => ({
    id: Number(lesson.id),
    courseId: Number(lesson.course_id),
    title: lesson.title,
    description: lesson.description,
    category: lesson.category,
    videoUrl: lesson.video_url,
    videoPath: lesson.video_path
      ? storedDownload("lesson-video", Number(lesson.id))
      : null,
    attachmentPath: lesson.attachment_path
      ? storedDownload("lesson-attachment", Number(lesson.id))
      : null,
    durationSeconds: Number(lesson.duration_seconds),
    isPublished: true,
    completed: completed.has(Number(lesson.id)),
  }));
  const resources = resourceResult.rows.map((resource) => ({
    id: Number(resource.id),
    courseId: Number(resource.course_id),
    lessonId: resource.lesson_id == null ? null : Number(resource.lesson_id),
    title: resource.title,
    downloadUrl: storedDownload("resource", Number(resource.id)),
  }));
  res.json({ course, lessons, resources, canAccess: true });
});

app.post("/api/lessons/:lessonId/complete", requireAuth, async (req, res) => {
  const lessonId = positiveId(req.params.lessonId);
  if (!lessonId) {
    res.status(400).json({ error: "رقم الدرس غير صحيح." });
    return;
  }
  const lessonResult = await pool.query(
    `SELECT l.id, l.course_id, c.is_free
     FROM lessons l JOIN courses c ON c.id = l.course_id
     WHERE l.id = $1 AND l.is_published = TRUE AND c.is_published = TRUE`,
    [lessonId],
  );
  const lesson = lessonResult.rows[0];
  if (!lesson) {
    res.status(404).json({ error: "الدرس غير موجود." });
    return;
  }
  if (!lesson.is_free && !req.user.isSubscribed && req.user.role !== "admin") {
    res.status(403).json({ error: "يتطلب هذا الدرس اشتراكاً فعالاً." });
    return;
  }
  const result = await pool.query(
    `INSERT INTO progress (user_id, course_id, lesson_id, status, completed_at)
     VALUES ($1, $2, $3, 'completed', NOW())
     ON CONFLICT (user_id, lesson_id)
     DO UPDATE SET status = 'completed', completed_at = NOW()
     RETURNING lesson_id, completed_at`,
    [req.user.id, lesson.course_id, lesson.id],
  );
  res.json({
    lessonId: Number(result.rows[0].lesson_id),
    completed: true,
    completedAt: new Date(result.rows[0].completed_at).toISOString(),
  });
});

app.get("/api/subscriptions", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, user_id, plan, note, status, created_at
     FROM subscriptions WHERE user_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [req.user.id],
  );
  const row = result.rows[0];
  res.json({
    subscription: row
      ? {
          id: Number(row.id),
          userId: Number(row.user_id),
          plan: row.plan,
          note: row.note,
          status: row.status,
          createdAt: row.created_at,
          proofUrl: storedDownload("payment", Number(row.id)),
        }
      : null,
  });
});

app.post(
  "/api/subscriptions",
  requireAuth,
  paymentUpload.single("paymentProof"),
  async (req, res) => {
    const file = await resolveUploadedFile(req, "paymentProof", "paymentProof");
    const note = textValue(req.body.note, 1000);
    const plan = textValue(req.body.plan || "standard", 80) || "standard";
    if (!file) {
      res.status(400).json({ error: "أرفق صورة أو ملف PDF لإثبات الدفع." });
      return;
    }
    const pending = await pool.query(
      `SELECT id FROM subscriptions
       WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
      [req.user.id],
    );
    if (pending.rowCount) {
      removeFile(file);
      res.status(409).json({ error: "لديك طلب اشتراك قيد المراجعة بالفعل." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO subscriptions (user_id, plan, payment_proof, note, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, user_id, plan, note, status, created_at`,
      [req.user.id, plan, file.filename, note],
    );
    const row = result.rows[0];
    res.status(201).json({
      subscription: {
        id: Number(row.id),
        userId: Number(row.user_id),
        plan: row.plan,
        note: row.note,
        status: row.status,
        createdAt: row.created_at,
        proofUrl: storedDownload("payment", Number(row.id)),
      },
    });
  },
);

app.get("/api/messages", requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE messages SET is_read = TRUE
     WHERE user_id = $1 AND sender_role = 'admin'`,
    [req.user.id],
  );
  const result = await pool.query(
    `SELECT id, user_id AS "userId", sender_role AS "senderRole",
            body, is_read AS "isRead", created_at AS "createdAt"
     FROM messages WHERE user_id = $1 ORDER BY created_at, id`,
    [req.user.id],
  );
  res.json({ messages: result.rows });
});

app.post("/api/messages", requireAuth, async (req, res) => {
  const body = textValue(req.body.body, 4000);
  if (!body) {
    res.status(400).json({ error: "اكتب رسالة لا تتجاوز 4000 حرف." });
    return;
  }
  const result = await pool.query(
    `INSERT INTO messages (user_id, sender_role, body)
     VALUES ($1, 'student', $2)
     RETURNING id, user_id AS "userId", sender_role AS "senderRole", body,
               is_read AS "isRead", created_at AS "createdAt"`,
    [req.user.id, body],
  );
  res.status(201).json(result.rows[0]);
});

app.get("/api/news", async (_req, res) => {
  const result = await pool.query(
    `SELECT id, title, summary, category, source_url AS "sourceUrl",
            is_published AS "isPublished", created_at AS "createdAt"
     FROM news WHERE is_published = TRUE
     ORDER BY created_at DESC LIMIT 30`,
  );
  res.json({ news: result.rows });
});

app.get("/api/analyses", async (_req, res) => {
  const result = await pool.query(
    `SELECT id, title, body, attachment_path, is_published, created_at
     FROM analyses WHERE is_published = TRUE
     ORDER BY created_at DESC LIMIT 30`,
  );
  res.json({
    analyses: result.rows.map((row) => ({
      id: Number(row.id),
      title: row.title,
      body: row.body,
      attachmentPath: row.attachment_path
        ? storedDownload("analysis-attachment", Number(row.id))
        : null,
      isPublished: true,
      createdAt: row.created_at,
    })),
  });
});

app.get("/api/files/quizzes", async (_req, res) => {
  const result = await pool.query(
    `SELECT id, title, original_name, mime_type, size
     FROM quiz_files ORDER BY created_at DESC`,
  );
  res.json({ files: result.rows.map((row) => fileRow(row, "quiz")) });
});

app.get("/api/files/results", async (_req, res) => {
  const result = await pool.query(
    `SELECT id, title, original_name, mime_type, size
     FROM result_files ORDER BY created_at DESC`,
  );
  res.json({ files: result.rows.map((row) => fileRow(row, "result")) });
});

app.get("/api/files/:kind/:fileId/download", async (req, res, next) => {
  const kind = req.params.kind;
  const id = positiveId(req.params.fileId);
  if (!id) {
    res.status(400).json({ error: "رابط الملف غير صحيح." });
    return;
  }

  let result;
  let inline = false;
  switch (kind) {
    case "quiz":
      result = await pool.query(
        "SELECT file_path, mime_type, original_name FROM quiz_files WHERE id = $1",
        [id],
      );
      break;
    case "result":
      result = await pool.query(
        "SELECT file_path, mime_type, original_name FROM result_files WHERE id = $1",
        [id],
      );
      break;
    case "payment":
      result = await pool.query(
        `SELECT payment_proof AS file_path, NULL::text AS mime_type,
                'payment-proof' AS original_name, user_id
         FROM subscriptions WHERE id = $1`,
        [id],
      );
      if (
        result.rows[0] &&
        (!req.user ||
          (req.user.role !== "admin" && req.user.id !== Number(result.rows[0].user_id)))
      ) {
        res.status(403).json({ error: "لا تملك صلاحية تنزيل هذا الإثبات." });
        return;
      }
      break;
    case "course-thumbnail":
    case "course-attachment": {
      const column = kind === "course-thumbnail" ? "thumbnail_path" : "attachment_path";
      result = await pool.query(
        `SELECT ${column} AS file_path, is_free, is_published
         FROM courses WHERE id = $1`,
        [id],
      );
      const course = result.rows[0];
      if (
        course &&
        (req.user?.role === "admin" ||
          (course.is_published &&
            (kind === "course-thumbnail" ||
              course.is_free ||
              req.user?.isSubscribed)))
      ) {
        inline = kind === "course-thumbnail";
      } else {
        result = { rows: [] };
      }
      break;
    }
    case "lesson-video":
    case "lesson-attachment": {
      const column = kind === "lesson-video" ? "video_path" : "attachment_path";
      result = await pool.query(
        `SELECT l.${column} AS file_path, c.is_free, c.is_published
         FROM lessons l JOIN courses c ON c.id = l.course_id
         WHERE l.id = $1 AND l.is_published = TRUE`,
        [id],
      );
      const lesson = result.rows[0];
      if (
        lesson &&
        (req.user?.role === "admin" ||
          (lesson.is_published &&
            (lesson.is_free || req.user?.isSubscribed)))
      ) {
        inline = kind === "lesson-video";
      } else {
        result = { rows: [] };
      }
      break;
    }
    case "resource":
      result = await pool.query(
        `SELECT r.file_path, r.mime_type, r.original_name, c.is_free, c.is_published
         FROM resources r JOIN courses c ON c.id = r.course_id
         WHERE r.id = $1`,
        [id],
      );
      if (
        result.rows[0] &&
        (req.user?.role === "admin" ||
          (result.rows[0].is_published &&
            (result.rows[0].is_free || req.user?.isSubscribed)))
      ) {
        inline = false;
      } else {
        result = { rows: [] };
      }
      break;
    case "analysis-attachment":
      result = await pool.query(
        `SELECT attachment_path AS file_path, is_published
         FROM analyses WHERE id = $1`,
        [id],
      );
      if (result.rows[0]?.is_published || req.user?.role === "admin") {
        inline = true;
      } else {
        result = { rows: [] };
      }
      break;
    default:
      res.status(404).json({ error: "الملف غير موجود." });
      return;
  }

  const asset = result.rows[0];
  if (!asset?.file_path) {
    res.status(404).json({ error: "الملف غير موجود." });
    return;
  }
  if (String(asset.file_path).startsWith("/objects/")) {
    try {
      const objectFile = await objectStorage.getObjectFile(asset.file_path);
      const [metadata] = await objectFile.getMetadata();
      const totalSize = Number(metadata.size);
      let streamOptions;
      let byteRange;
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!match || !totalSize) {
          res.setHeader("Content-Range", `bytes */${totalSize || 0}`);
          res.status(416).end();
          return;
        }
        let start;
        let end;
        if (match[1] === "") {
          const suffixLength = Number(match[2]);
          if (!suffixLength) {
            res.setHeader("Content-Range", `bytes */${totalSize}`);
            res.status(416).end();
            return;
          }
          start = Math.max(0, totalSize - suffixLength);
          end = totalSize - 1;
        } else {
          start = Number(match[1]);
          end = match[2] === "" ? totalSize - 1 : Number(match[2]);
          end = Math.min(end, totalSize - 1);
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start > end ||
          start >= totalSize
        ) {
          res.setHeader("Content-Range", `bytes */${totalSize}`);
          res.status(416).end();
          return;
        }
        streamOptions = { start, end };
        byteRange = { start, end };
      }
      const mimeType =
        asset.mime_type ||
        metadata.contentType ||
        "application/octet-stream";
      const storedName =
        asset.original_name ||
        metadata.metadata?.originalName ||
        path.basename(asset.file_path);
      const originalName = String(storedName).replace(/[\r\n"]/g, "_");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Accept-Ranges", "bytes");
      res.type(mimeType);
      if (byteRange) {
        res.status(206);
        res.setHeader(
          "Content-Range",
          `bytes ${byteRange.start}-${byteRange.end}/${totalSize}`,
        );
        res.setHeader("Content-Length", String(byteRange.end - byteRange.start + 1));
      } else if (metadata.size) {
        res.setHeader("Content-Length", String(metadata.size));
      }
      if (inline) {
        res.setHeader("Content-Disposition", inlineDisposition(originalName));
      } else {
        res.attachment(originalName);
      }
      const stream = objectFile.createReadStream(streamOptions);
      stream.on("error", (error) => {
        if (!res.headersSent) next(error);
        else res.destroy(error);
      });
      stream.pipe(res);
      return;
    } catch (error) {
      if (Number(error.code) === 404) {
        res.status(404).json({ error: "الملف غير موجود في التخزين الدائم." });
        return;
      }
      next(error);
      return;
    }
  }
  const filename = path.basename(String(asset.file_path));
  if (!filename || filename !== asset.file_path) {
    res.status(404).json({ error: "مسار الملف غير صالح." });
    return;
  }
  const absolutePath = path.join(uploadsDir, filename);
  if (!absolutePath.startsWith(`${uploadsDir}${path.sep}`) || !fs.existsSync(absolutePath)) {
    res.status(404).json({ error: "الملف غير موجود على الخادم." });
    return;
  }
  const extensionMimeTypes = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
  };
  const mimeType =
    asset.mime_type ||
    extensionMimeTypes[path.extname(filename).toLowerCase()] ||
    "application/octet-stream";
  const originalName = String(asset.original_name || filename).replace(/[\r\n"]/g, "_");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(mimeType);
  if (inline) {
    res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
    res.sendFile(absolutePath, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 500).end();
    });
    return;
  }
  res.download(absolutePath, originalName);
});

app.get("/api/admin/overview", requireAdmin, async (_req, res) => {
  const [
    students,
    activeSubscriptions,
    pendingSubscriptions,
    courses,
    lessons,
    unreadMessages,
    recent,
  ] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'student'"),
    pool.query(
      "SELECT COUNT(*)::int AS count FROM users WHERE role = 'student' AND is_subscribed = TRUE",
    ),
    pool.query("SELECT COUNT(*)::int AS count FROM subscriptions WHERE status = 'pending'"),
    pool.query("SELECT COUNT(*)::int AS count FROM courses"),
    pool.query("SELECT COUNT(*)::int AS count FROM lessons"),
    pool.query(
      "SELECT COUNT(*)::int AS count FROM messages WHERE sender_role = 'student' AND is_read = FALSE",
    ),
    pool.query(
      `SELECT s.id, s.user_id, u.name AS user_name, s.plan, s.note, s.status, s.created_at
       FROM subscriptions s JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC LIMIT 5`,
    ),
  ]);
  res.json({
    students: Number(students.rows[0].count),
    activeSubscriptions: Number(activeSubscriptions.rows[0].count),
    pendingSubscriptions: Number(pendingSubscriptions.rows[0].count),
    courses: Number(courses.rows[0].count),
    lessons: Number(lessons.rows[0].count),
    unreadMessages: Number(unreadMessages.rows[0].count),
    recentSubscriptions: recent.rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      userName: row.user_name,
      plan: row.plan,
      note: row.note,
      status: row.status,
      createdAt: row.created_at,
      proofUrl: storedDownload("payment", Number(row.id)),
    })),
  });
});

app.get("/api/admin/subscriptions", requireAdmin, async (_req, res) => {
  const result = await pool.query(
    `SELECT s.id, s.user_id, u.name AS user_name, s.plan, s.note, s.status, s.created_at
     FROM subscriptions s JOIN users u ON u.id = s.user_id
     ORDER BY CASE WHEN s.status = 'pending' THEN 0 ELSE 1 END, s.created_at DESC`,
  );
  res.json({
    subscriptions: result.rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      userName: row.user_name,
      plan: row.plan,
      note: row.note,
      status: row.status,
      createdAt: row.created_at,
      proofUrl: storedDownload("payment", Number(row.id)),
    })),
  });
});

app.post(
  "/api/admin/subscriptions/:subscriptionId/review",
  requireAdmin,
  async (req, res) => {
    const id = positiveId(req.params.subscriptionId);
    const status = req.body.status;
    if (!id || !["approved", "rejected"].includes(status)) {
      res.status(400).json({ error: "رقم الطلب أو قرار المراجعة غير صحيح." });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT s.id, s.user_id, s.plan, s.note, s.status, s.created_at,
                u.name AS user_name
         FROM subscriptions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 FOR UPDATE OF s`,
        [id],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "طلب الاشتراك غير موجود." });
        return;
      }
      if (row.status !== "pending") {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "تمت مراجعة هذا الطلب مسبقاً." });
        return;
      }
      await client.query(
        "UPDATE subscriptions SET status = $1, reviewed_at = NOW() WHERE id = $2",
        [status, id],
      );
      if (status === "approved") {
        await client.query(
          "UPDATE users SET is_subscribed = TRUE, activated_at = NOW() WHERE id = $1",
          [row.user_id],
        );
      }
      await client.query("COMMIT");
      res.json({
        id: Number(row.id),
        userId: Number(row.user_id),
        userName: row.user_name,
        plan: row.plan,
        note: row.note,
        status,
        createdAt: row.created_at,
        proofUrl: storedDownload("payment", Number(row.id)),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
);

app.get("/api/admin/messages", requireAdmin, async (_req, res) => {
  await pool.query(
    "UPDATE messages SET is_read = TRUE WHERE sender_role = 'student' AND is_read = FALSE",
  );
  const result = await pool.query(
    `SELECT m.id, m.user_id AS "userId", u.name AS "userName",
            m.sender_role AS "senderRole", m.body, m.is_read AS "isRead",
            m.created_at AS "createdAt"
     FROM messages m JOIN users u ON u.id = m.user_id
     ORDER BY m.user_id, m.created_at, m.id`,
  );
  res.json({
    messages: result.rows.map((row) => ({
      ...row,
      id: Number(row.id),
      userId: Number(row.userId),
    })),
  });
});

app.post("/api/admin/messages/:userId", requireAdmin, async (req, res) => {
  const userId = positiveId(req.params.userId);
  const body = textValue(req.body.body, 4000);
  if (!userId || !body) {
    res.status(400).json({ error: "أدخل رقم الطالب ورسالة لا تتجاوز 4000 حرف." });
    return;
  }
  const student = await pool.query(
    "SELECT id FROM users WHERE id = $1 AND role = 'student'",
    [userId],
  );
  if (!student.rowCount) {
    res.status(404).json({ error: "الطالب غير موجود." });
    return;
  }
  const result = await pool.query(
    `INSERT INTO messages (user_id, sender_role, body, is_read)
     VALUES ($1, 'admin', $2, FALSE)
     RETURNING id, user_id AS "userId", sender_role AS "senderRole",
               body, is_read AS "isRead", created_at AS "createdAt"`,
    [userId, body],
  );
  res.status(201).json(result.rows[0]);
});

app.get("/api/admin/students", requireAdmin, async (_req, res) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, u.is_subscribed AS "isSubscribed",
            COUNT(DISTINCT p.lesson_id) FILTER (WHERE p.status = 'completed')::int
              AS "completedLessons",
            (SELECT COUNT(*)::int FROM lessons WHERE is_published = TRUE)
              AS "totalLessons",
            u.created_at AS "joinedAt"
     FROM users u LEFT JOIN progress p ON p.user_id = u.id
     WHERE u.role = 'student'
     GROUP BY u.id ORDER BY u.created_at DESC`,
  );
  res.json({
    students: result.rows.map((row) => ({
      ...row,
      id: Number(row.id),
      completedLessons: Number(row.completedLessons),
      totalLessons: Number(row.totalLessons),
    })),
  });
});

app.get("/api/admin/courses", requireAdmin, async (_req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.title, c.description, c.category, c.thumbnail_path,
            c.attachment_path, c.is_published, c.is_free,
            COUNT(l.id)::int AS lesson_count,
            COALESCE(
              json_agg(json_build_object('id', l.id, 'title', l.title)
                       ORDER BY l.created_at, l.id) FILTER (WHERE l.id IS NOT NULL),
              '[]'::json
            ) AS lessons
     FROM courses c LEFT JOIN lessons l ON l.course_id = c.id
     GROUP BY c.id ORDER BY c.created_at DESC, c.id`,
  );
  res.json({
    courses: result.rows.map((row) => ({
      ...courseRow(row),
      lessons: Array.isArray(row.lessons) ? row.lessons : [],
    })),
  });
});

app.post(
  "/api/admin/courses",
  requireAdmin,
  contentUpload.fields([
    { name: "thumbnail", maxCount: 1 },
    { name: "attachment", maxCount: 1 },
  ]),
  async (req, res) => {
    const title = textValue(req.body.title, 200);
    const description = textValue(req.body.description, 5000);
    const category = textValue(req.body.category, 100);
    const thumbnail = await resolveUploadedFile(req, "thumbnail", "thumbnail");
    const attachment = await resolveUploadedFile(req, "attachment", "attachment");
    if (!title || !category) {
      removeFile(thumbnail);
      removeFile(attachment);
      res.status(400).json({ error: "أدخل عنوان الدورة والتصنيف." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO courses (title, description, category, thumbnail_path,
                            attachment_path, is_published, is_free)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, title, description, category, thumbnail_path, attachment_path,
                 is_published, is_free`,
      [
        title,
        description,
        category,
        thumbnail?.filename || null,
        attachment?.filename || null,
        asBoolean(req.body.isPublished),
        asBoolean(req.body.isFree),
      ],
    );
    res.status(201).json(courseRow({ ...result.rows[0], lesson_count: 0 }));
  },
);

app.post(
  "/api/admin/lessons",
  requireAdmin,
  contentUpload.fields([
    { name: "video", maxCount: 1 },
    { name: "attachment", maxCount: 1 },
  ]),
  async (req, res) => {
    const courseId = positiveId(req.body.courseId);
    const title = textValue(req.body.title, 200);
    const description = textValue(req.body.description, 5000);
    const category = textValue(req.body.category, 100);
    const videoUrl = validHttpUrl(textValue(req.body.videoUrl, 2000));
    const duration = Math.max(0, Number.parseInt(req.body.durationSeconds, 10) || 0);
    const video = await resolveUploadedFile(req, "video", "video");
    const attachment = await resolveUploadedFile(req, "attachment", "attachment");
    if (!courseId || !title || !category) {
      removeFile(video);
      removeFile(attachment);
      res.status(400).json({ error: "أدخل الدورة والعنوان والتصنيف ومدة صحيحة." });
      return;
    }
    const course = await pool.query("SELECT id FROM courses WHERE id = $1", [courseId]);
    if (!course.rowCount) {
      removeFile(video);
      removeFile(attachment);
      res.status(404).json({ error: "الدورة المحددة غير موجودة." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO lessons (course_id, title, description, category, video_url,
                            video_path, attachment_path, duration_seconds, is_published)
       VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, $9)
       RETURNING id, course_id, title, description, category, video_url,
                 duration_seconds, is_published`,
      [
        courseId,
        title,
        description,
        category,
        videoUrl,
        video?.filename || null,
        attachment?.filename || null,
        duration,
        asBoolean(req.body.isPublished),
      ],
    );
    const row = result.rows[0];
    res.status(201).json({
      id: Number(row.id),
      courseId: Number(row.course_id),
      title: row.title,
      description: row.description,
      category: row.category,
      videoUrl: row.video_url,
      videoPath: video ? storedDownload("lesson-video", Number(row.id)) : null,
      attachmentPath: attachment
        ? storedDownload("lesson-attachment", Number(row.id))
        : null,
      durationSeconds: Number(row.duration_seconds),
      isPublished: Boolean(row.is_published),
    });
  },
);

app.post(
  "/api/admin/resources",
  requireAdmin,
  contentUpload.single("file"),
  async (req, res) => {
    const file = await resolveUploadedFile(req, "file", "file");
    const courseId = positiveId(req.body.courseId);
    const lessonId = req.body.lessonId ? positiveId(req.body.lessonId) : null;
    const title = textValue(req.body.title, 200);
    if (!file || !courseId || !title || (req.body.lessonId && !lessonId)) {
      removeFile(file);
      res.status(400).json({ error: "اختر دورة وأدخل عنواناً وارفق ملفاً." });
      return;
    }
    const course = await pool.query("SELECT id FROM courses WHERE id = $1", [courseId]);
    if (!course.rowCount) {
      removeFile(file);
      res.status(404).json({ error: "الدورة المحددة غير موجودة." });
      return;
    }
    if (lessonId) {
      const lesson = await pool.query(
        "SELECT id FROM lessons WHERE id = $1 AND course_id = $2",
        [lessonId, courseId],
      );
      if (!lesson.rowCount) {
        removeFile(file);
        res.status(400).json({ error: "الدرس المختار لا يتبع هذه الدورة." });
        return;
      }
    }
    const result = await pool.query(
      `INSERT INTO resources (course_id, lesson_id, title, file_path,
                              original_name, mime_type, size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, course_id, lesson_id, title`,
      [
        courseId,
        lessonId,
        title,
        file.filename,
        file.originalname,
        file.mimetype,
        file.size,
      ],
    );
    const row = result.rows[0];
    res.status(201).json({
      id: Number(row.id),
      courseId: Number(row.course_id),
      lessonId: row.lesson_id == null ? null : Number(row.lesson_id),
      title: row.title,
      downloadUrl: storedDownload("resource", Number(row.id)),
    });
  },
);

app.post("/api/admin/news", requireAdmin, async (req, res) => {
  const title = textValue(req.body.title, 200);
  const summary = textValue(req.body.summary, 5000);
  const category = textValue(req.body.category, 100);
  const sourceUrl = validHttpUrl(textValue(req.body.sourceUrl, 2000));
  if (!title || !summary || !category || (req.body.sourceUrl && !sourceUrl)) {
    res.status(400).json({ error: "أدخل عنوان الخبر وملخصه وتصنيفه ورابط مصدر صالحاً." });
    return;
  }
  const result = await pool.query(
    `INSERT INTO news (title, summary, category, source_url, is_published)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, summary, category, source_url AS "sourceUrl",
               is_published AS "isPublished", created_at AS "createdAt"`,
    [title, summary, category, sourceUrl, asBoolean(req.body.isPublished)],
  );
  res.status(201).json(result.rows[0]);
});

app.post(
  "/api/admin/analyses",
  requireAdmin,
  contentUpload.fields([{ name: "attachment", maxCount: 1 }]),
  async (req, res) => {
    const title = textValue(req.body.title, 200);
    const body = textValue(req.body.body, 15_000);
    const attachment = await resolveUploadedFile(req, "attachment", "attachment");
    if (!title || !body) {
      removeFile(attachment);
      res.status(400).json({ error: "أدخل عنوان التحليل ونصه." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO analyses (title, body, attachment_path, is_published)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, body, is_published, created_at`,
      [
        title,
        body,
        attachment?.filename || null,
        asBoolean(req.body.isPublished),
      ],
    );
    const row = result.rows[0];
    res.status(201).json({
      id: Number(row.id),
      title: row.title,
      body: row.body,
      isPublished: Boolean(row.is_published),
      createdAt: row.created_at,
      attachmentPath: attachment
        ? storedDownload("analysis-attachment", Number(row.id))
        : null,
    });
  },
);

async function uploadPublicFile(req, res, tableName, kind, errorMessage) {
  const file = await resolveUploadedFile(req, "file", "file");
  const title = textValue(req.body.title, 200);
  if (!file || !title) {
    removeFile(file);
    res.status(400).json({ error: errorMessage });
    return;
  }
  if (!sqlIdentifierSafe(tableName)) {
    removeFile(file);
    res.status(500).json({ error: "إعداد مسار رفع غير صالح." });
    return;
  }
  const result = await pool.query(
    `INSERT INTO ${tableName} (title, file_path, original_name, mime_type, size)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, original_name, mime_type, size`,
    [title, ...Object.values(uploadedFileData(file))],
  );
  res.status(201).json(fileRow(result.rows[0], kind));
}

app.post(
  "/api/admin/files/quizzes",
  requireAdmin,
  contentUpload.single("file"),
  (req, res) =>
    uploadPublicFile(
      req,
      res,
      "quiz_files",
      "quiz",
      "أدخل عنوان الملف وارفق ملف الاختبار.",
    ),
);

app.post(
  "/api/admin/files/results",
  requireAdmin,
  contentUpload.single("file"),
  (req, res) =>
    uploadPublicFile(
      req,
      res,
      "result_files",
      "result",
      "أدخل عنوان الملف وارفق ملف النتائج.",
    ),
);

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/admin/")) {
    res.status(404).json({ error: "مسار الإدارة غير موجود." });
    return;
  }
  res.status(404).json({ error: "المسار المطلوب غير موجود." });
});

app.get("/", (_req, res) => res.redirect(302, "/home.html"));
app.use(express.static(publicDir, { extensions: ["html"], index: false }));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? "حجم الملف يتجاوز الحد المسموح."
        : "تعذر استقبال الملف المرفق.",
    });
    return;
  }
  if (error && error.message === "نوع الملف غير مسموح به لهذا الحقل.") {
    res.status(400).json({ error: error.message });
    return;
  }
  if (
    Number.isInteger(error?.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error("Request failed:", error?.message || error);
  if (res.headersSent) return;
  res.status(500).json({ error: "حدث خطأ غير متوقع في الخادم." });
});

async function start() {
  try {
    await initDatabase();
    await migrateLegacyUploads();
    app.listen(port, "0.0.0.0", () => {
      console.log(`FADIL TRADING is running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Startup failed:", error.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

start();
