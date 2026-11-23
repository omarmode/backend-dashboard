const express = require("express");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");
const ManagerFile = require("../models/ManagerFile");
const ActivationCode = require("../models/ActivationCode");
const { requireAdmin, requireSuperAdmin } = require("../middleware/auth");
const {
  generateActivationCode,
  computeExpiry,
  computeRemainingInfo,
  isFarzonApp
} = require("../utils/codes");

const router = express.Router();

function flash(req, type, text) {
  req.session.flash = { type, text };
}

function consumeFlash(req) {
  const current = req.session.flash || null;
  req.session.flash = null;
  return current;
}

async function generateUniqueCode(appId, reservedSet = new Set()) {
  let code = generateActivationCode(appId);
  let attempts = 0;
  while (reservedSet.has(code) || (await ActivationCode.existsByCode(code))) {
    code = generateActivationCode(appId);
    attempts += 1;
    if (attempts > 50) {
      throw new Error("تعذر توليد كود فريد، حاول مرة أخرى");
    }
  }
  reservedSet.add(code);
  return code;
}

function formatCodeForView(item, now = new Date(), managerNameMap = {}) {
  const rem = computeRemainingInfo(item.expiresAt, now);
  return {
    ...item,
    appId: item.appId || "FARZ_V1",
    expired: rem.expired,
    remainingDays: rem.remainingDays,
    lessThanOneDay: rem.lessThanOneDay,
    remainingLabel: rem.labelAr,
    expiryDateFormatted: rem.expiryDateFormatted,
    expiresAtText: item.expiresAt ? item.expiresAt.toLocaleString("ar-EG") : "—",
    createdAtText: item.createdAt ? item.createdAt.toLocaleString("ar-EG") : "—",
    activatedAtText: item.activatedAt ? item.activatedAt.toLocaleString("ar-EG") : "—",
    lastSeenText: item.lastSeenAt ? item.lastSeenAt.toLocaleString("ar-EG") : "—",
    clientNameText: item.clientName ? item.clientName : "—",
    managerNameText: item.managerId ? (managerNameMap[item.managerId] || "—") : "—"
  };
}

function calcStats(list) {
  return {
    total: list.length,
    active: list.filter((item) => item.isActivated && !item.isBlocked && !item.expired).length,
    blocked: list.filter((item) => item.isBlocked).length,
    expired: list.filter((item) => item.expired).length
  };
}

function redirectBackForCode(record, fallbackTab = "FARZ_V2") {
  if (record && (record.codeRole === "manager" || record.codeRole === "manager_user") && record.managerId) {
    return `/admin?tab=MANAGERS&manager=${encodeURIComponent(record.managerId)}`;
  }
  if (record) {
    return `/admin?tab=${isFarzonApp(record.appId) ? "FARZ_V2" : "FARZ_V1"}`;
  }
  return `/admin?tab=${fallbackTab}`;
}

/**
 * Parses optional custom per-code durations (e.g. "30, 90, 180") or uniform days.
 */
