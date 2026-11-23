const { getSupabase, throwIfError } = require("../config/db");
const { normalizeCode, normalizeRole, computeExtendedExpiry, computeRemainingInfo } = require("../utils/codes");
const { withManagerLock } = require("./Manager");

function mapCode(row) {
  if (!row) {
    return null;
  }

  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const createdAt = row.created_at ? new Date(row.created_at) : null;
  const codeRole = normalizeRole(row.code_role);
  const durationDays =
    Number(row.duration_days) > 0
      ? Number(row.duration_days)
      : expiresAt && createdAt && expiresAt > createdAt
        ? Math.max(1, Math.round((expiresAt.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000)))
        : 0;

  return {
    id: row.id,
    _id: row.id,
    code: row.code,
    isActivated: row.is_active === true,
    isBlocked: row.is_blocked === true,
    deviceId: row.device_id || null,
    expiresAt,
    createdAt,
    durationDays,
    durationLabel: row.duration_label || (durationDays > 0 ? `${durationDays} يوم` : ""),
    clientName: String(row.client_name || "").trim(),
    appId: String(row.app_id || "FARZ_V1").trim().toUpperCase(),
    codeRole,
    managerId: row.manager_id || null,
    activatedAt: row.activated_at ? new Date(row.activated_at) : null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    createdByAdminId: row.created_by_admin_id || null,
    isExpired(now = new Date()) {
      if (!expiresAt) {
        return true;
      }
      return expiresAt.getTime() <= now.getTime();
    },
    remainingInfo(now = new Date()) {
      return computeRemainingInfo(expiresAt, now);
    }
  };
}

async function findByCode(code) {
  const supabase = getSupabase();
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const { data, error } = await supabase
    .from("activation_codes")
    .select("*")
    .eq("code", normalized)
    .maybeSingle();

  await throwIfError(error, "تعذر البحث عن كود التفعيل");
  return mapCode(data);
}

