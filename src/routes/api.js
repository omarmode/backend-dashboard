const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const ActivationCode = require("../models/ActivationCode");
const Admin = require("../models/Admin");
const AdminFile = require("../models/AdminFile");
const { licenseStatus } = require("../utils/codes");

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    status: "rate_limited",
    message: "عدد المحاولات كبير. حاول مرة أخرى بعد دقيقة."
  }
});

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

async function getAdminClientInfo(record) {
  if (!record || !record.createdByAdminId) {
    return { isSubAdminClient: false, adminId: null };
  }
  const admin = await Admin.findById(record.createdByAdminId);
  const isSubAdminClient = Boolean(admin && admin.role === "sub_admin");
  return {
    isSubAdminClient,
    adminId: record.createdByAdminId
  };
}

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "farz-licensing" });
});

router.post("/verify-code", verifyLimiter, async (req, res) => {
  try {
    const code = normalizeCode(req.body?.code);
    const deviceId = String(req.body?.deviceId || "").trim();
    const mode = req.body?.mode === "heartbeat" ? "heartbeat" : "activate";
    const appId = String(req.body?.app_id || req.body?.appId || "FARZ_V1").trim().toUpperCase();

    if (!code || !deviceId) {
      return res.status(400).json({
        success: false,
        status: "invalid",
        message: "يجب إرسال كود التفعيل ومعرف الجهاز",
        expiresAt: null,
        isActivated: false
      });
    }

    const record = await ActivationCode.findByCode(code);
    const result = licenseStatus(record, deviceId, mode, appId);

    if (!result.success) {
      return res.status(200).json(result);
    }

    const now = new Date();
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
    const adminInfo = await getAdminClientInfo(saved);

    return res.json({
      ...result,
      expiresAt: saved.expiresAt,
      isActivated: true,
      isSubAdminClient: adminInfo.isSubAdminClient,
      adminId: adminInfo.adminId
    });
  } catch (error) {
    console.error("verify-code failed:", error);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "تعذر التحقق من الكود حالياً. حاول مرة أخرى.",
      expiresAt: null,
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

    if (!code || !deviceId) {
      return res.status(400).json({
        success: false,
        status: "invalid",
        message: "يجب إرسال كود التفعيل ومعرف الجهاز",
        expiresAt: null,
        isActivated: false
      });
    }

    const record = await ActivationCode.findByCode(code);
    const result = licenseStatus(record, deviceId, "activate", "FARZON");

    if (!result.success) {
      return res.status(200).json(result);
    }

    const now = new Date();
    const updates = {
      isActivated: true,
      deviceId: deviceId,
      lastSeenAt: now.toISOString()
    };
    if (!record.activatedAt) {
      updates.activatedAt = now.toISOString();
    }

    const saved = await ActivationCode.updateCode(record.id, updates);
    const adminInfo = await getAdminClientInfo(saved);

    return res.json({
      success: true,
      status: "valid",
      message: "تم تسجيل وتفعيل جهازك في تطبيق Farzon بنجاح",
      appId: "FARZON",
      code: saved.code,
      deviceId: saved.deviceId,
      clientName: clientName || saved.clientName,
      expiresAt: saved.expiresAt,
      isActivated: true,
      isSubAdminClient: adminInfo.isSubAdminClient,
      adminId: adminInfo.adminId
    });
  } catch (error) {
    console.error("farzon/register api failed:", error);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "تعذر تسجيل وتفعيل الجهاز في Farzon حالياً.",
      expiresAt: null,
      isActivated: false
    });
  }
});

// POST /api/farzon/activity - Dedicated Farzon heartbeat and activity monitoring
router.post("/farzon/activity", verifyLimiter, async (req, res) => {
  try {
    const code = normalizeCode(req.body?.code);
    const deviceId = String(req.body?.deviceId || "").trim();

    if (!code || !deviceId) {
      return res.status(400).json({
        success: false,
        status: "invalid",
        message: "كود النشاط ومعرف الجهاز مطلوبان",
        expiresAt: null,
        isActivated: false
      });
    }

    const record = await ActivationCode.findByCode(code);
    const result = licenseStatus(record, deviceId, "heartbeat", "FARZON");

    if (!result.success) {
      return res.status(200).json(result);
    }

    const now = new Date();
    await ActivationCode.updateCode(record.id, {
      lastSeenAt: now.toISOString()
    });
    const adminInfo = await getAdminClientInfo(record);

    return res.json({
      success: true,
      status: "valid",
      message: "تم تسجيل نشاط جهاز Farzon بنجاح",
      timestamp: now.toISOString(),
      expiresAt: record.expiresAt,
      isActivated: true,
      isSubAdminClient: adminInfo.isSubAdminClient,
      adminId: adminInfo.adminId
    });
  } catch (error) {
    console.error("farzon/activity api failed:", error);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "تعذر تسجيل النشاط حالياً",
      expiresAt: null,
      isActivated: false
    });
  }
});

