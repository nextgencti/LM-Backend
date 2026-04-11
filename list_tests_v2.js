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
  console.log("--- START TEST LIST ---");
  const snapshot = await db.collection("tests").get();
  snapshot.forEach(doc => {
    const data = doc.data();
    console.log(`ID: ${doc.id} | Name: ${data.testName} | labId: ${data.labId} | isGlobal: ${data.isGlobal}`);
  });
  console.log("--- END TEST LIST ---");
  process.exit(0);
}

check();
