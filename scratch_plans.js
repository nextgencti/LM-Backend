const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

async function checkPlans() {
    const snap = await db.collection('plans').get();
    snap.docs.forEach(doc => {
        console.log(`Plan: ${doc.id}`);
        console.log(doc.data().features.map(f => `${f.text}: ${f.available}`).join(' | '));
    });
}
checkPlans();
