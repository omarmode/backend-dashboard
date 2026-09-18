const crypto = require("crypto");

function isFarzonApp(appId) {
  const normalized = String(appId || "").trim().toUpperCase();
  return normalized === "FARZ_V2" || normalized === "FARZON";
}

function generateActivationCode(appId = "FARZ_V1") {
  const isFarzon = isFarzonApp(appId);
  const prefix = isFarzon ? "FARZON" : "FARZ";
  const chunk = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${chunk.slice(0, 4)}-${chunk.slice(4, 8)}`;
}

function computeExpiry(durationValue, durationUnit) {
  const value = Number(durationValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("مدة الصلاحية غير صحيحة");
  }

  const expiresAt = new Date();
  if (durationUnit === "months") {
    expiresAt.setMonth(expiresAt.getMonth() + value);
    return { expiresAt, durationLabel: `${value} شهر` };
  }

  expiresAt.setDate(expiresAt.getDate() + value);
  return { expiresAt, durationLabel: `${value} يوم` };
}

function licenseStatus(record, deviceId, mode = "activate", appId = "FARZ_V1") {
  if (!record) {
    return {
      success: false,
      status: "invalid",
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
      message: recordIsFarzon
        ? "هذا الكود مخصص لتطبيق فرزون (Farzon) ولا يمكن استخدامه على تطبيق فرز (Farz)"
        : "هذا الكود مخصص لتطبيق فرز (Farz) ولا يمكن استخدامه على تطبيق فرزون (Farzon)",
      expiresAt: null,
      isActivated: false
    };
  }

  if (record.isBlocked) {
    return {
      success: false,
      status: "blocked",
      message: "تم حظر هذا الكود من لوحة التحكم",
      expiresAt: record.expiresAt,
      isActivated: record.isActivated
    };
  }

  if (record.isExpired()) {
    return {
      success: false,
      status: "expired",
      message: "انتهت صلاحية كود التفعيل",
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
        message: "تم تسجيل خروج هذا الجهاز من لوحة التحكم",
        expiresAt: record.expiresAt,
        isActivated: false
      };
    }

    if (boundDevice !== incomingDevice) {
      return {
        success: false,
        status: "device_mismatch",
        message: "هذا الكود مرتبط بجهاز آخر",
        expiresAt: record.expiresAt,
        isActivated: record.isActivated
      };
    }

    return {
      success: true,
      status: "valid",
      message: "الترخيص ساري",
      expiresAt: record.expiresAt,
      isActivated: true
    };
  }

  if (boundDevice && boundDevice !== incomingDevice) {
    return {
      success: false,
      status: "device_mismatch",
      message: "هذا الكود مستخدم على جهاز آخر",
      expiresAt: record.expiresAt,
      isActivated: record.isActivated
    };
  }

  return {
    success: true,
    status: "valid",
    message: "تم تفعيل التطبيق بنجاح",
    expiresAt: record.expiresAt,
    isActivated: true
  };
}

module.exports = {
  isFarzonApp,
  generateActivationCode,
  computeExpiry,
  licenseStatus
};