function parseBatchDurations(count, uniformDays, customDurationsRaw) {
  const customStr = String(customDurationsRaw || "").trim();
  if (customStr) {
    const parts = customStr
      .split(/[\s,،;|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const parsed = parts.map((p) => Number(p));
    if (parsed.some((n) => !Number.isInteger(n) || n <= 0 || n > 3650)) {
      throw new Error("قائمة المدد المخصصة يجب أن تحتوي على أرقام أيام صحيحة أكبر من 0 (مثال: 30, 90, 180)");
    }
    return parsed;
  }

  const cnt = Number(count);
  const days = Number(uniformDays);
  if (!Number.isInteger(cnt) || cnt <= 0 || cnt > 500) {
    throw new Error("عدد الأكواد يجب أن يكون رقماً صحيحاً بين 1 و 500");
  }
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    throw new Error("مدة الصلاحية بالأيام يجب أن تكون رقماً صحيحاً بين 1 و 3650");
  }
  return Array(cnt).fill(days);
}

// ============================================================================
// Authentication (Super Admin ONLY)
// ============================================================================
router.get("/login", (req, res) => {
  if (req.session.adminId) {
    return res.redirect("/admin");
  }
  let error = consumeFlash(req);
  if (!error && req.query.error === "super_admin_only") {
    error = { type: "error", text: "لوحة التحكم مخصصة للسوبر أدمن فقط. يستخدم المديرون التطبيق مباشرة بكود المدير." };
  } else if (!error && req.query.error === "account_deactivated") {
    error = { type: "error", text: "هذا الحساب معطل حالياً." };
  }
  res.render("login", {
    title: "تسجيل الدخول",
    error,
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
      flash(req, "error", "هذا الحساب معطل حالياً.");
      return res.redirect("/admin/login");
    }

    if (admin.role !== "super_admin") {
      flash(req, "error", "لوحة التحكم مخصصة للسوبر أدمن فقط. المديرون لا يدخلون لوحة التحكم.");
      return res.redirect("/admin/login");
    }

    req.session.adminId = String(admin.id);
    req.session.adminUsername = admin.username;
    return res.redirect("/admin");
  } catch (error) {
    console.error("Admin login failed:", error.message);
    flash(req, "error", "تعذر تسجيل الدخول حالياً");
    return res.redirect("/admin/login");
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin/login");
  });
});

// ============================================================================
// Main Super Admin Dashboard (3 Tabs: FARZ_V1, FARZ_V2 Regular, MANAGERS)
// ============================================================================
router.get("/", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const now = new Date();
    let activeTab = "FARZ_V2";
    if (req.query.tab === "FARZ_V1") {
      activeTab = "FARZ_V1";
    } else if (req.query.tab === "MANAGERS") {
      activeTab = "MANAGERS";
    }

    const [allCodes, rawManagers, allActiveManagerFiles] = await Promise.all([
      ActivationCode.listAll(),
      Manager.listAll(),
      ManagerFile.listAllActive().catch(() => [])
    ]);

    const managerNameMap = {};
    for (const m of rawManagers) {
      managerNameMap[m.id] = m.name;
    }

    const mappedCodes = allCodes.map((c) => formatCodeForView(c, now, managerNameMap));

    // Tab 1: FARZ_V1 codes only
    const codesV1 = mappedCodes.filter((item) => !isFarzonApp(item.appId));

    // Tab 2: FARZ_V2 regular users ONLY (strictly excludes manager & manager_user codes!)
    const codesV2 = mappedCodes.filter(
      (item) => isFarzonApp(item.appId) && item.codeRole === "regular" && !item.managerId
    );

    const statsV1 = calcStats(codesV1);
    const statsV2 = calcStats(codesV2);

    // Tab 3: Build rich manager group summaries
    const filesByManager = {};
    for (const f of allActiveManagerFiles) {
      const k = String(f.managerId);
      if (!filesByManager[k]) filesByManager[k] = [];
      filesByManager[k].push({
        ...f,
        sizeKb: Math.max(1, Math.round(f.fileSize / 1024)),
        createdAtText: f.createdAt ? f.createdAt.toLocaleString("ar-EG") : "—"
      });
    }

    const managers = rawManagers.map((m) => {
      const managerCode = mappedCodes.find(
        (c) => String(c.managerId) === String(m.id) && c.codeRole === "manager"
      ) || null;
      const userCodes = mappedCodes.filter(
        (c) => String(c.managerId) === String(m.id) && c.codeRole === "manager_user"
      );
      const mFiles = filesByManager[String(m.id)] || [];
      return {
        ...m,
        managerCode,
        userCodes,
        issuedUsersCount: userCodes.length,
        remainingQuota: Math.max(0, m.maxUsers - userCodes.length),
        activeUsersCount: userCodes.filter((u) => u.isActivated && !u.isBlocked && !u.expired).length,
        files: mFiles,
        filesCount: mFiles.length,
        createdAtText: m.createdAt ? m.createdAt.toLocaleString("ar-EG") : "—"
      };
    });

    const selectedManagerId = req.query.manager ? String(req.query.manager) : null;
    const selectedManager =
      (selectedManagerId && managers.find((m) => String(m.id) === selectedManagerId)) ||
      managers[0] ||
      null;

    const managerStats = {
      totalManagers: managers.length,
      activeManagers: managers.filter((m) => m.isActive).length,
      totalManagerUsers: managers.reduce((sum, m) => sum + m.issuedUsersCount, 0),
      totalFiles: allActiveManagerFiles.length
    };

    res.render("dashboard", {
      title: "مركز التحكم الرئيسي",
      adminUsername: req.session.adminUsername,
      currentAdmin: req.admin,
      isSuperAdmin: true,
      flash: consumeFlash(req),
      activeTab,
      codesV1,
      codesV2,
      statsV1,
      statsV2,
      managers,
      selectedManager,
      managerStats
    });
  } catch (error) {
    console.error("Dashboard load failed:", error.message);
    res.status(500).send(`تعذر تحميل لوحة التحكم: ${error.message}`);
  }
});

