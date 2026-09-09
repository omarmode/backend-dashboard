const mongoose = require("mongoose");

async function connectDatabase(mongoUri) {
  if (!mongoUri) {
    throw new Error("MONGODB_URI is missing. Set it in .env or the host environment.");
  }

  mongoose.set("strictQuery", true);
  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");
}

module.exports = { connectDatabase };
