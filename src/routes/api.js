const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const rateLimit = require("express-rate-limit");
const ActivationCode = require("../models/ActivationCode");
const Manager = require("../models/Manager");
const ManagerFile = require("../models/ManagerFile");
const {
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MB,
  validateExcelUpload,
  uploadToStorage,
  downloadFromStorage
} = require("../services/storage");
const {
  normalizeCode,
  computeRemainingInfo,
  licenseStatus
} = require("../utils/codes");

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: {
    success: false,
    status: "rate_limited",
    message: "عدد المحاولات كبير. حاول مرة أخرى بعد دقيقة."
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1
  }
});

function extractCredentials(req) {
  // Never read credentials from URL query strings to avoid leaking activation codes in access logs.
  const code = normalizeCode(req.headers["x-license-code"] || req.body?.code);
  const deviceId = String(req.headers["x-device-id"] || req.body?.deviceId || "").trim();
  return { code, deviceId };
}

function formatFileDto(f) {
  return {
    id: f.id,
    fileName: f.fileName,
    fileSize: f.fileSize,
    recordsCount: f.recordsCount,
    fileHash: f.fileHash,
    version: f.version,
    createdAt: f.createdAt ? f.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: f.updatedAt ? f.updatedAt.toISOString() : new Date().toISOString()
  };
}

async function resolveCodeContext(record) {
  if (!record || !record.managerId) {
    return {
      role: record ? record.codeRole : "regular",
      manager: null,
      managerId: null,
      managerName: null,
      managerActive: true,
      groupStatus: null,
      filesCount: 0
    };
  }

  const manager = await Manager.findById(record.managerId);
  const managerActive = Boolean(manager && manager.isActive !== false);
  const groupStatus = managerActive ? "active" : "manager_group_disabled";
  const filesCount = managerActive
    ? await ManagerFile.countActiveByManager(record.managerId)
    : 0;

  return {
    role: record.codeRole,
    manager,
    managerId: record.managerId,
    managerName: manager ? manager.name : null,
    managerActive,
    groupStatus,
    filesCount
  };
}

function buildAuthResponsePayload(record, statusResult, ctx, now) {
  const remaining = computeRemainingInfo(record.expiresAt, now);
  return {
    success: true,
    status: "valid",
    reason: statusResult.reason || null,
    message: statusResult.message,
    appId: record.appId,
    code: record.code,
    deviceId: record.deviceId,
    clientName: record.clientName,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    serverTime: now.toISOString(),
    durationDays: record.durationDays || 0,
    remainingDays: remaining.remainingDays,
    lessThanOneDay: remaining.lessThanOneDay,
    isActivated: true,
    role: ctx.role,
    codeRole: ctx.role,
    managerId: ctx.managerId,
    managerName: ctx.managerName,
    managerActive: ctx.managerActive,
    groupStatus: ctx.groupStatus,
    filesCount: ctx.filesCount,
    // Backward-compatible flags for earlier builds
    isSubAdminClient: ctx.role === "manager_user",
    adminId: ctx.managerId
  };
}

function countExcelRecordsSafe(buffer) {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer", sheetRows: 50000 });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) return 0;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1 });
    return Math.max(0, rows.length - 1);
  } catch (_) {
    return 0;
  }
}

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "farz-licensing", serverTime: new Date().toISOString() });
});

// ============================================================================
// Core Activation & Heartbeat (Backward Compatible: FARZ_V1 + FARZ_V2 / FARZON)
// ============================================================================
router.post("/verify-code", verifyLimiter, async (req, res) => {
  try {
    const code = normalizeCode(req.body?.code);
    const deviceId = String(req.body?.deviceId || "").trim();
    const mode = req.body?.mode === "heartbeat" ? "heartbeat" : "activate";
    const appId = String(req.body?.app_id || req.body?.appId || "FARZ_V1").trim().toUpperCase();
    const now = new Date();

    if (!code || !deviceId) {
      return res.status(400).json({
        success: false,
        status: "invalid",
        reason: "missing_credentials",
        message: "يجب إرسال كود التفعيل ومعرف الجهاز",
        expiresAt: null,
        serverTime: now.toISOString(),
        isActivated: false
      });
    }

    const record = await ActivationCode.findByCode(code);
    const ctx = await resolveCodeContext(record);
    const result = licenseStatus(record, deviceId, mode, appId, ctx.manager, now);

    if (!result.success) {
      return res.status(200).json({
        ...result,
        serverTime: now.toISOString(),
        role: ctx.role,
        codeRole: ctx.role,
        managerId: ctx.managerId,
        managerActive: ctx.managerActive,
        groupStatus: ctx.groupStatus
      });
    }

    const updates = {
      lastSeenAt: now.toISOString()
    };

    if (mode === "activate") {
      updates.isActivated = true;
      updates.deviceId = deviceId;
      if (!record.activatedAt) {
        updates.activatedAt = now.toISOString();
      }
    }

    const saved = await ActivationCode.updateCode(record.id, updates);
    return res.json(buildAuthResponsePayload(saved, result, ctx, now));
  } catch (error) {
    console.error("verify-code failed:", error.message);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "تعذر التحقق من الكود حالياً. حاول مرة أخرى.",
      expiresAt: null,
      serverTime: new Date().toISOString(),
      isActivated: false
    });
  }
});

