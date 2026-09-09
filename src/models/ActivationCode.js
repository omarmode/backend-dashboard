const { getSupabase, throwIfError } = require("../config/db");

function mapCode(row) {
  if (!row) {
    return null;
  }

  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;

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
    activatedAt: row.activated_at ? new Date(row.activated_at) : null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
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

async function listAll() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("activation_codes")
    .select("*")
    .order("created_at", { ascending: false });

  await throwIfError(error, "تعذر تحميل قائمة الأكواد");
  return (data || []).map(mapCode);
}

async function createCode(fields) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("activation_codes")
    .insert({
      code: String(fields.code || "").trim().toUpperCase(),
      expires_at: fields.expiresAt,
      duration_label: fields.durationLabel || "",
      is_active: false,
      is_blocked: false,
      device_id: null,
      activated_at: null,
      last_seen_at: null
    })
    .select("*")
    .single();

  await throwIfError(error, "تعذر إنشاء كود التفعيل");
  return mapCode(data);
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

  const { data, error } = await supabase
    .from("activation_codes")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();

  await throwIfError(error, "تعذر تحديث كود التفعيل");
  return mapCode(data);
}

async function deleteById(id) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("activation_codes")
    .delete()
    .eq("id", id);

  await throwIfError(error, "تعذر حذف كود التفعيل");
}

module.exports = {
  mapCode,
  findByCode,
  findById,
  existsByCode,
  listAll,
  createCode,
  updateCode,
  deleteById
};
