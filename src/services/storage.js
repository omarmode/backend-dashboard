const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getSupabase, getSupabaseConfig } = require("../config/db");

const DEFAULT_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "manager-files";
// Legacy Render-proxied multipart upload limit (kept for v2.0.1 / v2.0.2 compatibility)
const MAX_FILE_SIZE_MB = Math.min(50, Math.max(1, Number(process.env.MAX_MANAGER_FILE_MB) || 25));
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
// Direct Supabase Signed TUS Resumable Upload ceiling (Supabase Free plan global & bucket ceiling = 50 MB)
const MAX_DIRECT_UPLOAD_MB = Math.min(50, Math.max(1, Number(process.env.MAX_DIRECT_UPLOAD_MB) || 50));
const MAX_DIRECT_UPLOAD_BYTES = MAX_DIRECT_UPLOAD_MB * 1024 * 1024;
// Official Supabase TUS required chunk size: 6 MiB exact
const TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024;
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (matches Supabase TUS URL lifetime)
const SIGNED_DOWNLOAD_TTL_SECONDS = 300; // 5 minutes short-lived download URL

const ALLOWED_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".xltx", ".xltm", ".xlsb", ".csv"]);
const ZIP_EXTENSIONS = new Set([".xlsx", ".xlsm", ".xltx", ".xltm", ".xlsb"]);

const EXTENSION_MIME_MAP = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
  ".xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ".xltm": "application/vnd.ms-excel.template.macroenabled.12",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  ".csv": "text/csv"
};

function sanitizeFileName(rawName) {
  const base = path.basename(String(rawName || "data.xlsx")).replace(/[\r\n\0<>:"/\\|?*]+/g, "_").trim();
  return base || "data.xlsx";
}

function getSessionSigningSecret() {
  return process.env.UPLOAD_SESSION_SECRET || process.env.SESSION_SECRET || "dev-session-secret-change-me";
}

/**
 * Validates Excel/CSV metadata (name, extension, size) without buffering file contents.
 */
function validateExcelMetadata({ fileName, fileSize, maxBytes = MAX_DIRECT_UPLOAD_BYTES, maxMb = MAX_DIRECT_UPLOAD_MB }) {
  const numericSize = Number(fileSize);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    const err = new Error("حجم الملف المرفوع غير صالح أو فارغ");
    err.statusCode = 400;
    err.errorCode = "invalid_size";
    throw err;
  }

  if (numericSize > maxBytes) {
    const err = new Error(`حجم الملف يتجاوز الحد الأقصى المسموح (${maxMb} ميجابايت)`);
    err.statusCode = 413;
    err.errorCode = "file_too_large";
    throw err;
  }

  const cleanName = sanitizeFileName(fileName);
  const ext = path.extname(cleanName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    const err = new Error("يُسمح فقط برفع ملفات Excel/CSV بصيغ (.xlsx, .xls, .xlsm, .xltx, .xltm, .xlsb, .csv)");
    err.statusCode = 400;
    err.errorCode = "invalid_extension";
    throw err;
  }

  return {
    cleanName,
    ext,
    fileSize: Math.trunc(numericSize),
    contentType: EXTENSION_MIME_MAP[ext] || "application/octet-stream"
  };
}

/**
 * Validates binary magic header bytes (needs only first 64–4096 bytes, never the full 40 MB file).
 */
function validateExcelMagicBytes(ext, headBuffer) {
  if (!headBuffer || !Buffer.isBuffer(headBuffer) || headBuffer.length === 0) {
    throw new Error("الملف المرفوع فارغ");
  }

  if (ZIP_EXTENSIONS.has(ext)) {
    // OOXML/XLSB are ZIP ("PK\x03\x04" / "PK\x05\x06") or OLE2 container if password-protected (D0 CF 11 E0)
    const isZip =
      headBuffer.length >= 4 &&
      headBuffer[0] === 0x50 &&
      headBuffer[1] === 0x4b &&
      (headBuffer[2] === 0x03 || headBuffer[2] === 0x05);
    const isOle2 =
      headBuffer.length >= 4 &&
      headBuffer[0] === 0xd0 &&
      headBuffer[1] === 0xcf &&
      headBuffer[2] === 0x11 &&
      headBuffer[3] === 0xe0;
    if (!isZip && !isOle2) {
      throw new Error("محتوى الملف لا يطابق صيغة Excel (.xlsx/.xlsb/.xlsm) الصالحة");
    }
  } else if (ext === ".xls") {
    const isOle2 =
      headBuffer.length >= 4 &&
      headBuffer[0] === 0xd0 &&
      headBuffer[1] === 0xcf &&
      headBuffer[2] === 0x11 &&
      headBuffer[3] === 0xe0;
    const isZip = headBuffer.length >= 4 && headBuffer[0] === 0x50 && headBuffer[1] === 0x4b;
    const headText = headBuffer.subarray(0, Math.min(256, headBuffer.length)).toString("utf8").trimStart();
    const isXmlOrHtml = headText.startsWith("<?xml") || headText.startsWith("<html") || headText.startsWith("<table");
    if (!isOle2 && !isZip && !isXmlOrHtml) {
      throw new Error("محتوى الملف لا يطابق صيغة Excel (.xls) الصالحة");
    }
  } else if (ext === ".csv") {
    const sample = headBuffer.subarray(0, Math.min(4096, headBuffer.length));
    if (sample.includes(0x00)) {
      throw new Error("محتوى ملف CSV غير صالح");
    }
  }
}

/**
 * Legacy buffer validator (kept for backward compatibility & unit tests).
 */
function validateExcelUpload(fileName, buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("الملف المرفوع فارغ");
  }
  const meta = validateExcelMetadata({
    fileName,
    fileSize: buffer.length,
    maxBytes: MAX_FILE_SIZE_BYTES,
    maxMb: MAX_FILE_SIZE_MB
  });
  validateExcelMagicBytes(meta.ext, buffer.subarray(0, Math.min(4096, buffer.length)));
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
  return {
    cleanName: meta.cleanName,
    ext: meta.ext,
    fileSize: buffer.length,
    fileHash,
    contentType: meta.contentType
  };
}

