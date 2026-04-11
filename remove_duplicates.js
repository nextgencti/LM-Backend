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

async function clean() {
    const collections = ['tests']; // Only duplicate tests
    for (const coll of collections) {
        const docs = await db.collection(coll).get();
        const codes = {};
        for (const doc of docs.docs) {
            const d = doc.data();
            const code = d.testCode || doc.id;
            
            if (!codes[code]) codes[code] = [];
            codes[code].push({id: doc.id, offlineId: d.offlineId, t: d.updatedAt ? d.updatedAt.toDate().getTime() : 0});
        }

        let delCount = 0;
        for (const code in codes) {
            const arr = codes[code];
            if (arr.length > 1) {
                // Keep the one with the latest timestamp
                arr.sort((a,b) => b.t - a.t);
                for (let i = 1; i < arr.length; i++) {
                    await db.collection(coll).doc(arr[i].id).delete();
                    delCount++;
                    console.log(`Deleted duplicate ${coll}:`, arr[i].id, 'for code:', code);
                }
            }
        }
        console.log(`Deleted ${delCount} duplicate ${coll}.`);
    }
}

clean().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
