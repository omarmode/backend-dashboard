const Admin = require("../models/Admin");

async function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) {
    try {
      const admin = await Admin.findById(req.session.adminId);
      if (!admin) {
        req.session.destroy(() => {});
        return res.redirect("/admin/login");
      }
      if (admin.isActive === false) {
        req.session.destroy(() => {});
        return res.redirect("/admin/login?error=account_deactivated");
      }
      req.admin = admin;
      res.locals.currentAdmin = admin;
      return next();
    } catch (e) {
      console.error("Auth check failed:", e);
      return res.redirect("/admin/login");
    }
  }

  if (req.xhr || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ success: false, message: "يجب تسجيل الدخول أولاً" });
  }

  return res.redirect("/admin/login");
}

function requireSuperAdmin(req, res, next) {
  if (req.admin && req.admin.role === "super_admin") {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes("application/json")) {
    return res.status(403).json({ success: false, message: "هذا القسم مخصص للسوبر أدمن فقط" });
  }
  if (req.session) {
    req.session.flash = { type: "error", text: "هذا القسم مخصص للسوبر أدمن فقط" };
  }
  return res.redirect("/admin?tab=FARZ_V2");
}

module.exports = { requireAdmin, requireSuperAdmin };
