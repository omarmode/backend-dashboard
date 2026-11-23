const bcrypt = require("bcryptjs");
const { getSupabase, throwIfError } = require("../config/db");

function mapAdmin(row) {
  if (!row) return null;

  const primarySuperUsername = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
  const role =
    row.role ||
    (String(row.username || "").trim().toLowerCase() === primarySuperUsername
      ? "super_admin"
      : "sub_admin");
  const isActive = typeof row.is_active === "boolean" ? row.is_active : true;

  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password,
    role,
    isActive,
    createdAt: row.created_at,
    isSuperAdmin: role === "super_admin",
    async verifyPassword(plainPassword) {
      return bcrypt.compare(plainPassword, row.password);
    }
  };
}

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 12);
}

async function findByUsername(username) {
  const supabase = getSupabase();
  const normalized = String(username || "").trim().toLowerCase();

  const { data, error } = await supabase
    .from("admin")
    .select("*")
    .eq("username", normalized)
    .maybeSingle();

  if (!error) {
    return mapAdmin(data);
  }

  const { data: fallbackData, error: fbErr } = await supabase
    .from("admin")
    .select("id, username, password, created_at")
    .eq("username", normalized)
    .maybeSingle();

  await throwIfError(fbErr, "تعذر البحث عن حساب المدير");
  return mapAdmin(fallbackData);
}

async function findById(id) {
  if (!id) return null;
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("admin")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!error) {
    return mapAdmin(data);
  }

  const { data: fallbackData, error: fbErr } = await supabase
    .from("admin")
    .select("id, username, password, created_at")
    .eq("id", id)
    .maybeSingle();

  await throwIfError(fbErr, "تعذر قراءة حساب المدير");
  return mapAdmin(fallbackData);
}

async function updatePassword(id, passwordHash) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("admin")
    .update({ password: passwordHash })
    .eq("id", id)
    .select("id, username, password, created_at")
    .single();

  await throwIfError(error, "تعذر تحديث كلمة مرور المدير");
  return mapAdmin(data);
}

async function upsertFromEnv(username, plainPassword) {
  const passwordHash = await hashPassword(plainPassword);
  const normalized = String(username || "").trim().toLowerCase();
  const existing = await findByUsername(normalized);

  if (existing) {
    await updatePassword(existing.id, passwordHash);
    return findById(existing.id);
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("admin")
    .insert({
      username: normalized,
      password: passwordHash
    })
    .select("id, username, password, created_at")
    .single();

  await throwIfError(error, "تعذر إنشاء الحساب الرئيسي");
  return mapAdmin(data);
}

module.exports = {
  hashPassword,
  findByUsername,
  findById,
  updatePassword,
  upsertFromEnv
};