// POST /api/farzon/register - Dedicated Farzon device registration & activation API
router.post("/farzon/register", verifyLimiter, async (req, res) => {
  try {
    const code = normalizeCode(req.body?.code);
    const deviceId = String(req.body?.deviceId || "").trim();
    const clientName = String(req.body?.clientName || "").trim();
    const now = new Date();

    if (!code || !deviceId) {
      return res.status(400).json({
        success: false,
        status: "invalid",
        reason: "missing_credentials",
        message: "يجب إرسال كود التفعيل ومعرف الجهاز",
        expiresAt: null,
        serverTime: now.toISOString(),
        isActivated: false
      });
    }

    const record = await ActivationCode.findByCode(code);
    const ctx = await resolveCodeContext(record);
    const result = licenseStatus(record, deviceId, "activate", "FARZON", ctx.manager, now);

    if (!result.success) {
      return res.status(200).json({
        ...result,
        serverTime: now.toISOString(),
        role: ctx.role,
        codeRole: ctx.role,
        managerId: ctx.managerId,
        managerActive: ctx.managerActive,
        groupStatus: ctx.groupStatus
      });
    }

    const updates = {
      isActivated: true,
      deviceId,
      lastSeenAt: now.toISOString()
    };
    if (!record.activatedAt) {
      updates.activatedAt = now.toISOString();
    }

    const saved = await ActivationCode.updateCode(record.id, updates);
    const payload = buildAuthResponsePayload(saved, result, ctx, now);
    payload.appId = "FARZON";
    payload.clientName = clientName || saved.clientName;
    payload.message = "تم تسجيل وتفعيل جهازك في تطبيق Farzon بنجاح";

    return res.json(payload);
  } catch (error) {
    console.error("farzon/register api failed:", error.message);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "تعذر تسجيل وتفعيل الجهاز في Farzon حالياً.",
      expiresAt: null,
      serverTime: new Date().toISOString(),
      isActivated: false
    });
  }
});

// POST /api/farzon/activity - Dedicated Farzon heartbeat and activity monitoring
router.post("/farzon/activity", verifyLimiter, async (req, res) => {
  try {
    const code = normalizeCode(req.body?.code);
    const deviceId = String(req.body?.deviceId || "").trim();
    const now = new Date();

    if (!code || !deviceId) {
      return res.status(400).json({
        success: false,
        status: "invalid",
        message: "كود النشاط ومعرف الجهاز مطلوبان",
        expiresAt: null,
        serverTime: now.toISOString(),
        isActivated: false
      });
    }

    const record = await ActivationCode.findByCode(code);
    const ctx = await resolveCodeContext(record);
    const result = licenseStatus(record, deviceId, "heartbeat", "FARZON", ctx.manager, now);

    if (!result.success) {
      return res.status(200).json({
        ...result,
        serverTime: now.toISOString(),
        role: ctx.role,
        codeRole: ctx.role,
        managerId: ctx.managerId,
        managerActive: ctx.managerActive,
        groupStatus: ctx.groupStatus
      });
    }

    await ActivationCode.updateCode(record.id, {
      lastSeenAt: now.toISOString()
    });

    const payload = buildAuthResponsePayload(record, result, ctx, now);
    payload.timestamp = now.toISOString();
    payload.message = "تم تسجيل نشاط جهاز Farzon بنجاح";
    return res.json(payload);
  } catch (error) {
    console.error("farzon/activity api failed:", error.message);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "تعذر تسجيل النشاط حالياً",
      expiresAt: null,
      serverTime: new Date().toISOString(),
      isActivated: false
    });
  }
});

