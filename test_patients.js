require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountVar) {
  const data = JSON.parse(serviceAccountVar);
  if (data.private_key) data.private_key = data.private_key.replace(/\\n/g, '\n').replace(/\\+/g, '');
  admin.initializeApp({ credential: admin.credential.cert(data) });
}
admin.firestore().collection('patients').get().then(s => {
  console.log(s.docs.map(d => ({id: d.id, ...d.data()})));
  process.exit(0);
});
