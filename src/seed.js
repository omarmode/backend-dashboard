require("dotenv").config();

const { connectDatabase } = require("./config/db");
const Admin = require("./models/Admin");

async function seedAdmin() {
  const username = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "ChangeMe123!";

  await connectDatabase(process.env.MONGODB_URI);

  const passwordHash = await Admin.hashPassword(password);
  const existing = await Admin.findOne({ username });

  if (existing) {
    existing.passwordHash = passwordHash;
    await existing.save();
    console.log(`Updated admin account: ${username}`);
  } else {
    await Admin.create({ username, passwordHash });
    console.log(`Created admin account: ${username}`);
  }
}

seedAdmin()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to seed admin:", error);
    process.exit(1);
  });
