const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const XLSX = require("xlsx");
const Admin = require("../models/Admin");
const ActivationCode = require("../models/ActivationCode");
const AdminFile = require("../models/AdminFile");
const { requireAdmin, requireSuperAdmin } = require("../middleware/auth");
const { generateActivationCode, computeExpiry, isFarzonApp } = require("../utils/codes");

const router = express.Router();

// Multer storage configuration for Admin Excel files
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, "../../uploads/admin_files");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `admin_${req.admin.id}_${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: function (req, file, cb) {
    // Keep the server allow-list aligned with the Android Excel parser.
    const allowedExts = [".xlsx", ".xls", ".xlsm", ".xltx", ".xltm", ".xlsb", ".csv"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("يُسمح فقط برفع ملفات Excel بصيغ (.xlsx, .xls, .xlsm, .xltx, .xltm, .xlsb, .csv)"));
    }
  }
});

function flash(req, type, text) {
  req.session.flash = { type, text };
}

function consumeFlash(req) {
  const current = req.session.flash || null;
  req.session.flash = null;
  return current;
}

router.get("/login", (req, res) => {
  if (req.session.adminId) {
    return res.redirect("/admin");
  }
  res.render("login", {
    title: "تسجيل الدخول",
    error: consumeFlash(req),
    username: ""
  });
});

router.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const admin = await Admin.findByUsername(username);

    if (!admin || !(await admin.verifyPassword(password))) {
      flash(req, "error", "اسم المستخدم أو كلمة المرور غير صحيحة");
      return res.redirect("/admin/login");
    }

    if (admin.isActive === false) {
      flash(req, "error", "هذا الحساب معطل حالياً. يرجى التواصل مع السوبر أدمن.");
      return res.redirect("/admin/login");
    }

    req.session.adminId = String(admin.id);
    req.session.adminUsername = admin.username;
    return res.redirect("/admin");
  } catch (error) {
    console.error("Admin login failed:", error);
    flash(req, "error", "تعذر تسجيل الدخول حالياً");
    return res.redirect("/admin/login");
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin/login");
  });
});

router.get("/", requireAdmin, async (req, res) => {
  const isSuperAdmin = req.admin.role === "super_admin";

  let activeTab = "FARZ_V2";
  if (isSuperAdmin) {
    if (req.query.tab === "FARZ_V1") {
      activeTab = "FARZ_V1";
    } else if (req.query.tab === "ADMINS") {
      activeTab = "ADMINS";
    } else {
      activeTab = "FARZ_V2";
    }
  }

  // Load codes based on admin role
  let codes = [];
  if (isSuperAdmin) {
    codes = await ActivationCode.listAll();
  } else {
    codes = await ActivationCode.listAll("FARZ_V2", req.admin.id);
  }

  const mapped = codes.map((item) => ({
    ...item,
    appId: item.appId || "FARZ_V1",
    expired: item.isExpired(),
    expiresAtText: item.expiresAt ? item.expiresAt.toLocaleString("ar-EG") : "—",
    createdAtText: item.createdAt ? item.createdAt.toLocaleString("ar-EG") : "—",
    lastSeenText: item.lastSeenAt ? item.lastSeenAt.toLocaleString("ar-EG") : "—",
    clientNameText: item.clientName ? item.clientName : "—"
  }));

  const codesV1 = isSuperAdmin ? mapped.filter((item) => !isFarzonApp(item.appId)) : [];
  const codesV2 = mapped.filter((item) => isFarzonApp(item.appId));

  function calcStats(list) {
    return {
      total: list.length,
      active: list.filter((item) => item.isActivated && !item.isBlocked && !item.expired).length,
      blocked: list.filter((item) => item.isBlocked).length,
      expired: list.filter((item) => item.expired).length
    };
  }

  const statsV1 = calcStats(codesV1);
  const statsV2 = calcStats(codesV2);

  // Load Sub-Admins list for Super Admin if tab is ADMINS
  let subAdmins = [];
  if (isSuperAdmin && activeTab === "ADMINS") {
    const rawSubAdmins = await Admin.listSubAdmins();
    subAdmins = await Promise.all(
      rawSubAdmins.map(async (sa) => {
        const count = await ActivationCode.countByAdmin(sa.id);
        const quota = sa.maxCodesQuota || 0;
        return {
          ...sa,
          codesCount: count,
          remainingQuota: Math.max(0, quota - count),
          createdAtText: sa.createdAt ? new Date(sa.createdAt).toLocaleString("ar-EG") : "—"
        };
      })
    );
  }

  // Load Admin Files for current admin
  const adminFilesRaw = await AdminFile.listByAdmin(req.admin.id);
  const adminFiles = adminFilesRaw.map((f) => ({
    ...f,
    sizeKb: Math.round(f.fileSize / 1024),
    createdAtText: f.createdAt ? f.createdAt.toLocaleString("ar-EG") : "—"
  }));

  // Calculate Sub-Admin quota stats
  const subAdminQuota = {
    max: req.admin.maxCodesQuota || 50,
    used: codesV2.length,
    remaining: Math.max(0, (req.admin.maxCodesQuota || 50) - codesV2.length)
  };

  res.render("dashboard", {
    title: "لوحة التحكم",
    adminUsername: req.session.adminUsername,
    currentAdmin: req.admin,
    isSuperAdmin,
    flash: consumeFlash(req),
    activeTab,
    codesV1,
    codesV2,
    statsV1,
    statsV2,
    subAdmins,
    adminFiles,
    subAdminQuota,
    codes: activeTab === "FARZ_V2" ? codesV2 : codesV1,
    stats: activeTab === "FARZ_V2" ? statsV2 : statsV1
  });
});

// Create activation code
router.post("/codes", requireAdmin, async (req, res) => {
  const isSuperAdmin = req.admin.role === "super_admin";
  let appId = "FARZ_V2";

  if (isSuperAdmin) {
    appId = isFarzonApp(req.body.app_id) ? "FARZ_V2" : "FARZ_V1";
  } else {
    // Sub-Admin is strictly restricted to FARZ_V2
    appId = "FARZ_V2";

    // Enforce Sub-Admin quota check
    const currentCount = await ActivationCode.countByAdmin(req.admin.id);
    const maxQuota = req.admin.maxCodesQuota || 50;
    if (currentCount >= maxQuota) {
      flash(req, "error", `عفواً، لقد استنفدت الحد الأقصى المسموح لك من الأكواد (${maxQuota} كود). يرجى مراجعة السوبر أدمن.`);
      return res.redirect("/admin?tab=FARZ_V2");
    }
  }

  try {
    const { expiresAt, durationLabel } = computeExpiry(
      req.body.durationValue,
      req.body.durationUnit
    );

    let code = generateActivationCode(appId);
    while (await ActivationCode.existsByCode(code)) {
      code = generateActivationCode(appId);
    }

    await ActivationCode.createCode({
      code,
      expiresAt: expiresAt.toISOString(),
      durationLabel,
      clientName: String(req.body.client_name || "").trim(),
      appId,
      createdByAdminId: req.admin.id
    });

    const isFarzon = isFarzonApp(appId);
    const appLabel = isFarzon ? "تطبيق فرزون (Farzon)" : "تطبيق فرز (Farz)";
    flash(req, "success", `تم إنشاء الكود ${code} بنجاح لصالح ${appLabel}`);
  } catch (error) {
    console.error("Create code failed:", error);
    flash(req, "error", error.message || "تعذر إنشاء الكود");
  }
  return res.redirect(`/admin?tab=${appId}`);
});

// Helper to check code modification ownership
async function canModifyCode(req, codeId) {
  const record = await ActivationCode.findById(codeId);
  if (!record) return null;
  if (req.admin.role === "super_admin") return record;
  if (String(record.createdByAdminId) === String(req.admin.id)) return record;
  return null;
}

router.post("/codes/:id/block", requireAdmin, async (req, res) => {
  const record = await canModifyCode(req, req.params.id);
  if (!record) {
    flash(req, "error", "ليس لديك صلاحية لتعديل هذا الكود أو الكود غير موجود");
    return res.redirect("/admin?tab=FARZ_V2");
  }
  const tab = isFarzonApp(record.appId) ? "FARZ_V2" : "FARZ_V1";
  await ActivationCode.updateCode(record.id, { isBlocked: true });
  flash(req, "success", `تم حظر الكود ${record.code}`);
  return res.redirect(`/admin?tab=${tab}`);
});

router.post("/codes/:id/unblock", requireAdmin, async (req, res) => {
  const record = await canModifyCode(req, req.params.id);
  if (!record) {
    flash(req, "error", "ليس لديك صلاحية لتعديل هذا الكود أو الكود غير موجود");
    return res.redirect("/admin?tab=FARZ_V2");
  }
  const tab = isFarzonApp(record.appId) ? "FARZ_V2" : "FARZ_V1";
  await ActivationCode.updateCode(record.id, { isBlocked: false });
  flash(req, "success", `تم إلغاء حظر الكود ${record.code}`);
  return res.redirect(`/admin?tab=${tab}`);
});

router.post("/codes/:id/force-logout", requireAdmin, async (req, res) => {
  const record = await canModifyCode(req, req.params.id);
  if (!record) {
    flash(req, "error", "ليس لديك صلاحية لتعديل هذا الكود أو الكود غير موجود");
    return res.redirect("/admin?tab=FARZ_V2");
  }
  const tab = isFarzonApp(record.appId) ? "FARZ_V2" : "FARZ_V1";
  await ActivationCode.updateCode(record.id, {
    deviceId: null,
    isActivated: false,
    activatedAt: null
  });
  flash(req, "success", `تم طرد الجهاز المرتبط بالكود ${record.code}`);
  return res.redirect(`/admin?tab=${tab}`);
});

router.post("/codes/:id/delete", requireAdmin, async (req, res) => {
  const record = await canModifyCode(req, req.params.id);
  if (!record) {
    flash(req, "error", "ليس لديك صلاحية لحذف هذا الكود أو الكود غير موجود");
    return res.redirect("/admin?tab=FARZ_V2");
  }
  const tab = isFarzonApp(record.appId) ? "FARZ_V2" : "FARZ_V1";
  await ActivationCode.deleteById(record.id);
  flash(req, "success", "تم حذف الكود بنجاح");
  return res.redirect(`/admin?tab=${tab}`);
});

// ==========================================
// Admin File Management (Excel Upload & Delete)
// ==========================================
router.post("/files/upload", requireAdmin, upload.single("dataFile"), async (req, res) => {
  try {
    if (!req.file) {
      flash(req, "error", "يرجى اختيار ملف Excel بصيغة (.xlsx, .xls, .xlsm, .xltx, .xltm, .xlsb أو .csv)");
      return res.redirect("/admin?tab=FARZ_V2");
    }

    let recordsCount = 0;
    try {
      const workbook = XLSX.readFile(req.file.path, { sheetRows: 50000 });
      const firstSheet = workbook.SheetNames[0];
      if (firstSheet) {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1 });
        recordsCount = Math.max(0, rows.length - 1);
      }
    } catch (e) {
      console.warn("Could not parse excel rows count:", e.message);
    }

    // Compute SHA-256 hash of file for client sync checks
    const fileBuffer = fs.readFileSync(req.file.path);
    const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

    await AdminFile.createFile({
      adminId: req.admin.id,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      recordsCount,
      storagePath: req.file.path,
      fileHash
    });

    flash(req, "success", `تم رفع ملف البيانات (${req.file.originalname}) بنجاح (${recordsCount} سجل)`);
  } catch (err) {
    console.error("Upload error:", err);
    flash(req, "error", "تعذر رفع الملف: " + err.message);
  }
  return res.redirect("/admin?tab=FARZ_V2");
});

router.post("/files/:id/delete", requireAdmin, async (req, res) => {
  try {
    const file = await AdminFile.findById(req.params.id);
    if (!file) {
      flash(req, "error", "الملف غير موجود");
      return res.redirect("/admin?tab=FARZ_V2");
    }

    if (req.admin.role !== "super_admin" && String(file.adminId) !== String(req.admin.id)) {
      flash(req, "error", "ليس لديك صلاحية حذف هذا الملف");
      return res.redirect("/admin?tab=FARZ_V2");
    }

    await AdminFile.deleteFile(file.id, req.admin.id);

    // Clean up physical file
    try {
      if (file.storagePath && fs.existsSync(file.storagePath)) {
        fs.unlinkSync(file.storagePath);
      }
    } catch (_) {}

    flash(req, "success", `تم حذف ملف البيانات (${file.fileName}) من السيرفر بنجاح`);
  } catch (err) {
    flash(req, "error", "تعذر حذف الملف: " + err.message);
  }
  return res.redirect("/admin?tab=FARZ_V2");
});

// ==========================================
// Super Admin Only: Sub-Admins Management
// ==========================================
router.post("/sub-admins", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const maxCodesQuota = parseInt(req.body.max_codes_quota, 10) || 50;

    if (!username || !password) {
      flash(req, "error", "اسم المستخدم وكلمة المرور مطلوبان");
      return res.redirect("/admin?tab=ADMINS");
    }

    if (password.length < 6) {
      flash(req, "error", "كلمة المرور يجب أن لا تقل عن 6 أحرف");
      return res.redirect("/admin?tab=ADMINS");
    }

    const existing = await Admin.findByUsername(username);
    if (existing) {
      flash(req, "error", "اسم المستخدم مستخدم بالفعل. اختر اسماً آخر.");
      return res.redirect("/admin?tab=ADMINS");
    }

    await Admin.createSubAdmin({
      username,
      password,
      maxCodesQuota,
      createdBy: req.admin.id
    });

    flash(req, "success", `تم إنشاء حساب الأدمن الفرعي (${username}) بحصة ${maxCodesQuota} كود بنجاح`);
  } catch (err) {
    console.error("Create sub-admin error:", err);
    flash(req, "error", "تعذر إنشاء حساب الأدمن: " + err.message);
  }
  return res.redirect("/admin?tab=ADMINS");
});

router.post("/sub-admins/:id/toggle", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const sub = await Admin.findById(req.params.id);
    if (sub && sub.role !== "super_admin") {
      const newStatus = !sub.isActive;
      await Admin.updateSubAdmin(sub.id, { isActive: newStatus });
      flash(req, "success", `تم ${newStatus ? "تفعيل" : "إيقاف"} حساب الأدمن (${sub.username})`);
    }
  } catch (err) {
    flash(req, "error", "تعذر تحديث حالة الحساب");
  }
  return res.redirect("/admin?tab=ADMINS");
});

router.post("/sub-admins/:id/quota", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const newQuota = parseInt(req.body.max_codes_quota, 10);
    if (isNaN(newQuota) || newQuota < 0) {
      flash(req, "error", "يرجى كتابة رقم صحيح لحصة الأكواد");
      return res.redirect("/admin?tab=ADMINS");
    }
    await Admin.updateSubAdmin(req.params.id, { maxCodesQuota: newQuota });
    flash(req, "success", "تم تحديث حصة الأكواد بنجاح");
  } catch (err) {
    flash(req, "error", "تعذر تحديث الحصة");
  }
  return res.redirect("/admin?tab=ADMINS");
});

router.post("/sub-admins/:id/reset-password", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const newPassword = String(req.body.new_password || "");
    if (!newPassword || newPassword.length < 6) {
      flash(req, "error", "كلمة المرور الجديدة يجب أن لا تقل عن 6 أحرف");
      return res.redirect("/admin?tab=ADMINS");
    }
    const passwordHash = await Admin.hashPassword(newPassword);
    await Admin.updatePassword(req.params.id, passwordHash);
    flash(req, "success", "تم تغيير كلمة المرور بنجاح");
  } catch (err) {
    flash(req, "error", "تعذر تغيير كلمة المرور");
  }
  return res.redirect("/admin?tab=ADMINS");
});

module.exports = router;
