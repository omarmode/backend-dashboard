require("dotenv").config();

const { connectDatabase } = require("./config/db");
const Admin = require("./models/Admin");

async function seedAdmin() {
  const username = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "ChangeMe123!";

  connectDatabase();
  await Admin.upsertFromEnv(username, password);
  console.log(`Admin account ready: ${username}`);
}

seedAdmin()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to seed admin:", error);
    process.exit(1);
  });
