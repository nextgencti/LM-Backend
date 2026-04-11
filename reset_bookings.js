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

async function resetBookings() {
    // 1. Wipe Bookings and Reports
    const collections = ['bookings', 'reports'];
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
    const year = new Date().getFullYear();
    const counters = [`BKG_${year}`, `REP_${year}`];
    
    for (const counterId of counters) {
        await db.collection('system_counters').doc(counterId).set({ current: 0 });
        console.log(`Reset counter ${counterId} to 0`);
    }
}

resetBookings().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
