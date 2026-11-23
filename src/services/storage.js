const crypto = require("crypto");
const path = require("path");
const { getSupabase } = require("../config/db");

const DEFAULT_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "manager-files";
const MAX_FILE_SIZE_MB = Math.min(50, Math.max(1, Number(process.env.MAX_MANAGER_FILE_MB) || 25));
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

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

/**
 * Validates file extension, size, and binary magic signature to prevent arbitrary
 * file uploads disguised as Excel spreadsheets.
 */
function validateExcelUpload(fileName, buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("الملف المرفوع فارغ");
  }

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(`حجم الملف يتجاوز الحد الأقصى المسموح (${MAX_FILE_SIZE_MB} ميجابايت)`);
  }

  const cleanName = sanitizeFileName(fileName);
  const ext = path.extname(cleanName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("يُسمح فقط برفع ملفات Excel/CSV بصيغ (.xlsx, .xls, .xlsm, .xltx, .xltm, .xlsb, .csv)");
  }

  // Magic-bytes validation
  if (ZIP_EXTENSIONS.has(ext)) {
    // OOXML / XLSB files are ZIP archives beginning with "PK\x03\x04" or "PK\x05\x06"
    const isZip =
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      (buffer[2] === 0x03 || buffer[2] === 0x05);
    if (!isZip) {
      throw new Error("محتوى الملف لا يطابق صيغة Excel (.xlsx/.xlsb/.xlsm) الصالحة");
    }
  } else if (ext === ".xls") {
    // Legacy Excel files are OLE2 Compound Documents (D0 CF 11 E0 A1 B1 1A E1) or BIFF/XML/HTML exports
    const isOle2 =
      buffer.length >= 8 &&
      buffer[0] === 0xd0 &&
      buffer[1] === 0xcf &&
      buffer[2] === 0x11 &&
      buffer[3] === 0xe0;
    const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    const headText = buffer.subarray(0, Math.min(256, buffer.length)).toString("utf8").trimStart();
    const isXmlOrHtml = headText.startsWith("<?xml") || headText.startsWith("<html") || headText.startsWith("<table");
    if (!isOle2 && !isZip && !isXmlOrHtml) {
      throw new Error("محتوى الملف لا يطابق صيغة Excel (.xls) الصالحة");
    }
  } else if (ext === ".csv") {
    // Reject binary files pretending to be CSV (check first 4KB for NUL bytes)
    const sample = buffer.subarray(0, Math.min(4096, buffer.length));
    if (sample.includes(0x00)) {
      throw new Error("محتوى ملف CSV غير صالح");
    }
  }

  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const contentType = EXTENSION_MIME_MAP[ext] || "application/octet-stream";

  return {
    cleanName,
    ext,
    fileSize: buffer.length,
    fileHash,
    contentType
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

module.exports = {
  DEFAULT_BUCKET,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_EXTENSIONS,
  sanitizeFileName,
  validateExcelUpload,
  buildManagerStoragePath,
  uploadToStorage,
  downloadFromStorage,
  removeFromStorage
};
