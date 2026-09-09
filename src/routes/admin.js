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
    const admin = await Admin.findOne({ username });

    if (!admin || !(await admin.verifyPassword(password))) {
      flash(req, "error", "اسم المستخدم أو كلمة المرور غير صحيحة");
      return res.redirect("/admin/login");
    }

    req.session.adminId = admin._id.toString();
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
  const codes = await ActivationCode.find().sort({ createdAt: -1 }).lean();
  const now = Date.now();
  const mapped = codes.map((item) => ({
    ...item,
    expired: new Date(item.expiresAt).getTime() <= now,
    expiresAtText: new Date(item.expiresAt).toLocaleString("ar-EG"),
    createdAtText: new Date(item.createdAt).toLocaleString("ar-EG"),
    lastSeenText: item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString("ar-EG") : "—"
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
    while (await ActivationCode.exists({ code })) {
      code = generateActivationCode();
    }

    await ActivationCode.create({
      code,
      expiresAt,
      durationLabel,
      isActivated: false,
      deviceId: null,
      isBlocked: false
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
    record.isBlocked = true;
    await record.save();
    flash(req, "success", `تم حظر الكود ${record.code}`);
  }
  return res.redirect("/admin");
});

router.post("/codes/:id/unblock", requireAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (record) {
    record.isBlocked = false;
    await record.save();
    flash(req, "success", `تم إلغاء حظر الكود ${record.code}`);
  }
  return res.redirect("/admin");
});

router.post("/codes/:id/force-logout", requireAdmin, async (req, res) => {
  const record = await ActivationCode.findById(req.params.id);
  if (record) {
    record.deviceId = null;
    record.isActivated = false;
    record.activatedAt = null;
    await record.save();
    flash(req, "success", `تم طرد الجهاز المرتبط بالكود ${record.code}`);
  }
  return res.redirect("/admin");
});

router.post("/codes/:id/delete", requireAdmin, async (req, res) => {
  await ActivationCode.findByIdAndDelete(req.params.id);
  flash(req, "success", "تم حذف الكود");
  return res.redirect("/admin");
});

module.exports = router;
