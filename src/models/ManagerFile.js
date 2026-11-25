const crypto = require("crypto");
const { getSupabase, throwIfError } = require("../config/db");
const { DEFAULT_BUCKET, removeFromStorage } = require("../services/storage");

function mapFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    managerId: row.manager_id,
    uploadedByCodeId: row.uploaded_by_code_id || null,
    fileName: row.file_name,
    fileSize: Number(row.file_size) || 0,
    recordsCount: Number(row.records_count) || 0,
    storageBucket: row.storage_bucket || DEFAULT_BUCKET,
    storagePath: row.storage_path,
    fileHash: row.file_hash || "",
    version: Number(row.version) || 1,
    isActive: row.is_active !== false,
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date()
  };
}

async function createFile({
  id = crypto.randomUUID(),
  managerId,
  uploadedByCodeId = null,
  fileName,
  fileSize,
  recordsCount = 0,
  storageBucket = DEFAULT_BUCKET,
  storagePath,
  fileHash = ""
}) {
  if (!managerId) {
    throw new Error("معرف مجموعة المدير مطلوب لرفع الملف");
  }
  const now = new Date().toISOString();
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("manager_files")
    .insert({
      id,
      manager_id: managerId,
      uploaded_by_code_id: uploadedByCodeId,
      file_name: fileName,
      file_size: Number(fileSize) || 0,
      records_count: Number(recordsCount) || 0,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      file_hash: fileHash,
      version: 1,
      is_active: true,
      deleted_at: null,
      created_at: now,
      updated_at: now
    })
    .select("*")
    .single();

  if (error) {
    // Idempotency safety: if a concurrent /complete request already inserted this exact fileId
    // for the same manager, return the existing record cleanly instead of failing.
    const msg = String(error.message || "").toLowerCase();
    if (error.code === "23505" || msg.includes("duplicate key")) {
      const existing = await findById(id);
      if (existing && String(existing.managerId) === String(managerId)) {
        return existing;
      }
    }
  }

  await throwIfError(error, "تعذر تسجيل بيانات الملف في قاعدة البيانات");
  return mapFile(data);
}

async function listAllPathsByManager(managerId) {
  if (!managerId) return new Set();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("manager_files")
    .select("storage_path")
    .eq("manager_id", managerId);
  if (error || !Array.isArray(data)) return new Set();
  return new Set(data.map((r) => r.storage_path).filter(Boolean));
}

async function listActiveByManager(managerId) {
  if (!managerId) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("manager_files")
    .select("*")
    .eq("manager_id", managerId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  await throwIfError(error, "تعذر تحميل قائمة ملفات المدير");
  return (data || []).map(mapFile);
}

async function listAllActive() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("manager_files")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  await throwIfError(error, "تعذر تحميل ملفات المديرين");
  return (data || []).map(mapFile);
}

async function countActiveByManager(managerId) {
  const list = await listActiveByManager(managerId);
  return list.length;
}

async function findById(id) {
  if (!id) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("manager_files")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  await throwIfError(error, "تعذر البحث عن الملف");
  return mapFile(data);
}

/**
 * Soft-deletes a manager file record (so client sync detects revocation) and deletes
 * the underlying blob from Supabase Storage.
 * If expectedManagerId is provided, strictly enforces group ownership.
 */
async function deleteFile(id, expectedManagerId = null) {
  const file = await findById(id);
  if (!file) {
    return null;
  }

  if (expectedManagerId && String(file.managerId) !== String(expectedManagerId)) {
    const err = new Error("ليس لديك صلاحية حذف هذا الملف");
    err.statusCode = 403;
    throw err;
  }

  const now = new Date().toISOString();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("manager_files")
    .update({
      is_active: false,
      deleted_at: now,
      updated_at: now
    })
    .eq("id", id)
    .select("*")
    .single();

  await throwIfError(error, "تعذر حذف الملف من قاعدة البيانات");

  // Delete physical object from Supabase Storage
  if (file.storagePath) {
    await removeFromStorage({
      storagePath: file.storagePath,
      bucket: file.storageBucket || DEFAULT_BUCKET
    });
  }

  return mapFile(data);
}

module.exports = {
  mapFile,
  createFile,
  listActiveByManager,
  listAllActive,
  listAllPathsByManager,
  countActiveByManager,
  findById,
  deleteFile
};
