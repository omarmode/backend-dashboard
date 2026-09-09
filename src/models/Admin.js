const bcrypt = require("bcryptjs");
const { getSupabase, throwIfError } = require("../config/db");

function mapAdmin(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password,
    createdAt: row.created_at,
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
  const { data, error } = await supabase
    .from("admin")
    .select("id, username, password, created_at")
    .eq("username", String(username || "").trim().toLowerCase())
    .maybeSingle();

  await throwIfError(error, "تعذر قراءة حساب المدير");
  return mapAdmin(data);
}

async function createAdmin(username, passwordHash) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("admin")
    .insert({
      username: String(username || "").trim().toLowerCase(),
      password: passwordHash
    })
    .select("id, username, password, created_at")
    .single();

  await throwIfError(error, "تعذر إنشاء حساب المدير");
  return mapAdmin(data);
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
  const existing = await findByUsername(username);

  if (existing) {
    return updatePassword(existing.id, passwordHash);
  }

  return createAdmin(username, passwordHash);
}

module.exports = {
  hashPassword,
  findByUsername,
  createAdmin,
  updatePassword,
  upsertFromEnv
};
