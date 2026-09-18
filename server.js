require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const session = require("express-session");
const { connectDatabase } = require("./src/config/db");
const Admin = require("./src/models/Admin");
const apiRoutes = require("./src/routes/api");
const adminRoutes = require("./src/routes/admin");
const farzonRoutes = require("./src/routes/farzon");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";
const useSecureCookies =
  process.env.COOKIE_SECURE === "true" ||
  process.env.RENDER === "true";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(cors());
app.use(morgan(isProduction ? "combined" : "dev"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

async function ensureAdminAccount() {
  const username = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "ChangeMe123!";
  await Admin.upsertFromEnv(username, password);
  console.log(`Admin account ready: ${username}`);
}

async function start() {
  if (!process.env.SUPABASE_URL) {
    throw new Error("SUPABASE_URL is required");
  }
  if (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_ANON_KEY is required");
  }
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required");
  }
  if (isProduction && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "ChangeMe123!")) {
    throw new Error("Set a strong ADMIN_PASSWORD before running in production");
  }

  connectDatabase();
  await ensureAdminAccount();

  app.use(
    session({
      name: "farz.sid",
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: useSecureCookies,
        maxAge: 1000 * 60 * 60 * 12
      }
    })
  );

  app.get("/", (_req, res) => res.redirect("/admin"));
  app.use("/api", apiRoutes);
  app.use("/admin", adminRoutes);
  app.use("/farzon", farzonRoutes);

  app.use((req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({
        success: false,
        status: "not_found",
        message: "المسار غير موجود"
      });
    }
    return res.status(404).send("الصفحة غير موجودة");
  });

  app.listen(PORT, () => {
    console.log(`FARZ licensing server running on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
