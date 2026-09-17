const express = require("express");
const rateLimit = require("express-rate-limit");
const ActivationCode = require("../models/ActivationCode");
const { licenseStatus } = require("../utils/codes");

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
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

    return res.json({
      ...result,
      expiresAt: saved.expiresAt,
      isActivated: true
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

module.exports = router;
