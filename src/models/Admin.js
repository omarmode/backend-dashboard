const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const { getSupabase, throwIfError } = require("../config/db");

const META_FILE = path.join(__dirname, "../../data/sub_admins_meta.json");

function readLocalMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      return JSON.parse(fs.readFileSync(META_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Failed to read sub_admins_meta:", e);
  }
  return {};
}

function writeLocalMeta(data) {
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to write sub_admins_meta:", e);
  }
}

function mapAdmin(row) {
  if (!row) return null;

  const localMeta = readLocalMeta()[row.id] || {};

  const role = row.role || localMeta.role || (row.username === (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase() ? "super_admin" : "sub_admin");
  const maxCodesQuota = typeof row.max_codes_quota === "number" ? row.max_codes_quota : (typeof localMeta.maxCodesQuota === "number" ? localMeta.maxCodesQuota : (role === "super_admin" ? 999999 : 50));
  const isActive = typeof row.is_active === "boolean" ? row.is_active : (typeof localMeta.isActive === "boolean" ? localMeta.isActive : true);
  const createdBy = row.created_by || localMeta.createdBy || null;

  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password,
    role,
    maxCodesQuota,
    isActive,
    createdBy,
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

  // Try selecting all columns including new ones; fallback to standard if not migrated
  let row = null;
  const { data, error } = await supabase
    .from("admin")
    .select("*")
    .eq("username", normalized)
    .maybeSingle();

  if (!error) {
    row = data;
  } else {
    const { data: fallbackData } = await supabase
      .from("admin")
      .select("id, username, password, created_at")
      .eq("username", normalized)
      .maybeSingle();
    row = fallbackData;
  }

  return mapAdmin(row);
}

async function findById(id) {
  if (!id) return null;
  const supabase = getSupabase();

  let row = null;
  const { data, error } = await supabase
    .from("admin")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!error) {
    row = data;
  } else {
    const { data: fallbackData } = await supabase
      .from("admin")
      .select("id, username, password, created_at")
      .eq("id", id)
      .maybeSingle();
    row = fallbackData;
  }

  return mapAdmin(row);
}

async function listAllAdmins() {
  const supabase = getSupabase();
  let list = [];
  const { data, error } = await supabase
    .from("admin")
    .select("*")
    .order("created_at", { ascending: true });

  if (!error && data) {
    list = data;
  } else {
    const { data: fallbackData } = await supabase
      .from("admin")
      .select("id, username, password, created_at")
      .order("created_at", { ascending: true });
    list = fallbackData || [];
  }

  return list.map(mapAdmin);
}

async function listSubAdmins() {
  const all = await listAllAdmins();
  return all.filter((a) => a.role === "sub_admin");
}

async function createSubAdmin({ username, password, plainPassword, maxCodesQuota = 50, createdBy = null }) {
  const normalized = String(username || "").trim().toLowerCase();
  const rawPassword = password || plainPassword;
  if (!rawPassword) {
    throw new Error("كلمة المرور مطلوبة");
  }
  const existing = await findByUsername(normalized);
  if (existing) {
    throw new Error("اسم المستخدم موجود بالفعل. اختر اسماً آخر.");
  }

  const passwordHash = await hashPassword(rawPassword);
  const supabase = getSupabase();

  let record = null;
  // Try inserting with all fields
  const { data, error } = await supabase
    .from("admin")
    .insert({
      username: normalized,
      password: passwordHash,
      role: "sub_admin",
      max_codes_quota: Number(maxCodesQuota) || 50,
      is_active: true,
      created_by: createdBy
    })
    .select("*")
    .single();

  if (!error && data) {
    record = data;
  } else {
    // Fallback: insert basic columns and save meta locally
    const { data: basicData, error: basicErr } = await supabase
      .from("admin")
      .insert({
        username: normalized,
        password: passwordHash
      })
      .select("id, username, password, created_at")
      .single();

    await throwIfError(basicErr, "تعذر إنشاء حساب الأدمن الفرعي");
    record = basicData;
  }

  // Update local meta store
  const meta = readLocalMeta();
  meta[record.id] = {
    role: "sub_admin",
    maxCodesQuota: Number(maxCodesQuota) || 50,
    isActive: true,
    createdBy: createdBy
  };
  writeLocalMeta(meta);

  return mapAdmin(record);
}

async function updateSubAdmin(id, fields) {
  const supabase = getSupabase();
  const meta = readLocalMeta();
  const currentMeta = meta[id] || {};

  const payload = {};
  if (typeof fields.maxCodesQuota === "number") {
    payload.max_codes_quota = fields.maxCodesQuota;
    currentMeta.maxCodesQuota = fields.maxCodesQuota;
  }
  if (typeof fields.isActive === "boolean") {
    payload.is_active = fields.isActive;
    currentMeta.isActive = fields.isActive;
  }
  if (fields.plainPassword && fields.plainPassword.trim().length > 0) {
    payload.password = await hashPassword(fields.plainPassword);
  }

  if (Object.keys(payload).length > 0) {
    // Attempt updating supabase
    try {
      await supabase.from("admin").update(payload).eq("id", id);
    } catch (_) {
      if (payload.password) {
        await supabase.from("admin").update({ password: payload.password }).eq("id", id);
      }
    }
  }

  meta[id] = currentMeta;
  writeLocalMeta(meta);

  return findById(id);
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
    await updatePassword(existing.id, passwordHash);
    const meta = readLocalMeta();
    meta[existing.id] = {
      role: "super_admin",
      maxCodesQuota: 999999,
      isActive: true
    };
    writeLocalMeta(meta);
    return findById(existing.id);
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("admin")
    .insert({
      username: String(username || "").trim().toLowerCase(),
      password: passwordHash
    })
    .select("id, username, password, created_at")
    .single();

  await throwIfError(error, "تعذر إنشاء الحساب الرئيسي");
  const meta = readLocalMeta();
  meta[data.id] = {
    role: "super_admin",
    maxCodesQuota: 999999,
    isActive: true
  };
  writeLocalMeta(meta);
  return mapAdmin(data);
}

module.exports = {
  hashPassword,
  findByUsername,
  findById,
  listAllAdmins,
  listSubAdmins,
  createSubAdmin,
  updateSubAdmin,
  updatePassword,
  upsertFromEnv
};
