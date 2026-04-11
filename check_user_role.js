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
  const email = 'Sanjaymsk12@gmail.com'; // Match capitalisation from backend elevation endpoint
  console.log(`Searching for user with email: ${email}`);
  const snap = await db.collection('users').where('email', '==', email).get();
  if (snap.empty) {
    console.log('User not found in users collection.');
  } else {
    snap.forEach(doc => {
      console.log(`User ID: ${doc.id}`);
      console.log('Data:', JSON.stringify(doc.data(), null, 2));
    });
  }
  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