// ============================================================================
// Tab 1 & Tab 2: Create Regular Activation Code (Super Admin ONLY)
// ============================================================================
router.post("/codes", requireAdmin, requireSuperAdmin, async (req, res) => {
  const appId = isFarzonApp(req.body.app_id) ? "FARZ_V2" : "FARZ_V1";

  try {
    const { expiresAt, durationDays, durationLabel } = computeExpiry(
      req.body.durationValue,
      req.body.durationUnit || "days"
    );

    const code = await generateUniqueCode(appId);

    await ActivationCode.createCode({
      code,
      expiresAt: expiresAt.toISOString(),
      durationDays,
      durationLabel,
      clientName: String(req.body.client_name || "").trim(),
      appId,
      codeRole: "regular",
      managerId: null,
      createdByAdminId: req.admin.id
    });

    const appLabel = isFarzonApp(appId) ? "تطبيق فرزون (Farzon - مستخدم عادي)" : "تطبيق فرز (Farz)";
    flash(req, "success", `تم إنشاء الكود ${code} (${durationDays} يوم) بنجاح لصالح ${appLabel}`);
  } catch (error) {
    console.error("Create code failed:", error.message);
    flash(req, "error", error.message || "تعذر إنشاء الكود");
  }
  return res.redirect(`/admin?tab=${appId}`);
});

// ============================================================================
// Shared Code Management Actions (Block / Unblock / Force Logout / Extend / Delete)
// Super Admin ONLY
// ============================================================================
router.post("/codes/:id/block", requireAdmin, requireSuperAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (!record) {
    flash(req, "error", "الكود غير موجود");
    return res.redirect("/admin?tab=FARZ_V2");
  }
  await ActivationCode.updateCode(record.id, { isBlocked: true });
  flash(req, "success", `تم حظر الكود ${record.code}`);
  return res.redirect(redirectBackForCode(record));
});

router.post("/codes/:id/unblock", requireAdmin, requireSuperAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (!record) {
    flash(req, "error", "الكود غير موجود");
    return res.redirect("/admin?tab=FARZ_V2");
  }
  await ActivationCode.updateCode(record.id, { isBlocked: false });
  flash(req, "success", `تم إلغاء حظر الكود ${record.code}`);
  return res.redirect(redirectBackForCode(record));
});

router.post("/codes/:id/force-logout", requireAdmin, requireSuperAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (!record) {
    flash(req, "error", "الكود غير موجود");
    return res.redirect("/admin?tab=FARZ_V2");
  }
  await ActivationCode.updateCode(record.id, {
    deviceId: null,
    isActivated: false,
    activatedAt: null
  });
  flash(req, "success", `تم طرد الجهاز المرتبط بالكود ${record.code}`);
  return res.redirect(redirectBackForCode(record));
});