// ============================================================================
// Helper: Authenticate Farzon App Request & Enforce Role / Group Ownership
// ============================================================================
async function authenticateFarzonRequest(req, res, { allowedRoles, requireActiveManagerGroup = true }) {
  const { code, deviceId } = extractCredentials(req);
  const now = new Date();

  if (!code || !deviceId) {
    res.status(400).json({
      success: false,
      status: "invalid",
      reason: "missing_credentials",
      message: "بيانات الترخيص ومعرف الجهاز مطلوبة",
      serverTime: now.toISOString()
    });
    return null;
  }

  const record = await ActivationCode.findByCode(code);
  const ctx = await resolveCodeContext(record);
  const status = licenseStatus(record, deviceId, "heartbeat", "FARZON", ctx.manager, now);

  if (!status.success) {
    res.status(403).json({
      success: false,
      status: status.status,
      reason: status.reason,
      message: status.message,
      shouldPurgeAll: true,
      serverTime: now.toISOString()
    });
    return null;
  }

  if (!allowedRoles.includes(ctx.role)) {
    res.status(403).json({
      success: false,
      status: "forbidden_role",
      reason: "forbidden_role",
      message: "لا يملك هذا الكود صلاحية تنفيذ هذا الإجراء",
      serverTime: now.toISOString()
    });
    return null;
  }

  if (!ctx.managerId || !ctx.manager) {
    res.status(403).json({
      success: false,
      status: "no_manager_group",
      reason: "no_manager_group",
      message: "هذا الكود غير مرتبط بمجموعة مدير",
      shouldPurgeAll: true,
      serverTime: now.toISOString()
    });
    return null;
  }

  if (requireActiveManagerGroup && !ctx.managerActive) {
    res.status(403).json({
      success: false,
      status: "manager_group_disabled",
      reason: "manager_group_disabled",
      message: "تم تعطيل مجموعة المدير من لوحة التحكم — ملفات المجموعة محجوبة مؤقتاً",
      managerActive: false,
      groupStatus: "manager_group_disabled",
      shouldPurgeAll: true,
      serverTime: now.toISOString()
    });
    return null;
  }

  return { record, ctx, now };
}

// ============================================================================
// Manager In-App File Management Endpoints (code_role === 'manager' ONLY)
// ============================================================================
function handleSingleUploadMiddleware(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        status: "file_too_large",
        message: `حجم الملف يتجاوز الحد الأقصى المسموح (${MAX_FILE_SIZE_MB} ميجابايت)`
      });
    }
    return res.status(400).json({
      success: false,
      status: "upload_error",
      message: err.message || "تعذر استلام الملف المرفوع"
    });
  });
}

// POST /api/farzon/manager/files/upload
router.post("/farzon/manager/files/upload", verifyLimiter, handleSingleUploadMiddleware, async (req, res) => {
  try {
    const auth = await authenticateFarzonRequest(req, res, {
      allowedRoles: ["manager"],
      requireActiveManagerGroup: true
    });
    if (!auth) return;

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        status: "missing_file",
        message: "يرجى إرفاق ملف Excel صالح للرفع"
      });
    }

    // Prefer explicit UTF-8 filename header/field if provided (avoids multer latin1 corruption of Arabic filenames)
    const rawFileName =
      (req.headers["x-file-name"] ? decodeURIComponent(String(req.headers["x-file-name"])) : null) ||
      req.body?.fileName ||
      req.file.originalname;

    let validated;
    try {
      validated = validateExcelUpload(rawFileName, req.file.buffer);
    } catch (validationErr) {
      return res.status(400).json({
        success: false,
        status: "invalid_file",
        message: validationErr.message
      });
    }

    const fileId = crypto.randomUUID();
    const recordsCount = countExcelRecordsSafe(req.file.buffer);

    const { bucket, storagePath } = await uploadToStorage({
      managerId: auth.ctx.managerId,
      fileId,
      ext: validated.ext,
      buffer: req.file.buffer,
      contentType: validated.contentType
    });

    const created = await ManagerFile.createFile({
      id: fileId,
      managerId: auth.ctx.managerId,
      uploadedByCodeId: auth.record.id,
      fileName: validated.cleanName,
      fileSize: validated.fileSize,
      recordsCount,
      storageBucket: bucket,
      storagePath,
      fileHash: validated.fileHash
    });

    const allFiles = await ManagerFile.listActiveByManager(auth.ctx.managerId);

    return res.status(201).json({
      success: true,
      message: `تم رفع الملف (${created.fileName}) لمستخدمي مجموعتك بنجاح`,
      file: formatFileDto(created),
      filesCount: allFiles.length,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    console.error("manager/files/upload error:", error.message);
    return res.status(500).json({
      success: false,
      status: "error",
      message: error.message || "تعذر رفع الملف إلى السيرفر حالياً"
    });
  }
});