/**
 * Streams a local disk temp file to validate magic bytes & compute SHA-256 without loading
 * the entire file into RAM (used by legacy /upload endpoint).
 */
async function validateExcelFileOnDisk(fileName, filePath, maxBytes = MAX_FILE_SIZE_BYTES, maxMb = MAX_FILE_SIZE_MB) {
  const stat = await fs.promises.stat(filePath);
  const meta = validateExcelMetadata({ fileName, fileSize: stat.size, maxBytes, maxMb });

  const fh = await fs.promises.open(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(4096, stat.size));
    await fh.read(head, 0, head.length, 0);
    validateExcelMagicBytes(meta.ext, head);
  } finally {
    await fh.close();
  }

  const fileHash = await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });

  return {
    cleanName: meta.cleanName,
    ext: meta.ext,
    fileSize: stat.size,
    fileHash,
    contentType: meta.contentType
  };
}

function buildManagerStoragePath(managerId, fileId, ext) {
  const safeManager = String(managerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const safeFile = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : ".xlsx";
  if (!safeManager || !safeFile) {
    throw new Error("معرف المجموعة أو الملف غير صالح للتخزين");
  }
  return `managers/${safeManager}/${safeFile}${safeExt}`;
}

/**
 * Converts https://<project-ref>.supabase.co to https://<project-ref>.storage.supabase.co
 * as officially recommended by Supabase for high-throughput TUS resumable uploads.
 */
function deriveDirectStorageBaseUrl(rawSupabaseUrl) {
  const fallback = String(rawSupabaseUrl || process.env.SUPABASE_URL || "https://example.supabase.co").trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(fallback);
    if (parsed.hostname.endsWith(".supabase.co") && !parsed.hostname.endsWith(".storage.supabase.co")) {
      const ref = parsed.hostname.slice(0, -".supabase.co".length);
      if (ref && !ref.includes(".")) {
        return `${parsed.protocol}//${ref}.storage.supabase.co`;
      }
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return fallback;
  }
}

/**
 * Creates a stateless HMAC-SHA256 signed upload session token that survives Render Free
 * restarts/sleep cycles without requiring an extra database table or migration.
 */
function signUploadSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", getSessionSigningSecret()).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyUploadSession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, reason: "malformed_session" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "malformed_session" };
  }
  const [encoded, providedSig] = parts;
  const expectedSig = crypto.createHmac("sha256", getSessionSigningSecret()).update(encoded).digest("base64url");
  const a = Buffer.from(providedSig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: "invalid_signature" };
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload || payload.v !== 1 || !payload.fid || !payload.mid || !payload.p) {
      return { valid: false, reason: "invalid_payload" };
    }
    if (typeof payload.exp === "number" && Date.now() > payload.exp) {
      return { valid: false, reason: "session_expired", payload };
    }
    return { valid: true, payload };
  } catch (_) {
    return { valid: false, reason: "invalid_payload" };
  }
}