// Extend or adjust code expiration WITHOUT unbinding device!
router.post("/codes/:id/extend", requireAdmin, requireSuperAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (!record) {
    flash(req, "error", "الكود غير موجود");
    return res.redirect("/admin?tab=FARZ_V2");
  }
  try {
    const mode = String(req.body.extend_mode || "add").trim();
    const updated =
      mode === "set"
        ? await ActivationCode.extendCode(record.id, { setDaysFromNow: req.body.days })
        : await ActivationCode.extendCode(record.id, { addDays: req.body.days || req.body.add_days });

    const rem = computeRemainingInfo(updated.expiresAt);
    flash(
      req,
      "success",
      `تم تحديث صلاحية الكود ${updated.code} بنجاح دون فك ربط الجهاز (${rem.labelAr})`
    );
  } catch (err) {
    flash(req, "error", err.message || "تعذر تمديد صلاحية الكود");
  }
  return res.redirect(redirectBackForCode(record));
});

router.post("/codes/:id/delete", requireAdmin, requireSuperAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (!record) {
    flash(req, "error", "الكود غير موجود");
    return res.redirect("/admin?tab=FARZ_V2");
  }
  const redirectUrl = redirectBackForCode(record);
  await ActivationCode.deleteById(record.id);
  flash(req, "success", `تم حذف الكود ${record.code} بنجاح`);
  return res.redirect(redirectUrl);
});

// ============================================================================
// Tab 3: Managers & Their Users (Super Admin ONLY)
// ============================================================================

// Create new Manager + Manager Code + optional initial batch of User Codes
router.post("/managers", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const maxUsers = parseInt(req.body.max_users, 10);
    const managerDurationDays = parseInt(req.body.manager_duration_days, 10);
    const initialUsersCount = parseInt(req.body.initial_users_count || "0", 10) || 0;
    const usersDurationDays = parseInt(req.body.users_duration_days || "30", 10);
    const customUserDurations = String(req.body.custom_user_durations || "").trim();
    const notes = String(req.body.notes || "").trim();

    if (!name) {
      flash(req, "error", "يرجى إدخال اسم المدير أو المجموعة");
      return res.redirect("/admin?tab=MANAGERS");
    }
    if (!Number.isInteger(maxUsers) || maxUsers < 0) {
      flash(req, "error", "عدد المستخدمين المسموح يجب أن يكون رقماً صحيحاً 0 أو أكبر");
      return res.redirect("/admin?tab=MANAGERS");
    }
    if (!Number.isInteger(managerDurationDays) || managerDurationDays <= 0) {
      flash(req, "error", "مدة صلاحية كود المدير بالأيام مطلوبة ويجب أن تكون أكبر من 0");
      return res.redirect("/admin?tab=MANAGERS");
    }

    // Validate optional initial user batch BEFORE creating manager
    let initialDurations = [];
    if (customUserDurations || initialUsersCount > 0) {
      initialDurations = parseBatchDurations(initialUsersCount, usersDurationDays, customUserDurations);
      if (initialDurations.length > maxUsers) {
        flash(
          req,
          "error",
          `عدد أكواد المستخدمين المطلوب إصدارها (${initialDurations.length}) يتجاوز الحد المسموح للمدير (${maxUsers})`
        );
        return res.redirect("/admin?tab=MANAGERS");
      }
    }

    // 1. Create manager group
    const manager = await Manager.createManager({
      name,
      maxUsers,
      notes,
      createdByAdminId: req.admin.id
    });

    // 2. Create manager's own activation code with independent expiration
    const reserved = new Set();
    const mgrCodeStr = await generateUniqueCode("FARZ_V2", reserved);
    const mgrExp = computeExpiry(managerDurationDays, "days");
    const managerCode = await ActivationCode.createCode({
      code: mgrCodeStr,
      expiresAt: mgrExp.expiresAt.toISOString(),
      durationDays: mgrExp.durationDays,
      durationLabel: mgrExp.durationLabel,
      clientName: `مدير: ${manager.name}`,
      appId: "FARZ_V2",
      codeRole: "manager",
      managerId: manager.id,
      createdByAdminId: req.admin.id
    });

    // 3. Optionally issue initial batch of user codes atomically within quota
    let issuedUsers = [];
    if (initialDurations.length > 0) {
      const items = [];
      for (let i = 0; i < initialDurations.length; i += 1) {
        const uCode = await generateUniqueCode("FARZ_V2", reserved);
        const uExp = computeExpiry(initialDurations[i], "days");
        items.push({
          code: uCode,
          expiresAt: uExp.expiresAt.toISOString(),
          durationDays: uExp.durationDays,
          durationLabel: uExp.durationLabel,
          clientName: `${manager.name} - مستخدم ${i + 1}`
        });
      }
      issuedUsers = await ActivationCode.issueManagerUserCodesAtomic({
        managerId: manager.id,
        items,
        createdByAdminId: req.admin.id
      });
    }

    const extraMsg = issuedUsers.length > 0 ? ` + إصدار ${issuedUsers.length} كود مستخدم` : "";
    flash(
      req,
      "success",
      `تم إنشاء المدير (${manager.name}) بحصة ${manager.maxUsers} مستخدم، وكود المدير: ${managerCode.code} (${managerDurationDays} يوم)${extraMsg}`
    );
    return res.redirect(`/admin?tab=MANAGERS&manager=${encodeURIComponent(manager.id)}`);
  } catch (err) {
    console.error("Create manager failed:", err.message);
    flash(req, "error", err.message || "تعذر إنشاء مجموعة المدير");
    return res.redirect("/admin?tab=MANAGERS");
  }
});

