import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDB } from "../database/db.js";
import { User } from "../models/users/user.model.js";
import { normalizeUsername } from "../utils/userIdentity.js";

dotenv.config();

const ensureUsername = async () => {
  const isAlreadyConnected = mongoose.connection.readyState === 1;
  if (!isAlreadyConnected) {
    await connectDB();
  }

  const users = await User.find({
    $or: [{ username: { $in: [null, "", undefined] } }, { username: { $exists: false } }],
  });
  for (const user of users) {
    let base = normalizeUsername(user.name || user.email || "user");
    if (!base) {
      base = "user";
    }

    let candidate = base;
    let suffix = 2;
    while (await User.exists({ username: candidate })) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }

    user.username = candidate;
    await user.save();
  }

  console.log(`Backfilled usernames for ${users.length} user(s).`);
  await mongoose.disconnect();
};

ensureUsername().catch((err) => {
  console.error(err);
  process.exit(1);
});
