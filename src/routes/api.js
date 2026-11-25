const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const ActivationCode = require("../models/ActivationCode");
const Manager = require("../models/Manager");
const ManagerFile = require("../models/ManagerFile");
const {
  DEFAULT_BUCKET,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MB,
  MAX_DIRECT_UPLOAD_BYTES,
  MAX_DIRECT_UPLOAD_MB,
  TUS_CHUNK_SIZE_BYTES,
  UPLOAD_SESSION_TTL_MS,
  SIGNED_DOWNLOAD_TTL_SECONDS,
  validateExcelMetadata,
  validateExcelMagicBytes,
  validateExcelFileOnDisk,
  buildManagerStoragePath,
  signUploadSession,
  verifyUploadSession,
  createSignedResumableUpload,
  getStorageObjectInfo,
  readStorageObjectHeaderBytes,
  createSignedDownloadUrl,
  uploadFilePathToStorage,
  downloadFromStorage,
  removeFromStorage,
  cleanupStaleOrphanObjects
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

// Legacy /upload uses diskStorage (os.tmpdir) instead of memoryStorage so Render Free (512 MB RAM)
// never buffers full legacy uploads in heap. Temp files are always unlinked in finally.
const legacyDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, _file, cb) => cb(null, `farzon_legacy_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.tmp`)
});

