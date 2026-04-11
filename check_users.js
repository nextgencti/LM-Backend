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
  console.log('Checking all users...');
  const usersSnap = await db.collection('users').get();
  console.log(`Total users: ${usersSnap.size}`);
  usersSnap.forEach(doc => {
    const data = doc.data();
    console.log(`- User: ${doc.id}, Email: ${data.email}, Role: ${data.role}`);
  });
  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