/**
 * Generates a short-lived Supabase Signed Upload Token for a single manager-scoped path.
 * NEVER exposes SUPABASE_SERVICE_ROLE_KEY.
 */
async function createSignedResumableUpload({ managerId, fileId, ext, upsert = false, bucket = DEFAULT_BUCKET }) {
  const supabase = getSupabase();
  const storagePath = buildManagerStoragePath(managerId, fileId, ext);
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUploadUrl(storagePath, { upsert: Boolean(upsert) });

  if (error || !data || !data.token) {
    throw new Error(`تعذر إنشاء تفويض الرفع السحابي: ${error?.message || "استجابة غير صالحة من التخزين"}`);
  }

  let supabaseUrl = process.env.SUPABASE_URL || "";
  if (!supabaseUrl) {
    try {
      supabaseUrl = getSupabaseConfig().supabaseUrl;
    } catch (_) {
      supabaseUrl = "";
    }
  }
  const directBase = deriveDirectStorageBaseUrl(supabaseUrl || "https://example.supabase.co");
  const tusEndpoint = `${directBase}/storage/v1/upload/resumable/sign`;

  // Only include publishable anon key if configured and strictly distinct from service_role key
  const anonKey = String(process.env.SUPABASE_ANON_KEY || "").trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const safePublishableKey = anonKey && anonKey !== serviceKey ? anonKey : null;

  const tusHeaders = {
    "x-signature": data.token
  };
  if (safePublishableKey) {
    tusHeaders.apikey = safePublishableKey;
  }

  return {
    bucket,
    storagePath,
    token: data.token,
    signedUrl: data.signedUrl || null,
    tusEndpoint,
    tusHeaders,
    chunkSizeBytes: TUS_CHUNK_SIZE_BYTES
  };
}

/**
 * Retrieves real stored object metadata from Supabase Storage without downloading file bytes.
 */