// ========================================================
// Farzon Data File Distribution & Synchronization Endpoints
// ========================================================

// POST /api/farzon/my-data-files - Get list of files belonging to this client's admin
router.post("/farzon/my-data-files", verifyLimiter, async (req, res) => {
  try {
    const code = normalizeCode(req.body?.code);
    const deviceId = String(req.body?.deviceId || "").trim();

    if (!code || !deviceId) {
      return res.status(400).json({ success: false, message: "الكود ومعرف الجهاز مطلوبان" });
    }

    const record = await ActivationCode.findByCode(code);
    const result = licenseStatus(record, deviceId, "heartbeat", "FARZON");
    if (!result.success) {
      return res.status(403).json({ success: false, message: result.message });
    }

    if (!record.createdByAdminId) {
      return res.json({ success: true, files: [] });
    }

    const files = await AdminFile.listByAdmin(record.createdByAdminId);
    const mappedFiles = files.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      fileSize: f.fileSize,
      recordsCount: f.recordsCount,
      fileHash: f.fileHash,
      version: f.version,
      updatedAt: f.updatedAt ? f.updatedAt.toISOString() : new Date().toISOString()
    }));

    return res.json({ success: true, files: mappedFiles });
  } catch (error) {
    console.error("my-data-files error:", error);
    return res.status(500).json({ success: false, message: "تعذر تحميل قائمة الملفات" });
  }
});

// File download handler (supports GET & POST)
async function handleFileDownload(req, res) {
  try {
    const fileId = req.params.id;
    const code = normalizeCode(req.body?.code || req.query?.code || req.headers["x-license-code"]);
    const deviceId = String(req.body?.deviceId || req.query?.deviceId || req.headers["x-device-id"] || "").trim();

    if (!code || !deviceId) {
      return res.status(400).json({ success: false, message: "بيانات الترخيص ومعرف الجهاز مطلوبة للتحميل" });
    }

    const record = await ActivationCode.findByCode(code);
    const result = licenseStatus(record, deviceId, "heartbeat", "FARZON");
    if (!result.success) {
      return res.status(403).json({ success: false, message: result.message });
    }

    const file = await AdminFile.findById(fileId);
    if (!file || !file.isActive) {
      return res.status(404).json({ success: false, message: "الملف المطلوب غير موجود أو تم حذفه من السيرفر" });
    }

    // Permission check: file must belong to this client's admin
    if (String(file.adminId) !== String(record.createdByAdminId)) {
      return res.status(403).json({ success: false, message: "ليس لديك صلاحية تنزيل هذا الملف" });
    }

    if (!file.storagePath || !fs.existsSync(file.storagePath)) {
      return res.status(404).json({ success: false, message: "الملف الفعلي غير متوفر على السيرفر" });
    }

    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.fileName)}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("X-File-Hash", file.fileHash || "");
    res.setHeader("X-File-Name", encodeURIComponent(file.fileName));

    const fileStream = fs.createReadStream(file.storagePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error("file download error:", error);
    return res.status(500).json({ success: false, message: "تعذر تنزيل الملف حالياً" });
  }
}

router.get("/farzon/files/:id/download", handleFileDownload);
router.post("/farzon/files/:id/download", handleFileDownload);

// POST /api/farzon/sync-files - Sync local admin files with server state
router.post("/farzon/sync-files", verifyLimiter, async (req, res) => {
  try {
    const code = normalizeCode(req.body?.code);
    const deviceId = String(req.body?.deviceId || "").trim();
    const localFileIds = Array.isArray(req.body?.localFileIds) ? req.body.localFileIds : [];

    if (!code || !deviceId) {
      return res.status(400).json({ success: false, message: "الكود ومعرف الجهاز مطلوبان" });
    }

    const record = await ActivationCode.findByCode(code);
    const result = licenseStatus(record, deviceId, "heartbeat", "FARZON");
    if (!result.success) {
      return res.status(403).json({ success: false, message: result.message });
    }

    if (!record.createdByAdminId) {
      return res.json({
        success: true,
        activeFiles: [],
        revokedFileIds: localFileIds
      });
    }

    const activeFiles = await AdminFile.listByAdmin(record.createdByAdminId);
    const activeFileIds = new Set(activeFiles.map((f) => String(f.id)));

    // Remote revocation: files present locally but no longer active on server
    const revokedFileIds = localFileIds.filter((id) => !activeFileIds.has(String(id)));

    return res.json({
      success: true,
      activeFiles: activeFiles.map((f) => ({
        id: f.id,
        fileName: f.fileName,
        fileSize: f.fileSize,
        recordsCount: f.recordsCount,
        fileHash: f.fileHash,
        version: f.version,
        updatedAt: f.updatedAt ? f.updatedAt.toISOString() : new Date().toISOString()
      })),
      revokedFileIds
    });
  } catch (error) {
    console.error("sync-files error:", error);
    return res.status(500).json({ success: false, message: "تعذر مزامنة الملفات" });
  }
});

module.exports = router;
