const fs = require("fs");
const path = require("path");
const { getSupabase, throwIfError } = require("../config/db");

const CODE_META_FILE = path.join(__dirname, "../../data/code_admin_meta.json");

function readCodeMeta() {
  try {
    if (fs.existsSync(CODE_META_FILE)) {
      return JSON.parse(fs.readFileSync(CODE_META_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Failed to read code_admin_meta:", e);
  }
  return {};
}

function writeCodeMeta(data) {
  try {
    fs.writeFileSync(CODE_META_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to write code_admin_meta:", e);
  }
}

function mapCode(row) {
  if (!row) {
    return null;
  }

  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const localMeta = readCodeMeta()[row.id] || {};
  const createdByAdminId = row.created_by_admin_id || localMeta.createdByAdminId || null;

  return {
    id: row.id,
    _id: row.id,
    code: row.code,
    isActivated: row.is_active === true,
    isBlocked: row.is_blocked === true,
    deviceId: row.device_id || null,
    expiresAt,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    durationLabel: row.duration_label || "",
    clientName: String(row.client_name || "").trim(),
    appId: String(row.app_id || "FARZ_V1").trim().toUpperCase(),
    activatedAt: row.activated_at ? new Date(row.activated_at) : null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    createdByAdminId,
    isExpired(now = new Date()) {
      if (!expiresAt) {
        return true;
      }
      return expiresAt.getTime() <= now.getTime();
    }
  };
}

async function findByCode(code) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("activation_codes")
    .select("*")
    .eq("code", String(code || "").trim().toUpperCase())
    .maybeSingle();

  await throwIfError(error, "تعذر البحث عن كود التفعيل");
  return mapCode(data);
}

async function findById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("activation_codes")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  await throwIfError(error, "تعذر قراءة كود التفعيل");
  return mapCode(data);
}

async function existsByCode(code) {
  const record = await findByCode(code);
  return Boolean(record);
}

async function listAll(appId = null, filterAdminId = null) {
  const supabase = getSupabase();
  let query = supabase
    .from("activation_codes")
    .select("*")
    .order("created_at", { ascending: false });

  if (appId) {
    query = query.eq("app_id", appId);
  }

  const { data, error } = await query;
  await throwIfError(error, "تعذر تحميل قائمة الأكواد");

  const list = (data || []).map(mapCode);

  if (filterAdminId) {
    return list.filter((item) => String(item.createdByAdminId) === String(filterAdminId));
  }

  return list;
}

async function countByAdmin(adminId) {
  if (!adminId) return 0;
  const list = await listAll(null, adminId);
  return list.length;
}

async function createCode(fields) {
  const supabase = getSupabase();
  const createdByAdminId = fields.createdByAdminId || null;

  const basePayload = {
    code: String(fields.code || "").trim().toUpperCase(),
    expires_at: fields.expiresAt,
    duration_label: fields.durationLabel || "",
    client_name: String(fields.clientName || "").trim(),
    app_id: String(fields.appId || "FARZ_V1").trim().toUpperCase(),
    is_active: false,
    is_blocked: false,
    device_id: null,
    activated_at: null,
    last_seen_at: null
  };

  let record = null;
  // Try with created_by_admin_id column
  const { data, error } = await supabase
    .from("activation_codes")
    .insert({
      ...basePayload,
      created_by_admin_id: createdByAdminId
    })
    .select("*")
    .single();

  if (!error && data) {
    record = data;
  } else {
    // Fallback: insert standard columns
    const { data: fallbackData, error: fbError } = await supabase
      .from("activation_codes")
      .insert(basePayload)
      .select("*")
      .single();

    await throwIfError(fbError, "تعذر إنشاء كود التفعيل");
    record = fallbackData;
  }

  // Update local code meta
  if (record && createdByAdminId) {
    const codeMeta = readCodeMeta();
    codeMeta[record.id] = { createdByAdminId: String(createdByAdminId) };
    writeCodeMeta(codeMeta);
  }

  return mapCode(record);
}

async function updateCode(id, fields) {
  const supabase = getSupabase();
  const payload = {};

  if (Object.prototype.hasOwnProperty.call(fields, "isActivated")) {
    payload.is_active = Boolean(fields.isActivated);
  }
  if (Object.prototype.hasOwnProperty.call(fields, "isBlocked")) {
    payload.is_blocked = Boolean(fields.isBlocked);
  }
  if (Object.prototype.hasOwnProperty.call(fields, "deviceId")) {
    payload.device_id = fields.deviceId;
  }
  if (Object.prototype.hasOwnProperty.call(fields, "activatedAt")) {
    payload.activated_at = fields.activatedAt;
  }
  if (Object.prototype.hasOwnProperty.call(fields, "lastSeenAt")) {
    payload.last_seen_at = fields.lastSeenAt;
  }
  if (Object.prototype.hasOwnProperty.call(fields, "createdByAdminId")) {
    payload.created_by_admin_id = fields.createdByAdminId;
  }

  const { data, error } = await supabase
    .from("activation_codes")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();

  await throwIfError(error, "تعذر تحديث كود التفعيل");

  if (fields.createdByAdminId) {
    const codeMeta = readCodeMeta();
    codeMeta[id] = { createdByAdminId: String(fields.createdByAdminId) };
    writeCodeMeta(codeMeta);
  }

  return mapCode(data);
}

async function deleteById(id) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("activation_codes")
    .delete()
    .eq("id", id);

  await throwIfError(error, "تعذر حذف كود التفعيل");

  const codeMeta = readCodeMeta();
  if (codeMeta[id]) {
    delete codeMeta[id];
    writeCodeMeta(codeMeta);
  }
}

module.exports = {
  mapCode,
  findByCode,
  findById,
  existsByCode,
  listAll,
  countByAdmin,
  createCode,
  updateCode,
  deleteById
};