async function getStorageObjectInfo({ storagePath, bucket = DEFAULT_BUCKET }) {
  if (!storagePath || storagePath.includes("..")) {
    throw new Error("مسار الملف غير صالح");
  }
  const supabase = getSupabase();
  const bucketApi = supabase.storage.from(bucket);

  if (typeof bucketApi.info === "function") {
    const { data, error } = await bucketApi.info(storagePath);
    if (!error && data) {
      const size = Number(data.size ?? data.metadata?.size ?? 0);
      return {
        exists: true,
        size: Number.isFinite(size) ? size : 0,
        contentType: data.contentType || data.metadata?.mimetype || "application/octet-stream",
        etag: data.etag || data.metadata?.eTag || "",
        lastModified: data.lastModified || data.updatedAt || data.createdAt || null
      };
    }
    const errMsg = String(error?.message || "").toLowerCase();
    const errStatus = Number(error?.statusCode || error?.status || 0);
    if (errStatus === 404 || errMsg.includes("not found") || errMsg.includes("object not found")) {
      return { exists: false, size: 0, contentType: "", etag: "", lastModified: null };
    }
  }

  // Fallback via folder list (compatible with older mocks/SDKs)
  if (typeof bucketApi.list === "function") {
    const dir = path.posix.dirname(storagePath);
    const name = path.posix.basename(storagePath);
    const { data, error } = await bucketApi.list(dir, { limit: 100, search: name });
    if (!error && Array.isArray(data)) {
      const found = data.find((item) => item && item.name === name);
      if (found) {
        const size = Number(found.metadata?.size ?? found.size ?? 0);
        return {
          exists: true,
          size: Number.isFinite(size) ? size : 0,
          contentType: found.metadata?.mimetype || "application/octet-stream",
          etag: found.metadata?.eTag || found.id || "",
          lastModified: found.updated_at || found.created_at || null
        };
      }
      return { exists: false, size: 0, contentType: "", etag: "", lastModified: null };
    }
  }

  return { exists: false, size: 0, contentType: "", etag: "", lastModified: null };
}

/**
 * Reads ONLY the first N bytes (default 64 bytes) of an uploaded object using an HTTP Range
 * request so Render verifies Excel magic-bytes with ~64 bytes RAM instead of 40 MB.
 */
