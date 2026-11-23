const { getSupabase, throwIfError } = require("../config/db");

// Per-manager promise lock for environments where PostgreSQL RPC is mocked or unavailable
const managerLocks = new Map();

async function withManagerLock(managerId, task) {
  const key = String(managerId);
  const prev = managerLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  managerLocks.set(key, prev.then(() => next));

  await prev;
  try {
    return await task();
  } finally {
    release();
    if (managerLocks.get(key) === next) {
      managerLocks.delete(key);
    }
  }
}

function mapManager(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: String(row.name || "").trim(),
    maxUsers: Number(row.max_users ?? 0),
    isActive: row.is_active !== false,
    notes: String(row.notes || "").trim(),
    createdByAdminId: row.created_by_admin_id || null,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null
  };
}

async function createManager({ name, maxUsers, notes = "", createdByAdminId = null }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) {
    throw new Error("اسم المدير أو المجموعة مطلوب");
  }
  const quota = Number(maxUsers);
  if (!Number.isInteger(quota) || quota < 0 || quota > 100000) {
    throw new Error("عدد المستخدمين المسموح يجب أن يكون رقماً صحيحاً غير سالب");
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("managers")
    .insert({
      name: cleanName,
      max_users: quota,
      is_active: true,
      notes: String(notes || "").trim(),
      created_by_admin_id: createdByAdminId
    })
    .select("*")
    .single();

  await throwIfError(error, "تعذر إنشاء مجموعة المدير");
  return mapManager(data);
}

async function findById(id) {
  if (!id) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("managers")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  await throwIfError(error, "تعذر قراءة بيانات المدير");
  return mapManager(data);
}

async function listAll() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("managers")
    .select("*")
    .order("created_at", { ascending: false });

  await throwIfError(error, "تعذر تحميل قائمة المديرين");
  return (data || []).map(mapManager);
}

/**
 * Atomically updates a manager's max_users quota.
 * Strictly forbids reducing max_users below the number of already-issued manager_user codes.
 * Never auto-deletes existing user codes.
 */
async function updateQuota(id, newMaxUsers) {
  const quota = Number(newMaxUsers);
  if (!Number.isInteger(quota) || quota < 0 || quota > 100000) {
    throw new Error("قيمة الحصة غير صحيحة (يجب أن تكون رقماً صحيحاً 0 أو أكبر)");
  }

  return withManagerLock(id, async () => {
    const supabase = getSupabase();

    // Preferred path: atomic PostgreSQL RPC with FOR UPDATE lock
    if (typeof supabase.rpc === "function") {
      const { data, error } = await supabase.rpc("update_manager_quota", {
        p_manager_id: id,
        p_new_max_users: quota
      });

      if (!error && data) {
        return mapManager(Array.isArray(data) ? data[0] : data);
      }

      if (error) {
        const msg = String(error.message || "");
        if (msg.includes("QUOTA_BELOW_ISSUED")) {
          throw new Error("لا يمكن تقليل الحصة إلى أقل من عدد أكواد المستخدمين الصادرة بالفعل. احذف أو أدر الأكواد أولاً.");
        }
        if (msg.includes("MANAGER_NOT_FOUND")) {
          throw new Error("المدير غير موجود");
        }
        // Only fall back when RPC function is missing (e.g., unit test mock without RPC)
        const isRpcMissing = error.code === "PGRST202" || msg.includes("Could not find the function");
        if (!isRpcMissing) {
          await throwIfError(error, "تعذر تحديث حصة المدير");
        }
      }
    }

    // Serialized fallback (locked via withManagerLock)
    const manager = await findById(id);
    if (!manager) {
      throw new Error("المدير غير موجود");
    }

    const { data: issuedRows, error: countErr } = await supabase
      .from("activation_codes")
      .select("id")
      .eq("manager_id", id)
      .eq("code_role", "manager_user");
    await throwIfError(countErr, "تعذر التحقق من عدد الأكواد الصادرة");

    const issuedCount = (issuedRows || []).length;
    if (quota < issuedCount) {
      throw new Error(`لا يمكن تقليل الحصة إلى ${quota} لأن عدد أكواد المستخدمين الصادرة بالفعل هو ${issuedCount}`);
    }

    const { data: updated, error: updErr } = await supabase
      .from("managers")
      .update({ max_users: quota, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();

    await throwIfError(updErr, "تعذر تحديث حصة المدير");
    return mapManager(updated);
  });
}

async function setActive(id, isActive) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("managers")
    .update({
      is_active: Boolean(isActive),
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .select("*")
    .single();

  await throwIfError(error, "تعذر تحديث حالة مجموعة المدير");
  return mapManager(data);
}

async function updateDetails(id, { name, notes }) {
  const payload = { updated_at: new Date().toISOString() };
  if (name !== undefined) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("اسم المدير لا يمكن أن يكون فارغاً");
    payload.name = cleanName;
  }
  if (notes !== undefined) {
    payload.notes = String(notes || "").trim();
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("managers")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();

  await throwIfError(error, "تعذر تحديث بيانات المدير");
  return mapManager(data);
}

module.exports = {
  withManagerLock,
  mapManager,
  createManager,
  findById,
  listAll,
  updateQuota,
  setActive,
  updateDetails
};
