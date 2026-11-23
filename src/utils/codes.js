const crypto = require("crypto");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const VALID_ROLES = new Set(["regular", "manager", "manager_user"]);

function isFarzonApp(appId) {
  const normalized = String(appId || "").trim().toUpperCase();
  return normalized === "FARZ_V2" || normalized === "FARZON";
}

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeRole(role) {
  const r = String(role || "regular").trim().toLowerCase();
  return VALID_ROLES.has(r) ? r : "regular";
}

function generateActivationCode(appId = "FARZ_V1") {
  const isFarzon = isFarzonApp(appId);
  const prefix = isFarzon ? "FARZON" : "FARZ";
  const chunk = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${chunk.slice(0, 4)}-${chunk.slice(4, 8)}`;
}

/**
 * Computes expiration date starting from issuance time (matching legacy FARZ/FARZON policy).
 * Preserves existing behavior for days and months while also returning durationDays.
 */
function computeExpiry(durationValue, durationUnit = "days", baseDate = new Date()) {
  const value = Number(durationValue);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error("مدة الصلاحية غير صحيحة (يجب أن تكون رقماً صحيحاً أكبر من 0)");
  }
  if (value > 3650 && durationUnit !== "months") {
    throw new Error("مدة الصلاحية تتجاوز الحد الأقصى المسموح (3650 يوماً)");
  }
  if (value > 120 && durationUnit === "months") {
    throw new Error("مدة الصلاحية تتجاوز الحد الأقصى المسموح (120 شهراً)");
  }

  const start = new Date(baseDate.getTime());
  const expiresAt = new Date(start.getTime());

  if (durationUnit === "months") {
    expiresAt.setMonth(expiresAt.getMonth() + value);
    const durationDays = Math.max(1, Math.round((expiresAt.getTime() - start.getTime()) / MS_PER_DAY));
    return { expiresAt, durationDays, durationLabel: `${value} شهر` };
  }

  expiresAt.setTime(start.getTime() + value * MS_PER_DAY);
  return { expiresAt, durationDays: value, durationLabel: `${value} يوم` };
}

/**
 * Extends or sets a code's expiry date without altering device binding.
 * - addDays: if current expiry is in the future, adds days on top of current expiry;
 *            if already expired, adds days starting from now.
 * - setDaysFromNow: sets expiry strictly to now + N days.
 * - exactExpiresAt: sets expiry to an explicit ISO date/timestamp.
 */
function computeExtendedExpiry(currentExpiresAt, { addDays, setDaysFromNow, exactExpiresAt }, now = new Date()) {
  const nowMs = now.getTime();

  if (exactExpiresAt) {
    const parsed = new Date(exactExpiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("تاريخ الانتهاء المحدد غير صالح");
    }
    const diffDays = Math.max(1, Math.ceil((parsed.getTime() - nowMs) / MS_PER_DAY));
    return {
      expiresAt: parsed,
      durationDays: diffDays,
      durationLabel: `${diffDays} يوم`
    };
  }

  if (setDaysFromNow !== undefined && setDaysFromNow !== null && String(setDaysFromNow).trim() !== "") {
    const days = Number(setDaysFromNow);
    if (!Number.isFinite(days) || !Number.isInteger(days) || days <= 0 || days > 3650) {
      throw new Error("عدد الأيام غير صحيح");
    }
    const expiresAt = new Date(nowMs + days * MS_PER_DAY);
    return {
      expiresAt,
      durationDays: days,
      durationLabel: `${days} يوم`
    };
  }

  const daysToAdd = Number(addDays);
  if (!Number.isFinite(daysToAdd) || !Number.isInteger(daysToAdd) || daysToAdd <= 0 || daysToAdd > 3650) {
    throw new Error("عدد أيام التمديد غير صحيح (يجب أن يكون رقماً صحيحاً أكبر من 0)");
  }

  const existingMs = currentExpiresAt ? new Date(currentExpiresAt).getTime() : 0;
  const baseMs = existingMs > nowMs ? existingMs : nowMs;
  const expiresAt = new Date(baseMs + daysToAdd * MS_PER_DAY);

  return {
    expiresAt,
    addedDays: daysToAdd,
    durationLabel: `+${daysToAdd} يوم`
  };
}

/**
 * Computes remaining time metadata for dashboard display & API responses.
 */
function computeRemainingInfo(expiresAt, now = new Date()) {
  if (!expiresAt) {
    return {
      expired: true,
      remainingMs: 0,
      remainingDays: 0,
      lessThanOneDay: false,
      labelAr: "منتهي الصلاحية",
      expiryDateFormatted: "—"
    };
  }

  const expDate = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  const diffMs = expDate.getTime() - now.getTime();
  const dd = String(expDate.getUTCDate()).padStart(2, "0");
  const mm = String(expDate.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = expDate.getUTCFullYear();
  const expiryDateFormatted = `${dd}/${mm}/${yyyy}`;

  if (diffMs <= 0) {
    return {
      expired: true,
      remainingMs: 0,
      remainingDays: 0,
      lessThanOneDay: false,
      labelAr: `انتهت الصلاحية (${expiryDateFormatted})`,
      expiryDateFormatted
    };
  }

  const fullDays = Math.floor(diffMs / MS_PER_DAY);
  if (fullDays === 0) {
    return {
      expired: false,
      remainingMs: diffMs,
      remainingDays: 0,
      lessThanOneDay: true,
      labelAr: `متبقي أقل من يوم — صالح حتى ${expiryDateFormatted}`,
      expiryDateFormatted
    };
  }

  let dayPhrase;
  if (fullDays === 1) dayPhrase = "يوم واحد";
  else if (fullDays === 2) dayPhrase = "يومان";
  else if (fullDays <= 10) dayPhrase = `${fullDays} أيام`;
  else dayPhrase = `${fullDays} يوماً`;

  return {
    expired: false,
    remainingMs: diffMs,
    remainingDays: fullDays,
    lessThanOneDay: false,
    labelAr: `متبقي ${dayPhrase} — صالح حتى ${expiryDateFormatted}`,
    expiryDateFormatted
  };
}

/**
 * Evaluates license validity with strict separation between:
 * - manager_license_expired: Manager's own activation code expired (blocks Manager ONLY;
 *   does NOT automatically expire manager_user codes while group is active).
 * - manager_group_disabled: Super Admin disabled the Manager's group (blocks Manager
 *   from app/uploads AND instructs manager_user apps to purge/hide manager files while
 *   keeping their personal files usable).
 */
function licenseStatus(record, deviceId, mode = "activate", appId = "FARZ_V1", managerRecord = null, now = new Date()) {
  if (!record) {
    return {
      success: false,
      status: "invalid",
      reason: "invalid",
      message: "كود التفعيل غير صحيح",
      expiresAt: null,
      isActivated: false
    };
  }

  const recordIsFarzon = isFarzonApp(record.appId);
  const incomingIsFarzon = isFarzonApp(appId);
  if (recordIsFarzon !== incomingIsFarzon) {
    return {
      success: false,
      status: "app_mismatch",
      reason: "app_mismatch",
      message: recordIsFarzon
        ? "هذا الكود مخصص لتطبيق فرزون (Farzon) ولا يمكن استخدامه على تطبيق فرز (Farz)"
        : "هذا الكود مخصص لتطبيق فرز (Farz) ولا يمكن استخدامه على تطبيق فرزون (Farzon)",
      expiresAt: null,
      isActivated: false
    };
  }

  const codeRole = normalizeRole(record.codeRole);

  if (record.isBlocked) {
    return {
      success: false,
      status: "blocked",
      reason: codeRole === "manager" ? "manager_code_blocked" : "code_blocked",
      message: "تم حظر هذا الكود من لوحة التحكم",
      expiresAt: record.expiresAt,
      isActivated: record.isActivated
    };
  }

  // Manager's own code: if the manager group itself is disabled by Super Admin, deny access
  if (codeRole === "manager" && managerRecord && managerRecord.isActive === false) {
    return {
      success: false,
      status: "blocked",
      reason: "manager_group_disabled",
      message: "تم تعطيل مجموعة المدير من لوحة التحكم",
      expiresAt: record.expiresAt,
      isActivated: record.isActivated,
      managerActive: false,
      groupStatus: "manager_group_disabled"
    };
  }

  const isExpired = record.isExpired ? record.isExpired(now) : (!record.expiresAt || new Date(record.expiresAt).getTime() <= now.getTime());
  if (isExpired) {
    const expiredReason =
      codeRole === "manager"
        ? "manager_license_expired"
        : codeRole === "manager_user"
          ? "user_license_expired"
          : "license_expired";
    return {
      success: false,
      status: "expired",
      reason: expiredReason,
      message:
        codeRole === "manager"
          ? "انتهت صلاحية كود المدير. يرجى التواصل مع الإدارة لتجديد الصلاحية."
          : "انتهت صلاحية كود التفعيل",
      expiresAt: record.expiresAt,
      isActivated: record.isActivated
    };
  }

  const incomingDevice = String(deviceId || "").trim();
  const boundDevice = record.deviceId ? String(record.deviceId).trim() : "";

  if (mode === "heartbeat") {
    if (!boundDevice || !record.isActivated) {
      return {
        success: false,
        status: "logged_out",
        reason: "logged_out",
        message: "تم تسجيل خروج هذا الجهاز من لوحة التحكم",
        expiresAt: record.expiresAt,
        isActivated: false
      };
    }

    if (boundDevice !== incomingDevice) {
      return {
        success: false,
        status: "device_mismatch",
        reason: "device_mismatch",
        message: "هذا الكود مرتبط بجهاز آخر",
        expiresAt: record.expiresAt,
        isActivated: record.isActivated
      };
    }
  } else if (boundDevice && boundDevice !== incomingDevice) {
    return {
      success: false,
      status: "device_mismatch",
      reason: "device_mismatch",
      message: "هذا الكود مستخدم على جهاز آخر",
      expiresAt: record.expiresAt,
      isActivated: record.isActivated
    };
  }

  // Group status for manager_user:
  // If Super Admin disabled the manager group, the user's own code still works for
  // personal files, while manager files are blocked & purged (groupStatus = manager_group_disabled).
  const managerActive =
    codeRole === "regular"
      ? true
      : managerRecord
        ? managerRecord.isActive !== false
        : true;
  const groupStatus =
    codeRole === "regular"
      ? null
      : managerActive
        ? "active"
        : "manager_group_disabled";

  return {
    success: true,
    status: "valid",
    reason: groupStatus === "manager_group_disabled" ? "manager_group_disabled" : null,
    message: mode === "heartbeat" ? "الترخيص ساري" : "تم تفعيل التطبيق بنجاح",
    expiresAt: record.expiresAt,
    isActivated: true,
    codeRole,
    managerActive,
    groupStatus
  };
}

module.exports = {
  MS_PER_DAY,
  isFarzonApp,
  normalizeCode,
  normalizeRole,
  generateActivationCode,
  computeExpiry,
  computeExtendedExpiry,
  computeRemainingInfo,
  licenseStatus
};
