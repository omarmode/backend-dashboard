const express = require("express");
const Admin = require("../models/Admin");
const ActivationCode = require("../models/ActivationCode");
const { requireAdmin } = require("../middleware/auth");
const { generateActivationCode, computeExpiry } = require("../utils/codes");

const router = express.Router();

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
  const activeTab = req.query.tab === "FARZ_V2" ? "FARZ_V2" : "FARZ_V1";
  const codes = await ActivationCode.listAll();
  const mapped = codes.map((item) => ({
    ...item,
    appId: item.appId || "FARZ_V1",
    expired: item.isExpired(),
    expiresAtText: item.expiresAt ? item.expiresAt.toLocaleString("ar-EG") : "—",
    createdAtText: item.createdAt ? item.createdAt.toLocaleString("ar-EG") : "—",
    lastSeenText: item.lastSeenAt ? item.lastSeenAt.toLocaleString("ar-EG") : "—",
    clientNameText: item.clientName ? item.clientName : "—"
  }));

  const codesV1 = mapped.filter((item) => item.appId === "FARZ_V1");
  const codesV2 = mapped.filter((item) => item.appId === "FARZ_V2");

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

  res.render("dashboard", {
    title: "لوحة التحكم",
    adminUsername: req.session.adminUsername,
    flash: consumeFlash(req),
    activeTab,
    codesV1,
    codesV2,
    statsV1,
    statsV2,
    codes: activeTab === "FARZ_V2" ? codesV2 : codesV1,
    stats: activeTab === "FARZ_V2" ? statsV2 : statsV1
  });
});

router.post("/codes", requireAdmin, async (req, res) => {
  const appId = req.body.app_id === "FARZ_V2" ? "FARZ_V2" : "FARZ_V1";
  try {
    const { expiresAt, durationLabel } = computeExpiry(
      req.body.durationValue,
      req.body.durationUnit
    );

    let code = generateActivationCode();
    while (await ActivationCode.existsByCode(code)) {
      code = generateActivationCode();
    }

    await ActivationCode.createCode({
      code,
      expiresAt: expiresAt.toISOString(),
      durationLabel,
      clientName: String(req.body.client_name || "").trim(),
      appId
    });

    const appLabel = appId === "FARZ_V2" ? "التطبيق الثاني (FARZ 2)" : "التطبيق الأول (FARZ 1)";
    flash(req, "success", `تم إنشاء الكود ${code} الخاص بـ ${appLabel}`);
  } catch (error) {
    console.error("Create code failed:", error);
    flash(req, "error", error.message || "تعذر إنشاء الكود");
  }
  return res.redirect(`/admin?tab=${appId}`);
});

router.post("/codes/:id/block", requireAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  const tab = record?.appId === "FARZ_V2" ? "FARZ_V2" : "FARZ_V1";
  if (record) {
    await ActivationCode.updateCode(record.id, { isBlocked: true });
    flash(req, "success", `تم حظر الكود ${record.code}`);
  }
  return res.redirect(`/admin?tab=${tab}`);
});

router.post("/codes/:id/unblock", requireAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  const tab = record?.appId === "FARZ_V2" ? "FARZ_V2" : "FARZ_V1";
  if (record) {
    await ActivationCode.updateCode(record.id, { isBlocked: false });
    flash(req, "success", `تم إلغاء حظر الكود ${record.code}`);
  }
  return res.redirect(`/admin?tab=${tab}`);
});

router.post("/codes/:id/force-logout", requireAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  const tab = record?.appId === "FARZ_V2" ? "FARZ_V2" : "FARZ_V1";
  if (record) {
    await ActivationCode.updateCode(record.id, {
      deviceId: null,
      isActivated: false,
      activatedAt: null
    });
    flash(req, "success", `تم طرد الجهاز المرتبط بالكود ${record.code}`);
  }
  return res.redirect(`/admin?tab=${tab}`);
});

router.post("/codes/:id/delete", requireAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  const tab = record?.appId === "FARZ_V2" ? "FARZ_V2" : "FARZ_V1";
  await ActivationCode.deleteById(req.params.id);
  flash(req, "success", "تم حذف الكود");
  return res.redirect(`/admin?tab=${tab}`);
});

module.exports = router;