async function readStorageObjectHeaderBytes({ storagePath, bucket = DEFAULT_BUCKET, maxBytes = 64 }) {
  if (!storagePath || storagePath.includes("..")) {
    throw new Error("مسار الملف غير صالح");
  }
  const supabase = getSupabase();
  const bucketApi = supabase.storage.from(bucket);

  // Fast hook for isolated unit tests
  if (typeof bucketApi.downloadRange === "function") {
    const { data, error } = await bucketApi.downloadRange(storagePath, 0, maxBytes - 1);
    if (error || !data) throw new Error(error?.message || "تعذر قراءة ترويسة الملف");
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  if (typeof bucketApi.createSignedUrl === "function") {
    const { data, error } = await bucketApi.createSignedUrl(storagePath, 60);
    if (!error && data?.signedUrl && /^https?:\/\//i.test(data.signedUrl)) {
      const resp = await fetch(data.signedUrl, {
        method: "GET",
        headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` }
      });
      if (!resp.ok && resp.status !== 206) {
        throw new Error(`تعذر التحقق من ترويسة الملف في التخزين (HTTP ${resp.status})`);
      }
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab).subarray(0, maxBytes);
    }
  }

  if (process.env.NODE_ENV === "test") {
    const full = await downloadFromStorage({ storagePath, bucket });
    return full.subarray(0, Math.min(maxBytes, full.length));
  }

  throw new Error("تعذر قراءة ترويسة الملف للتحقق من سلامته");
}

async function createSignedDownloadUrl({ storagePath, bucket = DEFAULT_BUCKET, expiresInSeconds = SIGNED_DOWNLOAD_TTL_SECONDS }) {
  if (!storagePath || storagePath.includes("..")) {
    throw new Error("مسار الملف غير صالح");
  }
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data || !data.signedUrl) {
    throw new Error(`تعذر إنشاء رابط التنزيل المؤقت: ${error?.message || "خطأ غير معروف"}`);
  }

  return {
    signedUrl: data.signedUrl,
    expiresInSeconds
  };
}

async function uploadToStorage({ managerId, fileId, ext, buffer, contentType, bucket = DEFAULT_BUCKET }) {
  const supabase = getSupabase();
  const storagePath = buildManagerStoragePath(managerId, fileId, ext);

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: contentType || "application/octet-stream",
      upsert: false
    });

  if (error) {
    throw new Error(`تعذر حفظ الملف في التخزين السحابي (Supabase Storage): ${error.message || "خطأ غير معروف"}`);
  }

  return { bucket, storagePath };
}

/**
 * Streams a temp disk file to Supabase Storage for legacy /upload requests without
 * keeping multiple copies in Render RAM.
 */
async function uploadFilePathToStorage({ managerId, fileId, ext, filePath, contentType, bucket = DEFAULT_BUCKET }) {
  const supabase = getSupabase();
  const storagePath = buildManagerStoragePath(managerId, fileId, ext);
  const stream = fs.createReadStream(filePath);

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, stream, {
      contentType: contentType || "application/octet-stream",
      duplex: "half",
      upsert: false
    });

  if (error) {
    throw new Error(`تعذر حفظ الملف في التخزين السحابي (Supabase Storage): ${error.message || "خطأ غير معروف"}`);
  }

  return { bucket, storagePath };
}

async function downloadFromStorage({ storagePath, bucket = DEFAULT_BUCKET }) {
  if (!storagePath || storagePath.includes("..")) {
    throw new Error("مسار الملف غير صالح");
  }
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(bucket)
    .download(storagePath);

  if (error || !data) {
    throw new Error(`تعذر قراءة الملف من التخزين السحابي: ${error?.message || "الملف غير موجود"}`);
  }

  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (typeof data.arrayBuffer === "function") {
    const ab = await data.arrayBuffer();
    return Buffer.from(ab);
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  throw new Error("صيغة بيانات التخزين غير مدعومة");
}

async function removeFromStorage({ storagePath, bucket = DEFAULT_BUCKET }) {
  if (!storagePath || storagePath.includes("..")) {
    return;
  }
  const supabase = getSupabase();
  try {
    await supabase.storage.from(bucket).remove([storagePath]);
  } catch (err) {
    console.warn("Storage delete warning:", err.message);
  }
}

/**
 * Safely removes ONLY stale orphaned objects (>24h old) inside a single manager's prefix
 * that have no corresponding record in manager_files. Never touches active files or other managers.
 */
async function cleanupStaleOrphanObjects({ managerId, knownStoragePaths = new Set(), maxAgeMs = UPLOAD_SESSION_TTL_MS, bucket = DEFAULT_BUCKET }) {
  const safeManager = String(managerId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeManager) return 0;
  const prefix = `managers/${safeManager}`;
  const supabase = getSupabase();
  const bucketApi = supabase.storage.from(bucket);
  if (typeof bucketApi.list !== "function") return 0;

  try {
    const { data, error } = await bucketApi.list(prefix, { limit: 200 });
    if (error || !Array.isArray(data) || data.length === 0) return 0;

    const cutoff = Date.now() - maxAgeMs;
    const stalePaths = [];
    for (const item of data) {
      if (!item || !item.name) continue;
      const fullPath = `${prefix}/${item.name}`;
      if (knownStoragePaths.has(fullPath)) continue;
      const tsRaw = item.updated_at || item.created_at;
      const ts = tsRaw ? Date.parse(tsRaw) : NaN;
      if (Number.isFinite(ts) && ts < cutoff) {
        stalePaths.push(fullPath);
      }
    }
    if (stalePaths.length > 0) {
      await bucketApi.remove(stalePaths);
    }
    return stalePaths.length;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  DEFAULT_BUCKET,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
  MAX_DIRECT_UPLOAD_MB,
  MAX_DIRECT_UPLOAD_BYTES,
  TUS_CHUNK_SIZE_BYTES,
  UPLOAD_SESSION_TTL_MS,
  SIGNED_DOWNLOAD_TTL_SECONDS,
  ALLOWED_EXTENSIONS,
  sanitizeFileName,
  validateExcelMetadata,
  validateExcelMagicBytes,
  validateExcelUpload,
  validateExcelFileOnDisk,
  buildManagerStoragePath,
  deriveDirectStorageBaseUrl,
  signUploadSession,
  verifyUploadSession,
  createSignedResumableUpload,
  getStorageObjectInfo,
  readStorageObjectHeaderBytes,
  createSignedDownloadUrl,
  uploadToStorage,
  uploadFilePathToStorage,
  downloadFromStorage,
  removeFromStorage,
  cleanupStaleOrphanObjects
};