const upload = multer({
  storage: legacyDiskStorage,
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

function clampRecordsCount(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.min(5_000_000, Math.trunc(num));
}

function sanitizeSha256Hex(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : "";
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
// Manager Direct Signed TUS Resumable Upload Endpoints (v2.0.3+ — 40–50 MB Safe)
// Flow: Android -> /upload/init -> Direct Supabase Signed TUS -> /upload/complete
// Zero file payload bytes ever enter Render RAM!
// ============================================================================

// POST /api/farzon/manager/files/upload/init
router.post("/farzon/manager/files/upload/init", verifyLimiter, async (req, res) => {
  try {
    const auth = await authenticateFarzonRequest(req, res, {
      allowedRoles: ["manager"],
      requireActiveManagerGroup: true
    });
    if (!auth) return;

    const existingSessionToken = typeof req.body?.uploadSessionToken === "string"
      ? req.body.uploadSessionToken.trim()
      : "";

    // Token refresh path: re-issue a fresh short-lived Supabase x-signature token for an existing
    // valid upload session belonging to the exact same manager & file path (supports resume after expiry).
    if (existingSessionToken) {
      const verified = verifyUploadSession(existingSessionToken);
      if (!verified.valid) {
        return res.status(400).json({
          success: false,
          status: verified.reason || "invalid_session",
          message: verified.reason === "session_expired"
            ? "انتهت صلاحية جلسة الرفع — يرجى بدء رفع جديد"
            : "جلسة الرفع غير صالحة"
        });
      }
      const sess = verified.payload;
      if (String(sess.mid) !== String(auth.ctx.managerId)) {
        return res.status(403).json({
          success: false,
          status: "forbidden_group",
          message: "جلسة الرفع لا تخص مجموعة هذا المدير"
        });
      }

      const existingRow = await ManagerFile.findById(sess.fid);
      if (existingRow && existingRow.isActive) {
        const allFiles = await ManagerFile.listActiveByManager(auth.ctx.managerId);
        return res.status(200).json({
          success: true,
          alreadyCompleted: true,
          file: formatFileDto(existingRow),
          filesCount: allFiles.length,
          serverTime: new Date().toISOString()
        });
      }

      const signed = await createSignedResumableUpload({
        managerId: auth.ctx.managerId,
        fileId: sess.fid,
        ext: sess.ext,
        upsert: true,
        bucket: sess.b || DEFAULT_BUCKET
      });

      return res.status(200).json({
        success: true,
        refreshed: true,
        uploadSessionToken: existingSessionToken,
        sessionId: sess.sid,
        fileId: sess.fid,
        bucket: signed.bucket,
        storagePath: signed.storagePath,
        fileName: sess.fn,
        contentType: sess.ct,
        tusEndpoint: signed.tusEndpoint,
        tusToken: signed.token,
        tusHeaders: signed.tusHeaders,
        tusMetadata: {
          bucketName: signed.bucket,
          objectName: signed.storagePath,
          contentType: sess.ct,
          cacheControl: "3600"
        },
        chunkSizeBytes: TUS_CHUNK_SIZE_BYTES,
        maxFileSizeBytes: MAX_DIRECT_UPLOAD_BYTES,
        maxFileSizeMb: MAX_DIRECT_UPLOAD_MB,
        tokenExpiresInSeconds: 7200,
        sessionExpiresAt: new Date(sess.exp).toISOString(),
        serverTime: new Date().toISOString()
      });
    }

    // New upload session path: validate declared metadata strictly on backend
    const rawFileName = req.body?.fileName || req.body?.name;
    const rawFileSize = req.body?.fileSize ?? req.body?.size;
    let meta;
    try {
      meta = validateExcelMetadata({
        fileName: rawFileName,
        fileSize: rawFileSize,
        maxBytes: MAX_DIRECT_UPLOAD_BYTES,
        maxMb: MAX_DIRECT_UPLOAD_MB
      });
    } catch (validationErr) {
      return res.status(validationErr.statusCode || 400).json({
        success: false,
        status: validationErr.errorCode || "invalid_file",
        maxFileSizeBytes: MAX_DIRECT_UPLOAD_BYTES,
        maxFileSizeMb: MAX_DIRECT_UPLOAD_MB,
        message: validationErr.message
      });
    }

    const fileId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const storagePath = buildManagerStoragePath(auth.ctx.managerId, fileId, meta.ext);
    const signed = await createSignedResumableUpload({
      managerId: auth.ctx.managerId,
      fileId,
      ext: meta.ext,
      upsert: false,
      bucket: DEFAULT_BUCKET
    });

    const nowMs = Date.now();
    const expMs = nowMs + UPLOAD_SESSION_TTL_MS;
    const sessionPayload = {
      v: 1,
      sid: sessionId,
      fid: fileId,
      mid: String(auth.ctx.managerId),
      cid: String(auth.record.id),
      b: signed.bucket,
      p: storagePath,
      fn: meta.cleanName,
      ext: meta.ext,
      ct: meta.contentType,
      sz: meta.fileSize,
      h: sanitizeSha256Hex(req.body?.fileHash),
      rc: clampRecordsCount(req.body?.recordsCount),
      iat: nowMs,
      exp: expMs
    };
    const uploadSessionToken = signUploadSession(sessionPayload);

    return res.status(200).json({
      success: true,
      uploadSessionToken,
      sessionId,
      fileId,
      bucket: signed.bucket,
      storagePath,
      fileName: meta.cleanName,
      contentType: meta.contentType,
      tusEndpoint: signed.tusEndpoint,
      tusToken: signed.token,
      tusHeaders: signed.tusHeaders,
      tusMetadata: {
        bucketName: signed.bucket,
        objectName: storagePath,
        contentType: meta.contentType,
        cacheControl: "3600"
      },
      chunkSizeBytes: TUS_CHUNK_SIZE_BYTES,
      maxFileSizeBytes: MAX_DIRECT_UPLOAD_BYTES,
      maxFileSizeMb: MAX_DIRECT_UPLOAD_MB,
      tokenExpiresInSeconds: 7200,
      sessionExpiresAt: new Date(expMs).toISOString(),
      serverTime: new Date(nowMs).toISOString()
    });
  } catch (error) {
    console.error("manager/files/upload/init error:", error.message);
    return res.status(500).json({
      success: false,
      status: "error",
      message: error.message || "تعذر تجهيز تفويض الرفع السحابي حالياً"
    });
  }
});

// POST /api/farzon/manager/files/upload/complete
router.post("/farzon/manager/files/upload/complete", verifyLimiter, async (req, res) => {
  try {
    const auth = await authenticateFarzonRequest(req, res, {
      allowedRoles: ["manager"],
      requireActiveManagerGroup: true
    });
    if (!auth) return;

    const sessionToken = typeof req.body?.uploadSessionToken === "string"
      ? req.body.uploadSessionToken.trim()
      : "";
    const verified = verifyUploadSession(sessionToken);
    if (!verified.valid) {
      return res.status(400).json({
        success: false,
        status: verified.reason || "invalid_session",
        message: verified.reason === "session_expired"
          ? "انتهت صلاحية جلسة الرفع"
          : "جلسة إكمال الرفع غير صالحة"
      });
    }

    const sess = verified.payload;
    if (String(sess.mid) !== String(auth.ctx.managerId)) {
      return res.status(403).json({
        success: false,
        status: "forbidden_group",
        message: "ليس لديك صلاحية إكمال رفع تابع لمجموعة أخرى"
      });
    }

    // Strict storage path prefix enforcement (defense-in-depth)
    const expectedPath = buildManagerStoragePath(auth.ctx.managerId, sess.fid, sess.ext);
    if (sess.p !== expectedPath) {
      return res.status(403).json({
        success: false,
        status: "invalid_storage_path",
        message: "مسار التخزين غير مطابق لمجموعة المدير"
      });
    }

    // Idempotency: if /complete was already processed for this exact fileId, return the existing record
    // without creating duplicates in manager_files!
    const existing = await ManagerFile.findById(sess.fid);
    if (existing) {
      if (String(existing.managerId) !== String(auth.ctx.managerId)) {
        return res.status(403).json({
          success: false,
          status: "forbidden_group",
          message: "معرف الملف تابع لمجموعة أخرى"
        });
      }
      if (!existing.isActive) {
        return res.status(409).json({
          success: false,
          status: "file_deleted",
          message: "تم حذف هذا الملف مسبقاً"
        });
      }
      const allFiles = await ManagerFile.listActiveByManager(auth.ctx.managerId);
      return res.status(200).json({
        success: true,
        alreadyCompleted: true,
        message: `تم رفع الملف (${existing.fileName}) لمستخدمي مجموعتك بنجاح`,
        file: formatFileDto(existing),
        filesCount: allFiles.length,
        serverTime: new Date().toISOString()
      });
    }

    // Verify object genuinely exists in Supabase Storage and check real stored size (0 file bytes in RAM!)
    const objectInfo = await getStorageObjectInfo({
      storagePath: expectedPath,
      bucket: sess.b || DEFAULT_BUCKET
    });
    if (!objectInfo.exists) {
      return res.status(409).json({
        success: false,
        status: "upload_incomplete",
        message: "لم يكتمل رفع الملف إلى التخزين السحابي بعد"
      });
    }
    if (objectInfo.size <= 0 || objectInfo.size > MAX_DIRECT_UPLOAD_BYTES) {
      await removeFromStorage({ storagePath: expectedPath, bucket: sess.b || DEFAULT_BUCKET });
      return res.status(objectInfo.size > MAX_DIRECT_UPLOAD_BYTES ? 413 : 400).json({
        success: false,
        status: objectInfo.size > MAX_DIRECT_UPLOAD_BYTES ? "file_too_large" : "invalid_size",
        message: objectInfo.size > MAX_DIRECT_UPLOAD_BYTES
          ? `حجم الملف الفعلي يتجاوز الحد الأقصى المسموح (${MAX_DIRECT_UPLOAD_MB} ميجابايت)`
          : "الملف المرفوع فارغ"
      });
    }
    if (sess.sz > 0 && objectInfo.size !== sess.sz) {
      return res.status(409).json({
        success: false,
        status: "size_mismatch",
        expectedSize: sess.sz,
        actualSize: objectInfo.size,
        message: "حجم الملف المستلم في التخزين لا يطابق الحجم الأصلي — يرجى استكمال الرفع"
      });
    }

    // Low-memory integrity verification: fetch ONLY first 64 bytes via HTTP Range to verify Excel signature
    try {
      const headBytes = await readStorageObjectHeaderBytes({
        storagePath: expectedPath,
        bucket: sess.b || DEFAULT_BUCKET,
        maxBytes: 64
      });
      validateExcelMagicBytes(sess.ext, headBytes);
    } catch (sigErr) {
      await removeFromStorage({ storagePath: expectedPath, bucket: sess.b || DEFAULT_BUCKET });
      return res.status(400).json({
        success: false,
        status: "invalid_file",
        message: sigErr.message || "محتوى الملف المرفوع لا يطابق صيغة Excel الصالحة"
      });
    }

    // Server-verified fileSize & etag; client hash/recordsCount are only accepted if strictly sanitized
    const clientHash = sanitizeSha256Hex(req.body?.fileHash || sess.h);
    const verifiedHash = clientHash || String(objectInfo.etag || "").replace(/"/g, "");
    const safeRecordsCount = clampRecordsCount(req.body?.recordsCount ?? sess.rc);

    const created = await ManagerFile.createFile({
      id: sess.fid,
      managerId: auth.ctx.managerId,
      uploadedByCodeId: auth.record.id,
      fileName: sess.fn,
      fileSize: objectInfo.size,
      recordsCount: safeRecordsCount,
      storageBucket: sess.b || DEFAULT_BUCKET,
      storagePath: expectedPath,
      fileHash: verifiedHash
    });

    const allFiles = await ManagerFile.listActiveByManager(auth.ctx.managerId);

    // Non-blocking best-effort cleanup of stale (>24h) unreferenced objects for this manager only
    ManagerFile.listAllPathsByManager(auth.ctx.managerId)
      .then((knownPaths) => cleanupStaleOrphanObjects({
        managerId: auth.ctx.managerId,
        knownStoragePaths: knownPaths,
        bucket: sess.b || DEFAULT_BUCKET
      }))
      .catch(() => {});

    return res.status(201).json({
      success: true,
      alreadyCompleted: false,
      message: `تم رفع الملف (${created.fileName}) لمستخدمي مجموعتك بنجاح`,
      file: formatFileDto(created),
      filesCount: allFiles.length,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    console.error("manager/files/upload/complete error:", error.message);
    return res.status(500).json({
      success: false,
      status: "error",
      message: error.message || "تعذر تأكيد حفظ الملف المرفوع حالياً"
    });
  }
});

// ============================================================================
// Legacy Manager Upload Endpoint (Kept 100% Backward Compatible for v2.0.1 / v2.0.2)
// Hardened: diskStorage + streaming validation + ZERO XLSX.read OOM in Render RAM
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
  const tempPath = req.file?.path || null;
  try {
    const auth = await authenticateFarzonRequest(req, res, {
      allowedRoles: ["manager"],
      requireActiveManagerGroup: true
    });
    if (!auth) return;

    if (!req.file || !tempPath) {
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
      validated = await validateExcelFileOnDisk(rawFileName, tempPath, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB);
    } catch (validationErr) {
      return res.status(validationErr.statusCode || 400).json({
        success: false,
        status: validationErr.errorCode || "invalid_file",
        message: validationErr.message
      });
    }

    const fileId = crypto.randomUUID();
    const recordsCount = clampRecordsCount(req.headers["x-records-count"] || req.body?.recordsCount || 0);

    const { bucket, storagePath } = await uploadFilePathToStorage({
      managerId: auth.ctx.managerId,
      fileId,
      ext: validated.ext,
      filePath: tempPath,
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
  } finally {
    if (tempPath) {
      fs.promises.unlink(tempPath).catch(() => {});
    }
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

// POST /api/farzon/files/:id/download-url — Short-lived Signed Download URL for large files (40–50 MB)
// Enforces role (manager_user / manager), active group, and strict manager_id group ownership BEFORE signing.
// Allows Android to stream directly from Supabase Storage into encrypted local Vault without passing through Render RAM.
router.post("/farzon/files/:id/download-url", verifyLimiter, async (req, res) => {
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

    if (String(file.managerId) !== String(auth.ctx.managerId)) {
      return res.status(403).json({
        success: false,
        status: "forbidden_group",
        message: "ليس لديك صلاحية تنزيل ملفات مجموعة أخرى"
      });
    }

    const signed = await createSignedDownloadUrl({
      storagePath: file.storagePath,
      bucket: file.storageBucket || DEFAULT_BUCKET,
      expiresInSeconds: SIGNED_DOWNLOAD_TTL_SECONDS
    });

    return res.status(200).json({
      success: true,
      fileId: file.id,
      fileName: file.fileName,
      fileSize: file.fileSize,
      fileHash: file.fileHash || "",
      version: file.version,
      signedDownloadUrl: signed.signedUrl,
      expiresInSeconds: signed.expiresInSeconds,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    console.error("file download-url error:", error.message);
    return res.status(500).json({
      success: false,
      message: "تعذر تجهيز رابط تنزيل الملف المحمي حالياً"
    });
  }
});

// POST /api/farzon/files/:id/download — POST ONLY (Legacy compatibility for v2.0.1 / v2.0.2)
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
