const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getSupabase } = require("../config/db");

const FILES_META = path.join(__dirname, "../../data/admin_files_meta.json");

function readFilesMeta() {
  try {
    if (fs.existsSync(FILES_META)) {
      return JSON.parse(fs.readFileSync(FILES_META, "utf-8"));
    }
  } catch (e) {
    console.error("Failed to read admin_files_meta:", e);
  }
  return [];
}

function writeFilesMeta(data) {
  try {
    fs.writeFileSync(FILES_META, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to write admin_files_meta:", e);
  }
}

function mapFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    adminId: row.admin_id || row.adminId,
    fileName: row.file_name || row.fileName,
    fileSize: Number(row.file_size || row.fileSize) || 0,
    recordsCount: Number(row.records_count || row.recordsCount) || 0,
    storagePath: row.storage_path || row.storagePath,
    fileHash: row.file_hash || row.fileHash || "",
    version: Number(row.version) || 1,
    isActive: row.is_active !== false && row.isActive !== false,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date()
  };
}

async function createFile({ adminId, fileName, fileSize, recordsCount = 0, storagePath, fileHash = "" }) {
  const fileId = crypto.randomUUID();
  const now = new Date().toISOString();

  const fileRecord = {
    id: fileId,
    admin_id: String(adminId),
    file_name: fileName,
    file_size: fileSize,
    records_count: recordsCount,
    storage_path: storagePath,
    file_hash: fileHash,
    version: 1,
    is_active: true,
    created_at: now,
    updated_at: now
  };

  const supabase = getSupabase();
  try {
    const { data, error } = await supabase.from("admin_files").insert(fileRecord).select("*").single();
    if (!error && data) {
      return mapFile(data);
    }
  } catch (_) {
    // Supabase table admin_files may not exist yet, fallback to local meta
  }

  // Fallback to local metadata
  const list = readFilesMeta();
  list.unshift(fileRecord);
  writeFilesMeta(list);

  return mapFile(fileRecord);
}

async function listByAdmin(adminId) {
  const supabase = getSupabase();
  try {
    const { data, error } = await supabase
      .from("admin_files")
      .select("*")
      .eq("admin_id", String(adminId))
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (!error && data) {
      return data.map(mapFile);
    }
  } catch (_) {
    // Fallback
  }

  const list = readFilesMeta();
  return list
    .filter((f) => String(f.admin_id) === String(adminId) && f.is_active !== false)
    .map(mapFile);
}

async function findById(id) {
  if (!id) return null;
  const supabase = getSupabase();
  try {
    const { data, error } = await supabase.from("admin_files").select("*").eq("id", id).maybeSingle();
    if (!error && data) {
      return mapFile(data);
    }
  } catch (_) {}

  const list = readFilesMeta();
  const found = list.find((f) => f.id === id);
  return mapFile(found);
}

async function deleteFile(id, adminId = null) {
  const file = await findById(id);
  if (!file) return false;

  // Authorization check: if adminId is provided, verify ownership
  if (adminId && String(file.adminId) !== String(adminId)) {
    throw new Error("غير مصرح لك بحذف هذا الملف");
  }

  const supabase = getSupabase();
  try {
    await supabase.from("admin_files").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
  } catch (_) {}

  // Local meta update: soft delete
  const list = readFilesMeta();
  const idx = list.findIndex((f) => f.id === id);
  if (idx !== -1) {
    list[idx].is_active = false;
    list[idx].updated_at = new Date().toISOString();
    writeFilesMeta(list);
  }

  // Optionally delete physical file or keep for audit
  if (file.storagePath && fs.existsSync(file.storagePath)) {
    try {
      fs.unlinkSync(file.storagePath);
    } catch (e) {
      console.warn("Could not remove physical file:", e.message);
    }
  }

  return true;
}

module.exports = {
  createFile,
  listByAdmin,
  findById,
  deleteFile
};

