const admin = require('firebase-admin');
require('dotenv').config();

const safeParseServiceAccount = (jsonString) => {
  try {
    const cleaned = jsonString.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    return JSON.parse(cleaned);
  } catch (e) {
    return JSON.parse(jsonString);
  }
};

const serviceAccount = safeParseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function checkUser() {
  const email = 'Sanjaymsk12@gmail.com';
  const userRecord = await admin.auth().getUserByEmail(email);
  console.log('User Auth Record:', userRecord.uid, userRecord.customClaims);
  
  const userDoc = await db.collection('users').doc(userRecord.uid).get();
  if (userDoc.exists) {
    console.log('User Firestore Doc:', userDoc.data());
  } else {
    console.log('User Firestore Doc MISSING');
  }
}

checkUser().catch(console.error);
