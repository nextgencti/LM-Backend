require('dotenv').config();
const admin = require('firebase-admin');

// 1. Try to load from environment variable
const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountVar) {
  const data = JSON.parse(serviceAccountVar);
  if (data.private_key) {
    data.private_key = data.private_key.replace(/\\n/g, '\n').replace(/\\+/g, '');
  }
  admin.initializeApp({
    credential: admin.credential.cert(data)
  });
} else {
  console.error("No FIREBASE_SERVICE_ACCOUNT found");
  process.exit(1);
}

const db = admin.firestore();

async function resetPatients() {
    // 1. Wipe Patients
    const collections = ['patients'];
    for (const coll of collections) {
        const snapshot = await db.collection(coll).get();
        let i = 0;
        for (const doc of snapshot.docs) {
            await doc.ref.delete();
            i++;
        }
        console.log(`Deleted ${i} documents from ${coll}`);
    }

    // 2. Reset Counters
    const countersSnapshot = await db.collection('system_counters').get();
    for (const doc of countersSnapshot.docs) {
        if (doc.id.includes('PAT_')) {
            await doc.ref.set({ current: 0 });
            console.log(`Reset counter ${doc.id} to 0`);
        }
    }
}

resetPatients().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
