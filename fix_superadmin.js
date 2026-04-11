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

async function run() {
  const uid = 'dojXxI52vIPw8kY9mt5X0n9cZwL2';
  const email = 'sanjaymsk12@gmail.com';
  
  console.log(`Manually setting SuperAdmin claim for UID: ${uid}`);
  try {
    const user = await admin.auth().getUser(uid);
    console.log(`Current user email: ${user.email}`);
    
    await admin.auth().setCustomUserClaims(uid, { role: 'SuperAdmin' });
    console.log('Custom claims set successfully.');
    
    const updatedUser = await admin.auth().getUser(uid);
    console.log('Updated claims:', updatedUser.customClaims);
    
    // Also ensure Firestore is correct
    const db = admin.firestore();
    await db.collection('users').doc(uid).set({
      role: 'SuperAdmin',
      email: email
    }, { merge: true });
    console.log('Firestore user document updated.');
    
  } catch (err) {
    console.error('Error during update:', err.message);
  }
  process.exit(0);
}

run();
