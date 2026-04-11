require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountVar) {
  const data = JSON.parse(serviceAccountVar);
  if (data.private_key) data.private_key = data.private_key.replace(/\\n/g, '\n').replace(/\\+/g, '');
  admin.initializeApp({ credential: admin.credential.cert(data) });
}
admin.firestore().collection('reports').orderBy('updatedAt', 'desc').limit(1).get().then(snap => {
  const data = snap.docs[0].data();
  const topLevel = { ...data };
  delete topLevel.results; // Remove huge array for clarity
  console.log("Report Metadata:");
  console.log(JSON.stringify(topLevel, null, 2));
  process.exit(0);
});
