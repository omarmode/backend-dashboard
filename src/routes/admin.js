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
  const codes = await ActivationCode.listAll();
  const mapped = codes.map((item) => ({
    ...item,
    expired: item.isExpired(),
    expiresAtText: item.expiresAt ? item.expiresAt.toLocaleString("ar-EG") : "—",
    createdAtText: item.createdAt ? item.createdAt.toLocaleString("ar-EG") : "—",
    lastSeenText: item.lastSeenAt ? item.lastSeenAt.toLocaleString("ar-EG") : "—"
  }));

  res.render("dashboard", {
    title: "لوحة التحكم",
    adminUsername: req.session.adminUsername,
    flash: consumeFlash(req),
    codes: mapped,
    stats: {
      total: mapped.length,
      active: mapped.filter((item) => item.isActivated && !item.isBlocked && !item.expired).length,
      blocked: mapped.filter((item) => item.isBlocked).length,
      expired: mapped.filter((item) => item.expired).length
    }
  });
});

router.post("/codes", requireAdmin, async (req, res) => {
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
      durationLabel
    });

    flash(req, "success", `تم إنشاء الكود ${code}`);
  } catch (error) {
    console.error("Create code failed:", error);
    flash(req, "error", error.message || "تعذر إنشاء الكود");
  }
  return res.redirect("/admin");
});

router.post("/codes/:id/block", requireAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (record) {
    await ActivationCode.updateCode(record.id, { isBlocked: true });
    flash(req, "success", `تم حظر الكود ${record.code}`);
  }
  return res.redirect("/admin");
});

router.post("/codes/:id/unblock", requireAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (record) {
    await ActivationCode.updateCode(record.id, { isBlocked: false });
    flash(req, "success", `تم إلغاء حظر الكود ${record.code}`);
  }
  return res.redirect("/admin");
});

router.post("/codes/:id/force-logout", requireAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (record) {
    await ActivationCode.updateCode(record.id, {
      deviceId: null,
      isActivated: false,
      activatedAt: null
    });
    flash(req, "success", `تم طرد الجهاز المرتبط بالكود ${record.code}`);
  }
  return res.redirect("/admin");
});

router.post("/codes/:id/delete", requireAdmin, async (req, res) => {
  await ActivationCode.deleteById(req.params.id);
  flash(req, "success", "تم حذف الكود");
  return res.redirect("/admin");
});

module.exports = router;
