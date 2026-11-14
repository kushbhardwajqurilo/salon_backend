import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGO_URI || 'mongodb+srv://kushbhardwaj8800:g38VQcYIESBTWQRR@kushcluster.hinejtf.mongodb.net/?retryWrites=false';

async function cleanupTestDatabases() {
  try {
    console.log('Connecting to MongoDB Atlas cluster...');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log('Connected successfully!');

    const admin = mongoose.connection.db.admin();
    const dbsInfo = await admin.listDatabases();

    console.log('\n--- Scanning for ephemeral test databases (matching ^s_erp_test_) ---');
    let droppedCount = 0;
    let freedCollections = 0;

    for (const dbInfo of dbsInfo.databases) {
      if (dbInfo.name.startsWith('s_erp_test_')) {
        const db = mongoose.connection.client.db(dbInfo.name);
        const cols = await db.listCollections().toArray();
        console.log(`Dropping test database: ${dbInfo.name} (${cols.length} collections)...`);
        await db.dropDatabase();
        droppedCount++;
        freedCollections += cols.length;
      }
    }

    console.log(`\nSuccessfully dropped ${droppedCount} test databases.`);
    console.log(`Freed ${freedCollections} collections!`);

    // Verify current state
    const afterDbs = await admin.listDatabases();
    let remainingCols = 0;
    console.log('\n=== CURRENT CLUSTER STATE ===');
    for (const dbInfo of afterDbs.databases) {
      const db = mongoose.connection.client.db(dbInfo.name);
      const cols = await db.listCollections().toArray();
      console.log(`Database: ${dbInfo.name.padEnd(25)} | Collections: ${cols.length.toString().padStart(4)}`);
      remainingCols += cols.length;
    }
    console.log(`=== TOTAL REMAINING COLLECTIONS: ${remainingCols} of 500 max allowed ===\n`);

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error during cleanup:', err);
    process.exit(1);
  }
}

cleanupTestDatabases();
