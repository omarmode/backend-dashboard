const crypto = require("crypto");

function generateActivationCode() {
  const chunk = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `FARZ-${chunk.slice(0, 4)}-${chunk.slice(4, 8)}`;
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

  const recordAppId = String(record.appId || "FARZ_V1").trim().toUpperCase();
  const incomingAppId = String(appId || "FARZ_V1").trim().toUpperCase();
  if (recordAppId !== incomingAppId) {
    const isApp1Code = recordAppId === "FARZ_V1";
    return {
      success: false,
      status: "app_mismatch",
      message: isApp1Code
        ? "هذا الكود مخصص للتطبيق الأول (FARZ 1) ولا يمكن استخدامه على التطبيق الثاني"
        : "هذا الكود مخصص للتطبيق الثاني (FARZ 2) ولا يمكن استخدامه على التطبيق الأول",
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
  generateActivationCode,
  computeExpiry,
  licenseStatus
};
