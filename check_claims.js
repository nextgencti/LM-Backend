const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
    console.error('Service account key not found at:', serviceAccountPath);
    process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountPath)
});

const email = 'Sanjaymsk12@gmail.com';

admin.auth().getUserByEmail(email)
  .then((userRecord) => {
    console.log('User found:', userRecord.uid);
    console.log('Custom Claims:', JSON.stringify(userRecord.customClaims || {}));
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error fetching user data:', error);
    process.exit(1);
  });
