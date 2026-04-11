const admin = require('firebase-admin');
const path = require('path');
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
const serviceAccount = safeParseServiceAccount(serviceAccountVar);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function check() {
  console.log(`Project: ${serviceAccount.project_id}`);
  try {
    const collections = await db.listCollections();
    console.log(`Root Collections: ${collections.map(c => c.id).sort().join(', ')}`);
    
    for (const collName of ["tests", "reports", "users"]) {
      const snapshot = await db.collection(collName).limit(1).get();
      if (!snapshot.empty) {
          console.log(`- ${collName}: Doc ID Sample -> ${snapshot.docs[0].id}`);
      } else {
          console.log(`- ${collName}: EMPTY`);
      }
    }
  } catch (err) {
    console.error("Check Error:", err);
  }
}

check();
