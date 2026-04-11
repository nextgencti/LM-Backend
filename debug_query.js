const admin = require('firebase-admin');
require('dotenv').config({ path: 'd:/Python/pathology-software/backend/.env' });

const safeParseServiceAccount = (raw) => {
  try {
    return JSON.parse(raw);
  } catch (e1) {
    const fixed = raw.replace(/\\([A-Z])/g, '\\n$1');
    return JSON.parse(fixed);
  }
};

const serviceAccount = safeParseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function testQuery() {
  try {
    console.log("Running query: tests.where('isGlobal', '==', true).orderBy('testName').get()");
    const snapshot = await db.collection('tests').where('isGlobal', '==', true).orderBy('testName').get();
    console.log(`Success! Found ${snapshot.size} tests.`);
    snapshot.forEach(doc => console.log(doc.id, doc.data().testName));
  } catch (err) {
    console.error("Query failed:", err.message);
  }
  process.exit(0);
}

testQuery();