async function findById(id) {
  if (!id) return null;
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

/**
 * Lists activation codes with optional filtering by appId, codeRole, and managerId.
 * Backward-compatible with legacy signature listAll(appIdString).
 */
async function listAll(filter = null) {
  const supabase = getSupabase();
  const opts =
    typeof filter === "string"
      ? { appId: filter }
      : filter && typeof filter === "object"
        ? filter
        : {};

  let query = supabase
    .from("activation_codes")
    .select("*")
    .order("created_at", { ascending: false });

  if (opts.appId) {
    query = query.eq("app_id", opts.appId);
  }
  if (opts.managerId) {
    query = query.eq("manager_id", opts.managerId);
  }

  const { data, error } = await query;
  await throwIfError(error, "تعذر تحميل قائمة الأكواد");

  let list = (data || []).map(mapCode);

  if (opts.codeRole) {
    const wantedRole = normalizeRole(opts.codeRole);
    list = list.filter((item) => item.codeRole === wantedRole);
  }

  return list;
}

async function findManagerCode(managerId) {
  if (!managerId) return null;
  const list = await listAll({ managerId, codeRole: "manager" });
  return list[0] || null;
}

async function listManagerUserCodes(managerId) {
  if (!managerId) return [];
  return listAll({ managerId, codeRole: "manager_user" });
}

async function countManagerUserCodes(managerId) {
  const list = await listManagerUserCodes(managerId);
  return list.length;
}

async function createCode(fields) {
  const supabase = getSupabase();
  const codeRole = normalizeRole(fields.codeRole || "regular");
  const managerId = fields.managerId || null;

  if (codeRole === "regular" && managerId) {
    throw new Error("لا يمكن ربط كود مستخدم عادي بمدير");
  }
  if ((codeRole === "manager" || codeRole === "manager_user") && !managerId) {
    throw new Error("معرف المدير مطلوب لأكواد المديرين ومستخدميهم");
  }

  const basePayload = {
    code: normalizeCode(fields.code),
    expires_at: fields.expiresAt,
    duration_days: Number(fields.durationDays) || 0,
    duration_label: fields.durationLabel || "",
    client_name: String(fields.clientName || "").trim(),
    app_id: String(fields.appId || "FARZ_V1").trim().toUpperCase(),
    code_role: codeRole,
    manager_id: managerId,
    created_by_admin_id: fields.createdByAdminId || null,
    is_active: false,
    is_blocked: false,
    device_id: null,
    activated_at: null,
    last_seen_at: null
  };

  const { data, error } = await supabase
    .from("activation_codes")
    .insert(basePayload)
    .select("*")
    .single();

  if (error) {
    const msg = String(error.message || "");
    if (msg.includes("QUOTA_EXCEEDED")) {
      throw new Error("تم الوصول للحد الأقصى المسموح لعدد مستخدمي هذا المدير");
    }
    if (msg.includes("activation_codes_one_manager_code_idx")) {
      throw new Error("هذا المدير لديه كود مدير بالفعل");
    }
    await throwIfError(error, "تعذر إنشاء كود التفعيل");
  }

  return mapCode(data);
}

/**
 * Atomically issues 1..N manager_user codes for a manager within max_users quota.
 * Uses PostgreSQL RPC `issue_manager_user_codes` (FOR UPDATE lock), with a
 * serialized per-manager mutex fallback for isolated mock/test clients.
 */
async function issueManagerUserCodesAtomic({ managerId, items, createdByAdminId = null }) {
  if (!managerId) {
    throw new Error("معرف المدير مطلوب");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("يجب تحديد كود واحد على الأقل للإصدار");
  }

  return withManagerLock(managerId, async () => {
    const supabase = getSupabase();
    const normalizedItems = items.map((item) => ({
      code: normalizeCode(item.code),
      expires_at: item.expiresAt instanceof Date ? item.expiresAt.toISOString() : item.expiresAt,
      duration_days: Number(item.durationDays) || 30,
      duration_label: item.durationLabel || `${Number(item.durationDays) || 30} يوم`,
      client_name: String(item.clientName || "").trim()
    }));

    // Preferred path: atomic PostgreSQL RPC
    if (typeof supabase.rpc === "function") {
      const { data, error } = await supabase.rpc("issue_manager_user_codes", {
        p_manager_id: managerId,
        p_codes: normalizedItems,
        p_created_by_admin_id: createdByAdminId
      });

      if (!error && Array.isArray(data)) {
        return data.map(mapCode);
      }

      if (error) {
        const msg = String(error.message || "");
        if (msg.includes("QUOTA_EXCEEDED")) {
          throw new Error("عدد الأكواد المطلوب يتجاوز الحصة المتبقية لهذا المدير");
        }
        if (msg.includes("MANAGER_NOT_FOUND")) {
          throw new Error("المدير غير موجود");
        }
        const isRpcMissing = error.code === "PGRST202" || msg.includes("Could not find the function");
        if (!isRpcMissing) {
          await throwIfError(error, "تعذر إصدار أكواد مستخدمي المدير");
        }
      }
    }

    // Serialized fallback (protected by per-manager lock)
    const { data: mgrRow, error: mgrErr } = await supabase
      .from("managers")
      .select("*")
      .eq("id", managerId)
      .maybeSingle();
    await throwIfError(mgrErr, "تعذر قراءة بيانات المدير");
    if (!mgrRow) {
      throw new Error("المدير غير موجود");
    }

    const existingUsers = await listManagerUserCodes(managerId);
    const maxUsers = Number(mgrRow.max_users ?? 0);
    if (existingUsers.length + normalizedItems.length > maxUsers) {
      throw new Error(
        `عدد الأكواد المطلوب (${normalizedItems.length}) يتجاوز الحصة المتبقية (${Math.max(0, maxUsers - existingUsers.length)} من ${maxUsers})`
      );
    }

    const inserted = [];
    for (const item of normalizedItems) {
      const rec = await createCode({
        code: item.code,
        expiresAt: item.expires_at,
        durationDays: item.duration_days,
        durationLabel: item.duration_label,
        clientName: item.client_name,
        appId: "FARZ_V2",
        codeRole: "manager_user",
        managerId,
        createdByAdminId
      });
      inserted.push(rec);
    }
    return inserted;
  });
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
  if (Object.prototype.hasOwnProperty.call(fields, "expiresAt")) {
    payload.expires_at = fields.expiresAt instanceof Date ? fields.expiresAt.toISOString() : fields.expiresAt;
  }
  if (Object.prototype.hasOwnProperty.call(fields, "durationDays")) {
    payload.duration_days = Number(fields.durationDays) || 0;
  }
  if (Object.prototype.hasOwnProperty.call(fields, "durationLabel")) {
    payload.duration_label = String(fields.durationLabel || "");
  }
  if (Object.prototype.hasOwnProperty.call(fields, "clientName")) {
    payload.client_name = String(fields.clientName || "").trim();
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

/**
 * Extends or updates the expiration date of any activation code WITHOUT
 * clearing device_id, is_active, or activated_at (device binding stays intact).
 */
async function extendCode(id, { addDays, setDaysFromNow, exactExpiresAt }, now = new Date()) {
  const record = await findById(id);
  if (!record) {
    throw new Error("كود التفعيل غير موجود");
  }

  const ext = computeExtendedExpiry(record.expiresAt, { addDays, setDaysFromNow, exactExpiresAt }, now);
  const newTotalDays = ext.durationDays
    ? ext.durationDays
    : Math.max(1, (record.durationDays || 0) + (ext.addedDays || 0));

  return updateCode(id, {
    expiresAt: ext.expiresAt.toISOString(),
    durationDays: newTotalDays,
    durationLabel: `${newTotalDays} يوم`
  });
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
  findManagerCode,
  listManagerUserCodes,
  countManagerUserCodes,
  createCode,
  issueManagerUserCodesAtomic,
  updateCode,
  extendCode,
  deleteById
};