// Update Manager Quota (forbids reducing below issued user codes count)
router.post("/managers/:id/quota", requireAdmin, requireSuperAdmin, async (req, res) => {
  const managerId = req.params.id;
  try {
    const newQuota = parseInt(req.body.max_users, 10);
    const updated = await Manager.updateQuota(managerId, newQuota);
    flash(req, "success", `تم تحديث حصة المدير (${updated.name}) إلى ${updated.maxUsers} مستخدم بنجاح`);
  } catch (err) {
    flash(req, "error", err.message || "تعذر تحديث الحصة");
  }
  return res.redirect(`/admin?tab=MANAGERS&manager=${encodeURIComponent(managerId)}`);
});

// Enable / Disable Manager Group (manager_group_disabled)
router.post("/managers/:id/toggle", requireAdmin, requireSuperAdmin, async (req, res) => {
  const managerId = req.params.id;
  try {
    const mgr = await Manager.findById(managerId);
    if (!mgr) {
      flash(req, "error", "المدير غير موجود");
      return res.redirect("/admin?tab=MANAGERS");
    }
    const nextActive = !mgr.isActive;
    await Manager.setActive(managerId, nextActive);
    flash(
      req,
      "success",
      nextActive
        ? `تم تفعيل مجموعة المدير (${mgr.name}) وإعادة إتاحة ملفاتها لمستخدميها`
        : `تم تعطيل مجموعة المدير (${mgr.name}) — سيتم حجب ملفات المجموعة عن مستخدميها مع الحفاظ على ملفاتهم الشخصية`
    );
  } catch (err) {
    flash(req, "error", err.message || "تعذر تحديث حالة المجموعة");
  }
  return res.redirect(`/admin?tab=MANAGERS&manager=${encodeURIComponent(managerId)}`);
});

// Issue Manager's own activation code if deleted/missing
router.post("/managers/:id/manager-code", requireAdmin, requireSuperAdmin, async (req, res) => {
  const managerId = req.params.id;
  try {
    const mgr = await Manager.findById(managerId);
    if (!mgr) {
      flash(req, "error", "المدير غير موجود");
      return res.redirect("/admin?tab=MANAGERS");
    }
    const existing = await ActivationCode.findManagerCode(managerId);
    if (existing) {
      flash(req, "error", `المدير لديه كود فعلي بالفعل: ${existing.code}`);
      return res.redirect(`/admin?tab=MANAGERS&manager=${encodeURIComponent(managerId)}`);
    }
    const days = parseInt(req.body.manager_duration_days, 10);
    const exp = computeExpiry(days, "days");
    const codeStr = await generateUniqueCode("FARZ_V2");
    await ActivationCode.createCode({
      code: codeStr,
      expiresAt: exp.expiresAt.toISOString(),
      durationDays: exp.durationDays,
      durationLabel: exp.durationLabel,
      clientName: `مدير: ${mgr.name}`,
      appId: "FARZ_V2",
      codeRole: "manager",
      managerId: mgr.id,
      createdByAdminId: req.admin.id
    });
    flash(req, "success", `تم إصدار كود المدير الجديد: ${codeStr} (${days} يوم)`);
  } catch (err) {
    flash(req, "error", err.message || "تعذر إصدار كود المدير");
  }
  return res.redirect(`/admin?tab=MANAGERS&manager=${encodeURIComponent(managerId)}`);
});