// POST /api/farzon/manager/files/list
router.post("/farzon/manager/files/list", verifyLimiter, async (req, res) => {
  try {
    const auth = await authenticateFarzonRequest(req, res, {
      allowedRoles: ["manager"],
      requireActiveManagerGroup: true
    });
    if (!auth) return;

    const files = await ManagerFile.listActiveByManager(auth.ctx.managerId);
    return res.json({
      success: true,
      managerId: auth.ctx.managerId,
      managerName: auth.ctx.managerName,
      files: files.map(formatFileDto),
      filesCount: files.length,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    console.error("manager/files/list error:", error.message);
    return res.status(500).json({
      success: false,
      message: "تعذر تحميل قائمة ملفات المجموعة"
    });
  }
});

// POST /api/farzon/manager/files/:id/delete
router.post("/farzon/manager/files/:id/delete", verifyLimiter, async (req, res) => {
  try {
    const auth = await authenticateFarzonRequest(req, res, {
      allowedRoles: ["manager"],
      requireActiveManagerGroup: true
    });
    if (!auth) return;

    const fileId = String(req.params.id || "").trim();
    const existing = await ManagerFile.findById(fileId);
    if (!existing) {
      return res.status(404).json({
        success: false,
        status: "not_found",
        message: "الملف غير موجود"
      });
    }

    if (String(existing.managerId) !== String(auth.ctx.managerId)) {
      return res.status(403).json({
        success: false,
        status: "forbidden_group",
        message: "ليس لديك صلاحية حذف ملف تابع لمجموعة أخرى"
      });
    }

    await ManagerFile.deleteFile(fileId, auth.ctx.managerId);
    const remaining = await ManagerFile.listActiveByManager(auth.ctx.managerId);

    return res.json({
      success: true,
      message: `تم حذف الملف (${existing.fileName}) من السيرفر وسيُحذف من أجهزة مستخدميك عند المزامنة`,
      deletedFileId: fileId,
      filesCount: remaining.length,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    const code = error.statusCode || 500;
    console.error("manager/files/delete error:", error.message);
    return res.status(code).json({
      success: false,
      message: error.message || "تعذر حذف الملف حالياً"
    });
  }
});

// ============================================================================
// Manager-User Protected Data File Distribution & Synchronization Endpoints
// ============================================================================

// POST /api/farzon/my-data-files
router.post("/farzon/my-data-files", verifyLimiter, async (req, res) => {
  try {
    const auth = await authenticateFarzonRequest(req, res, {
      allowedRoles: ["manager_user", "manager"],
      requireActiveManagerGroup: true
    });
    if (!auth) return;

    const files = await ManagerFile.listActiveByManager(auth.ctx.managerId);
    return res.json({
      success: true,
      managerId: auth.ctx.managerId,
      managerName: auth.ctx.managerName,
      managerActive: true,
      groupStatus: "active",
      files: files.map(formatFileDto),
      filesCount: files.length,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    console.error("my-data-files error:", error.message);
    return res.status(500).json({ success: false, message: "تعذر تحميل قائمة ملفات المدير" });
  }
});

// POST /api/farzon/files/:id/download — POST ONLY (no credentials in URL query string!)
router.post("/farzon/files/:id/download", verifyLimiter, async (req, res) => {
  try {
    const auth = await authenticateFarzonRequest(req, res, {
      allowedRoles: ["manager_user", "manager"],
      requireActiveManagerGroup: true
    });
    if (!auth) return;

    const fileId = String(req.params.id || "").trim();
    const file = await ManagerFile.findById(fileId);
    if (!file || !file.isActive) {
      return res.status(404).json({
        success: false,
        status: "not_found",
        message: "الملف المطلوب غير موجود أو تم حذفه من السيرفر"
      });
    }

    // Strict group isolation: reject any attempt to download another manager's fileId
    if (String(file.managerId) !== String(auth.ctx.managerId)) {
      return res.status(403).json({
        success: false,
        status: "forbidden_group",
        message: "ليس لديك صلاحية تنزيل ملفات مجموعة أخرى"
      });
    }

    const buffer = await downloadFromStorage({
      storagePath: file.storagePath,
      bucket: file.storageBucket
    });

    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.fileName)}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("X-File-Id", file.id);
    res.setHeader("X-File-Hash", file.fileHash || "");
    res.setHeader("X-File-Name", encodeURIComponent(file.fileName));
    res.setHeader("Content-Length", String(buffer.length));

    return res.status(200).send(buffer);
  } catch (error) {
    console.error("file download error:", error.message);
    return res.status(500).json({
      success: false,
      message: "تعذر تنزيل الملف المحمي حالياً"
    });
  }
});

// Explicitly reject insecure GET downloads so license codes are never passed in URLs
router.get("/farzon/files/:id/download", (_req, res) => {
  return res.status(405).json({
    success: false,
    status: "method_not_allowed",
    message: "طريقة التحميل عبر GET غير مسموحة لأسباب أمنية. استخدم POST."
  });
});

// POST /api/farzon/sync-files — Sync local encrypted vault with server state
router.post("/farzon/sync-files", verifyLimiter, async (req, res) => {
  try {
    const { code, deviceId } = extractCredentials(req);
    const localFileIds = Array.isArray(req.body?.localFileIds)
      ? req.body.localFileIds.map((id) => String(id))
      : [];
    const now = new Date();

    if (!code || !deviceId) {
      return res.status(400).json({
        success: false,
        status: "invalid",
        message: "الكود ومعرف الجهاز مطلوبان",
        serverTime: now.toISOString()
      });
    }

    const record = await ActivationCode.findByCode(code);
    const ctx = await resolveCodeContext(record);
    const status = licenseStatus(record, deviceId, "heartbeat", "FARZON", ctx.manager, now);

    if (!status.success) {
      return res.status(403).json({
        success: false,
        status: status.status,
        reason: status.reason,
        message: status.message,
        activeFiles: [],
        revokedFileIds: localFileIds,
        shouldPurgeAll: true,
        serverTime: now.toISOString()
      });
    }

    // Regular users have no manager group -> purge any stale vault files if present
    if (ctx.role === "regular" || !ctx.managerId) {
      return res.json({
        success: true,
        activeFiles: [],
        revokedFileIds: localFileIds,
        shouldPurgeAll: localFileIds.length > 0,
        managerActive: true,
        groupStatus: null,
        reason: null,
        serverTime: now.toISOString()
      });
    }

    // Manager group disabled by Super Admin -> immediately revoke & purge manager files
    // while keeping user's own code valid for personal files!
    if (!ctx.managerActive) {
      return res.json({
        success: true,
        activeFiles: [],
        revokedFileIds: localFileIds,
        shouldPurgeAll: true,
        managerActive: false,
        groupStatus: "manager_group_disabled",
        reason: "manager_group_disabled",
        message: "تم تعطيل مجموعة المدير — تم إيقاف ملفات المجموعة مؤقتاً مع الحفاظ على ملفاتك الشخصية",
        serverTime: now.toISOString()
      });
    }

    const activeFiles = await ManagerFile.listActiveByManager(ctx.managerId);
    const activeIds = new Set(activeFiles.map((f) => String(f.id)));
    const revokedFileIds = localFileIds.filter((id) => !activeIds.has(String(id)));

    return res.json({
      success: true,
      activeFiles: activeFiles.map(formatFileDto),
      revokedFileIds,
      shouldPurgeAll: false,
      managerActive: true,
      groupStatus: "active",
      reason: null,
      filesCount: activeFiles.length,
      serverTime: now.toISOString()
    });
  } catch (error) {
    console.error("sync-files error:", error.message);
    return res.status(500).json({
      success: false,
      message: "تعذر مزامنة الملفات حالياً",
      serverTime: new Date().toISOString()
    });
  }
});

module.exports = router;
