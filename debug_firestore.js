const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

// Initialize Firebase
if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(sa)
        });
        console.log("Firebase initialized via Environment Variable");
    } else {
        console.error("No credentials found.");
        process.exit(1);
    }
}
const db = admin.firestore();

async function checkReports() {
    console.log("Fetching all report document IDs...");
    const snapshot = await db.collection('reports').get();
    console.log(`Total reports found: ${snapshot.size}`);
    snapshot.forEach(doc => {
        console.log(`ID: ${doc.id}`);
    });
    process.exit(0);
}

checkReports().catch(err => {
    console.error(err);
    process.exit(1);
});
