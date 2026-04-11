const admin = require('firebase-admin');
const path = require('path');
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

const email = 'Sanjaymsk12@gmail.com';
const newPassword = 'password123';

admin.auth().getUserByEmail(email)
  .then((userRecord) => {
    return admin.auth().updateUser(userRecord.uid, {
      password: newPassword
    });
  })
  .then((userRecord) => {
    console.log('Successfully updated user password for:', userRecord.email);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error updating user password:', error);
    process.exit(1);
  });
