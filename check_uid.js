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

async function check() {
  const uid = 'dojXxI52vIPw8kY9mt5X0n9cZwL2';
  console.log(`Checking user document for UID: ${uid}`);
  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) {
    console.log('User document NOT found in users collection.');
  } else {
    console.log('User Data:', JSON.stringify(doc.data(), null, 2));
  }
  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
