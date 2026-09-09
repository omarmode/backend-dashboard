require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const { connectDatabase } = require("./src/config/db");
const Admin = require("./src/models/Admin");
const apiRoutes = require("./src/routes/api");
const adminRoutes = require("./src/routes/admin");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";

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
  const passwordHash = await Admin.hashPassword(password);
  const existing = await Admin.findOne({ username });

  if (existing) {
    existing.passwordHash = passwordHash;
    await existing.save();
    return;
  }

  await Admin.create({ username, passwordHash });
  console.log(`Seeded admin user: ${username}`);
}

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required");
  }
  if (isProduction && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "ChangeMe123!")) {
    throw new Error("Set a strong ADMIN_PASSWORD before running in production");
  }

  await connectDatabase(process.env.MONGODB_URI);
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
        secure: isProduction,
        maxAge: 1000 * 60 * 60 * 12
      },
      store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        ttl: 60 * 60 * 12
      })
    })
  );

  app.get("/", (_req, res) => res.redirect("/admin"));
  app.use("/api", apiRoutes);
  app.use("/admin", adminRoutes);

  app.use((req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ success: false, status: "not_found", message: "المسار غير موجود" });
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
