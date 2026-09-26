import dns from "dns";
import mongoose from "mongoose";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) { }

const SOURCE_URI = "mongodb://127.0.0.1:27017/saloon_erp_test";
const TARGET_URI = "mongodb+srv://kushbhardwaj8800:xxxxxxxxx@kushcluster.hinejtf.mongodb.net/saloon_erp_test";

async function transferData() {
  console.log("🚀 Starting data migration from Local to Atlas...");
  console.log(`Source: ${SOURCE_URI}`);
  console.log(`Target: ${TARGET_URI}\n`);

  const sourceConn = await mongoose.createConnection(SOURCE_URI).asPromise();
  console.log("✅ Connected to Local source MongoDB");

  const targetConn = await mongoose.createConnection(TARGET_URI).asPromise();
  console.log("✅ Connected to Atlas target MongoDB");

  const sourceDb = sourceConn.db;
  const targetDb = targetConn.db;

  const collections = await sourceDb.listCollections().toArray();
  console.log(`\nFound ${collections.length} collections in source database.`);

  const summary = [];

  for (const collInfo of collections) {
    const collName = collInfo.name;
    if (collName.startsWith("system.")) continue;

    const srcColl = sourceDb.collection(collName);
    const tgtColl = targetDb.collection(collName);

    const docCount = await srcColl.countDocuments();
    if (docCount === 0) {
      console.log(`⏭️  Skipping empty collection: ${collName}`);
      summary.push({ collection: collName, sourceCount: 0, targetCount: 0, status: "skipped (empty)" });
      continue;
    }

    console.log(`\n📦 Processing collection: '${collName}' (${docCount} documents)...`);

    // Fetch all documents from source
    const docs = await srcColl.find({}).toArray();

    // Use bulk write with upsert on _id to prevent duplicate key errors and preserve existing data
    const bulkOps = docs.map((doc) => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    }));

    const result = await tgtColl.bulkWrite(bulkOps, { ordered: false });
    console.log(`   Upserted: ${result.upsertedCount}, Modified: ${result.modifiedCount}, Matched: ${result.matchedCount}`);

    // Replicate indexes (excluding the default _id index)
    try {
      const srcIndexes = await srcColl.indexes();
      for (const idx of srcIndexes) {
        if (idx.name === "_id_") continue;
        const keys = idx.key;
        const options = { name: idx.name };
        if (idx.unique) options.unique = idx.unique;
        if (idx.sparse) options.sparse = idx.sparse;
        if (idx.expireAfterSeconds !== undefined) options.expireAfterSeconds = idx.expireAfterSeconds;
        await tgtColl.createIndex(keys, options);
      }
      console.log(`   ✅ Indexes copied`);
    } catch (idxErr) {
      console.log(`   ⚠️ Index creation note for ${collName}: ${idxErr.message}`);
    }

    const tgtCount = await tgtColl.countDocuments();
    summary.push({ collection: collName, sourceCount: docCount, targetCount: tgtCount, status: "success" });
  }

  await sourceConn.close();
  await targetConn.close();

  console.log("\n==================================================");
  console.log("📊 MIGRATION SUMMARY (Local -> Atlas)");
  console.log("==================================================");
  console.table(summary);
  console.log("🎉 Data migration completed successfully!");
}

transferData().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
