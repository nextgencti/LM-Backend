require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountVar) {
  const data = JSON.parse(serviceAccountVar);
  if (data.private_key) data.private_key = data.private_key.replace(/\\n/g, '\n').replace(/\\+/g, '');
  admin.initializeApp({ credential: admin.credential.cert(data) });
}
admin.firestore().collection('labs').doc('LAB-EH9I5X').get().then(snap => {
  console.log(JSON.stringify(snap.data(), null, 2));
  process.exit(0);
});
