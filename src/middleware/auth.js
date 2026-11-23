const Admin = require("../models/Admin");

/**
 * Enforces strict Super-Admin-only dashboard access.
 * Legacy web sub_admin accounts are NOT deleted from the database, but are blocked
 * from logging into the dashboard or issuing any codes.
 */
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
      if (admin.role !== "super_admin") {
        req.session.destroy(() => {});
        if (req.xhr || req.headers.accept?.includes("application/json")) {
          return res.status(403).json({
            success: false,
            message: "لوحة التحكم مخصصة للسوبر أدمن فقط. يستخدم المديرون التطبيق مباشرة."
          });
        }
        return res.redirect("/admin/login?error=super_admin_only");
      }
      req.admin = admin;
      res.locals.currentAdmin = admin;
      return next();
    } catch (e) {
      console.error("Auth check failed:", e.message);
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
    return res.status(403).json({ success: false, message: "هذا الإجراء مخصص للسوبر أدمن فقط" });
  }
  if (req.session) {
    req.session.flash = { type: "error", text: "هذا الإجراء مخصص للسوبر أدمن فقط" };
  }
  return res.redirect("/admin/login");
}

module.exports = { requireAdmin, requireSuperAdmin };
