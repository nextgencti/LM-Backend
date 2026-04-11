const admin = require('firebase-admin');
const path = require('path');
// Since this is run FROM the backend directory
require('dotenv').config({ path: './.env' });

const safeParseServiceAccount = (raw) => {
  try { return JSON.parse(raw); } 
  catch (e1) {
    try {
      const fixed = raw.replace(/\\([A-Z])/g, '\\n$1');
      return JSON.parse(fixed);
    } catch (e2) { return null; }
  }
};

const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountVar) {
  console.error("No FIREBASE_SERVICE_ACCOUNT found in " + path.resolve('./.env'));
  process.exit(1);
}

const serviceAccount = safeParseServiceAccount(serviceAccountVar);
if (!serviceAccount) {
    console.error("Failed to parse Service Account JSON");
    process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function check() {
  console.log(`Project: ${serviceAccount.project_id}`);
  try {
    const collections = await db.listCollections();
    console.log(`Root Collections: ${collections.map(c => c.id).join(', ')}`);
    
    for (const collName of ["tests", "patients", "doctors", "reports"]) {
      const snapshot = await db.collection(collName).limit(5).get();
      console.log(`- ${collName}: ${snapshot.size} docs`);
      snapshot.forEach(doc => {
        console.log(`  [${doc.id}] -> ${JSON.stringify(doc.data()).substring(0, 50)}...`);
      });
    }
  } catch (err) {
    console.error("Check Error:", err);
  }
}

check();
