const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config({ path: 'd:/Python/pathology-software/backend/.env' });

console.log('Environment variables check:');
console.log('FIREBASE_SERVICE_ACCOUNT defined:', !!process.env.FIREBASE_SERVICE_ACCOUNT);
console.log('SYNC_API_KEY defined:', !!process.env.SYNC_API_KEY);

const safeParseServiceAccount = (raw) => {
  try {
    return JSON.parse(raw);
  } catch (e1) {
    console.log('Normal parse failed, attempting fix...');
    const fixed = raw.replace(/\\([A-Z])/g, '\\n$1');
    return JSON.parse(fixed);
  }
};

async function check() {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT missing from .env');
    }

    const serviceAccount = safeParseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('Project ID:', serviceAccount.project_id);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    const db = admin.firestore();
    console.log('Firebase initialized. Attempting to fetch labs...');

    const labsSnap = await db.collection('labs').get();
    console.log(`Total labs in 'labs' collection: ${labsSnap.size}`);
    labsSnap.forEach(doc => {
      console.log(`- Lab: ${doc.id} (${doc.data().labName})`);
    });

    const subsSnap = await db.collection('subscriptions').get();
    console.log(`Total subscriptions: ${subsSnap.size}`);
    subsSnap.forEach(doc => {
      console.log(`- Sub: ${doc.id} (${doc.data().status})`);
    });

    const usersSnap = await db.collection('users').get();
    console.log(`Total users: ${usersSnap.size}`);

  } catch (err) {
    console.error('DIAGNOSTIC ERROR:', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    console.log('Diagnostic finished.');
    process.exit(0);
  }
}

check();
