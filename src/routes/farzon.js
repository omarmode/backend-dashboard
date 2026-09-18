const express = require("express");
const ActivationCode = require("../models/ActivationCode");
const { licenseStatus, isFarzonApp } = require("../utils/codes");

const router = express.Router();

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

// GET /farzon/register - Web UI for device activation & registration
router.get("/register", (req, res) => {
  res.render("farzon-register", {
    alert: null,
    successData: null,
    initialCode: req.query.code ? normalizeCode(req.query.code) : "",
    initialDeviceId: req.query.deviceId ? String(req.query.deviceId).trim() : "",
    initialClientName: req.query.clientName ? String(req.query.clientName).trim() : ""
  });
});

// POST /farzon/register - Web form handler
router.post("/register", async (req, res) => {
  const rawCode = req.body.code;
  const rawDeviceId = req.body.deviceId;
  const clientName = String(req.body.clientName || "").trim();

  const code = normalizeCode(rawCode);
  const deviceId = String(rawDeviceId || "").trim();

  if (!code || !deviceId) {
    return res.render("farzon-register", {
      alert: { type: "error", message: "يرجى كتابة كود النشاط ومعرف الجهاز للمتابعة" },
      successData: null,
      initialCode: code,
      initialDeviceId: deviceId,
      initialClientName: clientName
    });
  }

  try {
    const record = await ActivationCode.findByCode(code);
    const result = licenseStatus(record, deviceId, "activate", "FARZON");

    if (!result.success) {
      return res.render("farzon-register", {
        alert: { type: "error", message: result.message },
        successData: null,
        initialCode: code,
        initialDeviceId: deviceId,
        initialClientName: clientName
      });
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

    return res.render("farzon-register", {
      alert: null,
      successData: {
        code: saved.code,
        deviceId: saved.deviceId,
        clientName: clientName || saved.clientName,
        expiresAtText: saved.expiresAt ? saved.expiresAt.toLocaleString("ar-EG") : "ساري ومفعل"
      },
      initialCode: "",
      initialDeviceId: "",
      initialClientName: ""
    });
  } catch (error) {
    console.error("Farzon register error:", error);
    return res.render("farzon-register", {
      alert: { type: "error", message: "حدث خطأ أثناء معالجة التسجيل. حاول مرة أخرى." },
      successData: null,
      initialCode: code,
      initialDeviceId: deviceId,
      initialClientName: clientName
    });
  }
});

module.exports = router;