// Issue 1 or batch of Manager User Codes atomically within quota (independent durations!)
router.post("/managers/:id/codes", requireAdmin, requireSuperAdmin, async (req, res) => {
  const managerId = req.params.id;
  try {
    const mgr = await Manager.findById(managerId);
    if (!mgr) {
      flash(req, "error", "المدير غير موجود");
      return res.redirect("/admin?tab=MANAGERS");
    }

    const durations = parseBatchDurations(
      req.body.count || 1,
      req.body.duration_days || 30,
      req.body.custom_durations
    );
    const namePrefix = String(req.body.client_name || "").trim();
    const existingCount = await ActivationCode.countManagerUserCodes(managerId);

    const reserved = new Set();
    const items = [];
    for (let i = 0; i < durations.length; i += 1) {
      const codeStr = await generateUniqueCode("FARZ_V2", reserved);
      const exp = computeExpiry(durations[i], "days");
      const labelName =
        durations.length === 1 && namePrefix
          ? namePrefix
          : namePrefix
            ? `${namePrefix} ${existingCount + i + 1}`
            : `${mgr.name} - مستخدم ${existingCount + i + 1}`;
      items.push({
        code: codeStr,
        expiresAt: exp.expiresAt.toISOString(),
        durationDays: exp.durationDays,
        durationLabel: exp.durationLabel,
        clientName: labelName
      });
    }

    const issued = await ActivationCode.issueManagerUserCodesAtomic({
      managerId,
      items,
      createdByAdminId: req.admin.id
    });

    const summary =
      issued.length === 1
        ? `تم إصدار كود المستخدم ${issued[0].code} (${issued[0].durationDays} يوم) للمدير (${mgr.name})`
        : `تم إصدار ${issued.length} كود مستخدم للمدير (${mgr.name}) بنجاح`;
    flash(req, "success", summary);
  } catch (err) {
    console.error("Issue manager user codes failed:", err.message);
    flash(req, "error", err.message || "تعذر إصدار أكواد المستخدمين");
  }
  return res.redirect(`/admin?tab=MANAGERS&manager=${encodeURIComponent(managerId)}`);
});

// Super Admin emergency deletion of a Manager's uploaded file
router.post("/managers/:id/files/:fileId/delete", requireAdmin, requireSuperAdmin, async (req, res) => {
  const managerId = req.params.id;
  const fileId = req.params.fileId;
  try {
    const deleted = await ManagerFile.deleteFile(fileId, managerId);
    if (!deleted) {
      flash(req, "error", "الملف غير موجود");
    } else {
      flash(req, "success", `تم حذف الملف (${deleted.fileName}) من السيرفر بنجاح`);
    }
  } catch (err) {
    flash(req, "error", err.message || "تعذر حذف الملف");
  }
  return res.redirect(`/admin?tab=MANAGERS&manager=${encodeURIComponent(managerId)}`);
});

// Explicitly block legacy web sub-admin creation route (defense-in-depth)
router.post("/sub-admins*", requireAdmin, (_req, res) => {
  return res.status(410).json({
    success: false,
    message: "تم استبدال نظام الأدمن الفرعي للويب بنظام المديرين داخل التطبيق في التاب الثالثة (MANAGERS)."
  });
});

module.exports = router;
