const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const cron = require('node-cron');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check endpoint for Cron Jobs
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Helper: safely parse JSON from .env — fixes corrupted \n sequences in private keys
// When copy-pasting, \nC becomes \C (n gets dropped). We restore it here.
const safeParseServiceAccount = (raw) => {
  try {
    const data = JSON.parse(raw);
    if (data.private_key) {
      // Step 1: Replace literal "\n" sequences (slash + n) with actual newlines
      data.private_key = data.private_key.replace(/\\n/g, '\n');
      // Step 2: Replace any literal backslashes that might have been escaped multiple times
      // PEM keys do NOT contain backslashes normally.
      data.private_key = data.private_key.replace(/\\+/g, '');
    }
    return data;
  } catch (e1) {
    try {
      // Fallback for more extreme corruption
      const fixed = raw.replace(/\\([A-Z])/g, '\\n$1');
      const data = JSON.parse(fixed);
      if (data.private_key) {
        data.private_key = data.private_key.replace(/\\n/g, '\n').replace(/\\+/g, '');
      }
      return data;
    } catch (e2) {
      throw new Error(`JSON parse failed: ${e2.message}`);
    }
  }
};

// Initialize Firebase Admin
let db;
try {

  // 1. Try to load from environment variable (Recommended for Render)
  const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountVar) {
    const serviceAccount = safeParseServiceAccount(serviceAccountVar);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase initialized via Environment Variable");
  } else {
    // 2. Fallback to local file (Recommended for Local Development)
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    if (require('fs').existsSync(serviceAccountPath)) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountPath)
      });
      console.log("Firebase initialized via Local serviceAccountKey.json");
    } else {
      console.error("Firebase Caution: No credentials found. Set FIREBASE_SERVICE_ACCOUNT or add serviceAccountKey.json.");
    }
  }

  if (admin.apps.length > 0) {
    db = admin.firestore();
    console.log("Successfully connected to Firestore!");
  }
} catch (error) {
  console.error("Firebase Initialization Error:", error.message);
}

// --- MIDDLEWARE DEFINITIONS ---

// JWT Authentication
const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      role: decodedToken.role || 'Staff',
      labId: decodedToken.labId || null
    };
    next();
  } catch (error) {
    console.error('Error verifying token:', error);
    return res.status(403).json({ error: 'Forbidden: Invalid token' });
  }
};

// Subscription Validation
const checkSubscription = async (req, res, next) => {
  if (req.user.role === 'SuperAdmin') return next();
  if (!req.user.labId) return res.status(403).json({ error: "No Lab ID associated with user" });

  try {
    const subDoc = await db.collection('subscriptions').doc(String(req.user.labId)).get();
    if (!subDoc.exists) {
      return res.status(403).json({ error: "No active subscription found for this lab" });
    }
    
    const subData = subDoc.data();
    const today = new Date().toISOString().split('T')[0];
    
    // For fixed plans: check status and expiry
    if (subData.plan !== 'pay_as_you_go') {
        if (subData.status !== 'active' || (subData.expiryDate && subData.expiryDate < today)) {
           return res.status(403).json({ error: "Subscription expired or suspended" });
        }
    } else {
        // For token plans: check if status is active (expiry doesn't apply to tokens usually, or handles differently)
        if (subData.status !== 'active') {
           return res.status(403).json({ error: "Token account suspended" });
        }
        // Token balance check happens at action time (e.g. Staff create, Report finalize)
    }
    
    req.subscription = subData;
    next();
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: "Internal security error" });
  }
};

// Helper: Deduct Tokens for specific lab
const deductTokens = async (labId, taskKeyOrAmount, reason) => {
  if (!db) return { success: false, error: "Cloud connection down" };
  
  try {
    const subRef = db.collection('subscriptions').doc(String(labId));
    const subDoc = await subRef.get();
    
    if (!subDoc.exists) return { success: false, error: "No subscription found" };
    
    const subData = subDoc.data();
    if (subData.plan !== 'pay_as_you_go') return { success: true }; // Not a token lab
    
    let amount = 0;
    if (typeof taskKeyOrAmount === 'number') {
      amount = taskKeyOrAmount;
    } else {
      // Fetch plan config for dynamic price
      const planDoc = await db.collection('plans').doc('pay_as_you_go').get();
      const planData = planDoc.exists ? planDoc.data() : {};
      const config = planData.tokenConfig || {
        reportFinalization: 1,
        staffCreation: 20,
        dailyReport: 1,
        ledgerAction: 1
      };
      
      amount = config[taskKeyOrAmount] || 1; // Default to 1 if key missing
    }

    const currentBalance = subData.tokenBalance || 0;
    if (currentBalance < amount) {
      return { success: false, error: `Insufficient tokens (Balance: ${currentBalance}, Required: ${amount})` };
    }
    
    // Atomic update
    await subRef.update({
      tokenBalance: admin.firestore.FieldValue.increment(-amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Log transaction
    await db.collection('tokenLogs').add({
      labId: String(labId),
      amount: amount,
      reason: reason,
      taskKey: typeof taskKeyOrAmount === 'string' ? taskKeyOrAmount : 'direct',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return { success: true, newBalance: currentBalance - amount };
  } catch (error) {
    console.error('[Token Error]', error);
    return { success: false, error: error.message };
  }
};

// Sync API Key Verification
const verifySyncKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const secureKey = process.env.SYNC_API_KEY || 'default_sync_key_change_me';
  if (apiKey !== secureKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Sync API Key' });
  }
  next();
};

const { generateId } = require('./id_generator');

// Master Admin Key Verification
const verifyMasterKey = (req, res, next) => {
  const key = req.headers['x-master-key'];
  const masterKey = process.env.MASTER_ADMIN_KEY || 'change_this_master_key';
  if (key !== masterKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Master Admin Key' });
  }
  next();
};

// Helper: Secure Sync Handler with Auto-ID Gen and Audit
const secureSyncHandler = async (collection, prefix, req, res, versioning = false) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    const { id, offlineId, created_by, updated_by, ...data } = req.body;
    let finalId = id;
    let isNew = false;
    let currentDoc = null;

    // Detect if this is an offline record from the client
    if (!id || id.startsWith('uuid-') || offlineId) {
       // Query to see if this offline record was already synced
       const queryId = offlineId || id;
       if (queryId) {
          const snapshot = await db.collection(collection).where('offlineId', '==', String(queryId)).limit(1).get();
          if (!snapshot.empty) {
             finalId = snapshot.docs[0].id;
             currentDoc = snapshot.docs[0];
          }
       }
       
       if (!finalId || finalId.startsWith('uuid-')) {
          const labId = data.labId || data.lab_id || 'GLOBAL';
          finalId = await generateId(prefix, labId);
          isNew = true;
       }
    }

    const docRef = db.collection(collection).doc(String(finalId));
    if (!currentDoc) {
        currentDoc = await docRef.get();
    }
    
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const serverIso = new Date().toISOString();
    
    // Chronological Server-Time Enforcements for Medical Workflows
    const timeFields = ['registered_at', 'collected_at', 'received_at', 'reported_at'];
    timeFields.forEach(field => {
       if (data[field] === 'PENDING') {
           data[field] = serverIso;
       } else if (data[field] === null || data[field] === '') {
           delete data[field]; // Preserve existing data by omitting from merge block
       }
    });

    // Enforce Logical Chronology internally if processing a Report
    if (collection === 'reports') {
       const mergedState = currentDoc.exists ? { ...currentDoc.data(), ...data } : data;
       
       if (mergedState.reported_at && mergedState.received_at && new Date(mergedState.reported_at) < new Date(mergedState.received_at)) {
           return res.status(400).json({ error: "Validation Failed: reported_at cannot be chronologically before received_at" });
       }
       if (mergedState.received_at && mergedState.collected_at && new Date(mergedState.received_at) < new Date(mergedState.collected_at)) {
           return res.status(400).json({ error: "Validation Failed: received_at cannot be chronologically before collected_at" });
       }
       if (mergedState.collected_at && mergedState.registered_at && new Date(mergedState.collected_at) < new Date(mergedState.registered_at)) {
           return res.status(400).json({ error: "Validation Failed: collected_at cannot be chronologically before registered_at" });
       }
       
       // Automated Status Mapping Engine (Overrides Client UI Inputs securely)
       if (mergedState.status === 'Delivered' || data.status === 'Delivered') {
           data.status = 'Delivered';
       } else if (mergedState.reported_at || data.status === 'Final' || mergedState.status === 'Final') {
           data.status = 'Final';
       } else if (mergedState.results && mergedState.results.length > 0) {
           data.status = 'In Progress';
       } else {
           data.status = 'Pending';
       }

       // Generate a high-entropy viewToken for public QR access if it doesn't exist
       if (!mergedState.viewToken) {
           data.viewToken = crypto.randomBytes(24).toString('hex');
       }
    }

    // --- PAY AS YOU GO TOKEN ENFORCEMENT (New Bookings) ---
    if (collection === 'bookings' && isNew) {
        const labId = data.labId || data.lab_id;
        if (labId) {
            const subDoc = await db.collection('subscriptions').doc(String(labId)).get();
            if (subDoc.exists) {
                const subData = subDoc.data();
                if (subData.plan === 'pay_as_you_go' && (subData.tokenBalance || 0) <= 0) {
                    return res.status(403).json({ 
                        error: "Insufficient Tokens", 
                        code: "OUT_OF_TOKENS",
                        message: "You have 0 tokens left. Please recharge to continue bookings." 
                    });
                }
            }
        }
    }

    const payload = {
      ...data,
      id: finalId, // Embed the ID for client consumption
      updatedAt: timestamp,
      updated_by: updated_by || 'System'
    };

    if (!currentDoc.exists) {
       payload.createdAt = timestamp;
       payload.created_by = created_by || 'System';
       if (versioning) payload.version = 1;

       // Initial Audit Log
       payload.change_log = admin.firestore.FieldValue.arrayUnion(`Created by ${payload.created_by} at ${new Date().toISOString()}`);
    } else {
       // Update Audit Log and handle Versioning
       payload.change_log = admin.firestore.FieldValue.arrayUnion(`Updated by ${payload.updated_by} at ${new Date().toISOString()}`);
       
       if (versioning) {
          const currentData = currentDoc.data();
          payload.version = (currentData.version || 1) + 1;
          
          // Snapshot previous version to subcollection
          await docRef.collection('versions').doc(`v${currentData.version}`).set(currentData);
       }
    }

    await docRef.set(payload, { merge: true });

    res.json({ 
       success: true, 
       id: finalId, 
       offlineId: offlineId || (id?.startsWith('uuid-') ? id : null),
       version: payload.version,
       server_times: {
           registered_at: payload.registered_at,
           collected_at: payload.collected_at,
           received_at: payload.received_at,
           reported_at: payload.reported_at,
           status: payload.status
       },
       message: `${collection} ${finalId} synced` 
    });
  } catch (error) {
    console.error(`Secure Sync Error (${collection}):`, error);
    res.status(500).json({ error: error.message });
  }
};

// Helper: Legacy Generic Sync Handler (for backward compatibility on lab/user)
const handleSync = async (collection, id, data, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    await db.collection(collection).doc(String(id)).set({
      ...data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true, message: `${collection} ${id} synced` });
  } catch (error) {
    console.error(`Sync Error (${collection}):`, error);
    res.status(500).json({ error: error.message });
  }
};

// Role Check: SuperAdmin
const isSuperAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'SuperAdmin') {
    return next();
  }
  return res.status(403).json({ error: "Forbidden: SuperAdmin access required" });
};

// --- API ENDPOINTS ---

// Health Check
app.get('/api/verify', (req, res) => {
  res.json({ 
    status: 'online', 
    timestamp: new Date().toISOString(),
    firebase_connected: !!db 
  });
});

// Public: Firebase Web Config for Frontend
app.get('/api/config', (req, res) => {
  try {
    // Auto-derive project-based fields from existing FIREBASE_SERVICE_ACCOUNT
    // Uses safe parser to handle corrupted \\n sequences in private key
    let projectId = process.env.FB_PROJECT_ID;
    if (!projectId && process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = safeParseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
      projectId = sa.project_id;
    }

    const config = {
      apiKey:            process.env.FB_API_KEY,
      authDomain:        `${projectId}.firebaseapp.com`,
      projectId:         projectId,
      storageBucket:     `${projectId}.firebasestorage.app`,
      messagingSenderId: process.env.FB_MESSAGING_SENDER_ID,
      appId:             process.env.FB_APP_ID,
    };

    const missing = [];
    if (!config.apiKey)            missing.push('FB_API_KEY');
    if (!config.projectId)         missing.push('FB_PROJECT_ID (or FIREBASE_SERVICE_ACCOUNT)');
    if (!config.messagingSenderId) missing.push('FB_MESSAGING_SENDER_ID');
    if (!config.appId)             missing.push('FB_APP_ID');

    if (missing.length > 0) {
      return res.status(500).json({ 
        error: `Add these to backend .env:\n${missing.join('\n')}` 
      });
    }

    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build Firebase config: ' + err.message });
  }
});

// DEV ONLY: Temporary elevation endpoint
app.get('/api/dev/elevate', async (req, res) => {
  try {
    const email = 'Sanjaymsk12@gmail.com';
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { role: 'SuperAdmin' });
    if (db) {
      await db.collection('users').doc(user.uid).set({ role: 'SuperAdmin' }, { merge: true });
    }
    res.send(`Successfully elevated ${email} to SuperAdmin`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Verify SuperAdmin PIN
// This requires a valid JWT for basic protection against anonymous brute-forcing
app.post('/api/verify-pin', authenticateJWT, (req, res) => {
  try {
    const { pin } = req.body;
    const expectedPin = process.env.SUPERADMIN_PIN?.replace(/['"]/g, ''); // strip quotes if any

    if (!expectedPin) {
      return res.status(500).json({ error: "PIN verification is not configured on the server." });
    }

    if (pin === expectedPin) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: "Invalid PIN code." });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify PIN: ' + err.message });
  }
});

// Fetch Report by Booking ID
app.get('/api/report/:bookingNo', authenticateJWT, checkSubscription, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });

  const { bookingNo } = req.params;
  try {
    const reportRef = db.collection('reports').doc(bookingNo);
    const doc = await reportRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Report not found" });
    }

    const reportData = doc.data();
    
    // Security Check: Verify labId or Patient ownership (already verified via checkSubscription for LabAdmin/Staff)
    if (req.user.role !== 'SuperAdmin' && 
        req.user.labId !== reportData.labId && 
        req.user.uid !== reportData.patientId) {
      return res.status(403).json({ error: "Forbidden: Access to this report denied" });
    }

    res.json(reportData);
  } catch (error) {
    console.error("Error fetching report:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Public: Fetch Report by high-entropy viewToken (No auth required)
app.get('/api/public/report/:token', async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  const { token } = req.params;
  
  if (!token || token.length < 20) {
    return res.status(400).json({ error: "Invalid or malformed token" });
  }

  try {
    const snapshot = await db.collection('reports')
      .where('viewToken', '==', token)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: "Report not found or link expired" });
    }

    const initialReportData = snapshot.docs[0].data();
    let finalReportData = { id: snapshot.docs[0].id, ...initialReportData };

    // Fetch Master Metadata Helper
    const fetchMeta = async (r) => {
      if (!r.category || r.category === 'General' || !r.sampleType || r.sampleType === 'N/A') {
        try {
          let masterDoc = null;
          if (r.testId) {
            const tDoc = await db.collection('tests').doc(String(r.testId)).get();
            if (tDoc.exists) masterDoc = tDoc.data();
          }
          if (!masterDoc && r.testName) {
            const baseName = String(r.testName).replace(/\[\d+\]$/, '').trim();
            const searchIds = r.labId ? [String(r.labId), 'GLOBAL'] : ['GLOBAL'];
            const tDocs = await db.collection('tests').where('testName', '==', baseName).where('labId', 'in', searchIds).limit(5).get();
            if (!tDocs.empty) {
              const docsList = tDocs.docs.map(d => d.data());
              masterDoc = docsList.find(d => String(d.labId) === String(r.labId) && d.category && d.category !== 'General') 
                          || docsList.find(d => d.labId === 'GLOBAL') 
                          || docsList[0];
            }
          }
          if (masterDoc) {
            r.category = (masterDoc.category && masterDoc.category !== 'General') ? masterDoc.category : r.category;
            r.sampleType = (masterDoc.sampleType && masterDoc.sampleType !== 'N/A') ? masterDoc.sampleType : r.sampleType;
          }
        } catch(e) {}
      }
      return r;
    };

    // Handle Multi-Test Merging
    if (initialReportData.billId && initialReportData.labId) {
      const billReportsSnap = await db.collection('reports')
        .where('billId', '==', initialReportData.billId)
        .where('labId', '==', initialReportData.labId)
        .get();
        
      if (!billReportsSnap.empty) {
        const allReports = await Promise.all(billReportsSnap.docs.map(async docSnap => {
          let r = { id: docSnap.id, ...docSnap.data() };
          return await fetchMeta(r);
        }));

        const mergedResults = allReports.flatMap(r => 
          (r.results || []).map(res => ({ 
            ...res, 
            _testName: r.testName, 
            _category: r.category || 'General', 
            _sampleType: r.sampleType || 'N/A' 
          }))
        );
        const mergedTestNames = allReports.map(r => r.testName).join(', ');
        
        const isAllDelivered = allReports.every(r => r.status === 'Delivered');
        const isAllFinal = allReports.every(r => r.status === 'Final' || r.status === 'Delivered');
        
        finalReportData = {
           ...allReports[0],
           testName: mergedTestNames,
           results: mergedResults,
           status: isAllDelivered ? 'Delivered' : (isAllFinal ? 'Final' : 'In Progress')
        };
      }
    } else {
      finalReportData = await fetchMeta(finalReportData);
    }
    
    // Safety check: allow 'Final' and 'Delivered' reports
    const isViewable = finalReportData.status === 'Final' || finalReportData.status === 'Delivered';
    if (!isViewable) {
      return res.status(403).json({ error: "This report is still being processed and is not yet available for public view." });
    }

    // Fetch Lab Profile
    let labProfile = null;
    if (finalReportData.labId) {
      try {
        const ldoc = await db.collection('labs').doc(String(finalReportData.labId)).get();
        if (ldoc.exists) labProfile = ldoc.data();
      } catch(e) {}
    }

    // Fetch Patient Data
    let patientData = null;
    const pId = finalReportData.patientId || (finalReportData.labId && finalReportData.patient_id ? `${finalReportData.labId}_${finalReportData.patient_id}` : null);
    if (pId) {
      try {
        const pdoc = await db.collection('patients').doc(String(pId)).get();
        if (pdoc.exists) patientData = pdoc.data();
      } catch(e) {}
    }

    // Fetch Doctor Data
    let doctorData = null;
    if (finalReportData.bookingId) {
      try {
        const bdoc = await db.collection('bookings').doc(String(finalReportData.bookingId)).get();
        if (bdoc.exists && bdoc.data().doctorId) {
          const ddoc = await db.collection('doctors').doc(String(bdoc.data().doctorId)).get();
          if (ddoc.exists) doctorData = ddoc.data();
        }
      } catch(e) {}
    }

    res.json({ reportData: finalReportData, labProfile, patientData, doctorData });
  } catch (error) {
    console.error("Public report fetch error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Fetch All Reports for a Lab (Admin only)
app.get('/api/lab/:labId/reports', authenticateJWT, checkSubscription, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });

  const { labId } = req.params;
  
  // Security Check: Verify lab owner or SuperAdmin
  if (req.user.role !== 'SuperAdmin' && req.user.labId !== labId) {
    return res.status(403).json({ error: "Forbidden: You do not own this lab's data" });
  }

  try {
    const reportsSnapshot = await db.collection('reports')
      .where('labId', '==', isNaN(labId) ? labId : parseInt(labId))
      .orderBy('updatedAt', 'desc')
      .limit(50)
      .get();

    const reports = [];
    reportsSnapshot.forEach(doc => reports.push(doc.data()));
    
    res.json(reports);
  } catch (error) {
    console.error("Error fetching lab reports:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- AUTH API ENDPOINTS ---
app.get('/api/auth/me', authenticateJWT, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });

  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found in Firestore" });
    }

    const userData = userDoc.data();
    
    // Optionally fetch subscription if labId exists
    let subscription = null;
    if (userData.labId) {
        const subDoc = await db.collection('subscriptions').doc(String(userData.labId)).get();
        if (subDoc.exists) {
             subscription = subDoc.data();
        }
    }

    res.json({
      uid: req.user.uid,
      ...userData,
      subscription
    });
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- SIGNUP OTP VERIFICATION ---

// Helper: Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// POST /api/auth/check-email
app.post('/api/auth/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  console.log(`[CheckEmail] Checking availability for: ${email}`);

  try {
    // 1. Check Firebase Auth (Source of Truth for Login)
    try {
      const user = await admin.auth().getUserByEmail(email);
      if (user) {
        console.log(`[CheckEmail] Found in Firebase Auth: ${email}`);
        return res.json({ 
          available: false, 
          reason: 'registered',
          message: "This email is already registered. Please login instead." 
        });
      }
    } catch (authErr) {
      if (authErr.code !== 'auth/user-not-found') {
        console.error(`[CheckEmail] Auth Error:`, authErr.message);
      }
    }

    // 2. Check Firestore users collection (Secondary check)
    const userSnap = await db.collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();
    
    if (!userSnap.empty) {
      console.log(`[CheckEmail] Found in users collection: ${email}`);
      return res.json({ 
        available: false, 
        reason: 'registered',
        message: "This email is already registered. Please login instead." 
      });
    }

    // 3. Check Pending Signup Requests
    const signupSnap = await db.collection('signupRequests')
      .where('email', '==', email)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (!signupSnap.empty) {
      console.log(`[CheckEmail] Found in pending signupRequests: ${email}`);
      return res.json({ 
        available: false, 
        reason: 'pending',
        message: "A registration request for this email is already pending approval." 
      });
    }

    console.log(`[CheckEmail] Email is available: ${email}`);
    res.json({ available: true });
  } catch (error) {
    console.error(`[CheckEmail] Total Error for ${email}:`, error);
    res.status(500).json({ error: "Error checking email availability" });
  }
});

// POST /api/auth/send-signup-otp
app.post('/api/auth/send-signup-otp', async (req, res) => {
  const { email, labName } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const otp = generateOTP();
    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + 10); // 10 minutes expiry

    // Save/Update OTP in Firestore
    await db.collection('verificationOtps').doc(email).set({
      email,
      otp,
      expiry: admin.firestore.Timestamp.fromDate(expiry),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Send Email
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 500px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #0f172a; text-align: center;">Verify Your Email</h2>
        <p>Hello,</p>
        <p>Your verification code for <b>${labName || 'Lab Mitra'}</b> registration is:</p>
        <div style="background: #f1f5f9; padding: 20px; text-align: center; font-size: 32px; font-weight: 900; letter-spacing: 5px; color: #0f172a; border-radius: 8px; margin: 20px 0;">
          ${otp}
        </div>
        <p style="color: #64748b; font-size: 13px;">This code will expire in 10 minutes. If you did not request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="text-align: center; color: #94a3b8; font-size: 11px;">Powered by Lab Mitra</p>
      </div>
    `;

    await sendServerEmail({
      to: email,
      subject: `Verification Code: ${otp}`,
      html: emailHtml,
      labName: labName || 'Lab Mitra'
    });

    res.json({ success: true, message: "OTP sent to your email" });
  } catch (error) {
    console.error("Send Signup OTP Error:", error);
    res.status(500).json({ error: "Failed to send OTP. Please try again." });
  }
});

// POST /api/auth/verify-signup-otp
app.post('/api/auth/verify-signup-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: "Email and OTP are required" });

  try {
    const otpDoc = await db.collection('verificationOtps').doc(email).get();
    if (!otpDoc.exists) {
      return res.status(400).json({ error: "OTP expired or not found. Please request a new one." });
    }

    const data = otpDoc.data();
    const now = new Date();

    if (now > data.expiry.toDate()) {
      await db.collection('verificationOtps').doc(email).delete();
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    if (data.otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP code. Please check and try again." });
    }

    // Success: Delete OTP document
    await db.collection('verificationOtps').doc(email).delete();

    res.json({ success: true, message: "Email verified successfully" });
  } catch (error) {
    console.error("Verify Signup OTP Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- ADVANCED STAFF MANAGEMENT ENDPOINTS ---

// Check if user is LabAdmin or SuperAdmin and has permission for this lab
const verifyLabAdmin = (req, res, next) => {
  const reqLabId = req.body.labId || req.params.labId; // Depending on where it is
  if (req.user.role === 'SuperAdmin') return next();
  if (req.user.role === 'LabAdmin' && String(req.user.labId) === String(reqLabId)) return next();
  return res.status(403).json({ error: "Forbidden: You do not have permission to manage staff for this lab" });
};

// Create a new staff user (with Firebase Auth)
app.post('/api/auth/staff', authenticateJWT, verifyLabAdmin, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  
  const { name, email, password, role, permissions, labId } = req.body;
  
  if (!email || !password || !role || !labId) {
    return res.status(400).json({ error: "Missing required fields: email, password, role, labId" });
  }

  try {
    // 0. Enforce User Limits per Plan
    const labIdStr = String(labId);
    const subDoc = await db.collection('subscriptions').doc(labIdStr).get();
    
    if (!subDoc.exists) {
      return res.status(403).json({ error: "No subscription found for this lab. Access denied." });
    }

    const { plan } = subDoc.data();
    
    // --- PAY AS YOU GO TOKEN DEDUCTION ---
    if (plan === 'pay_as_you_go') {
      const deduction = await deductTokens(labIdStr, 'staffCreation', `Staff Creation: ${name || email}`);
      if (!deduction.success) {
        return res.status(403).json({ error: deduction.error });
      }
    }
    // --- END TOKEN DEDUCTION ---

    const planDoc = await db.collection('plans').doc(plan || 'basic').get();
    let maxUsers = plan === 'pro' ? 10 : 2; // Fallback defaults
    
    if (planDoc.exists) {
      maxUsers = planDoc.data().maxUsers || maxUsers;
    }

    // Count existing users
    const usersSnapshot = await db.collection('users').where('labId', '==', labIdStr).get();
    const currentCount = usersSnapshot.size;

    if (currentCount >= maxUsers) {
      return res.status(403).json({ 
        error: `User limit reached for your ${plan.toUpperCase()} plan (Max: ${maxUsers} users). Upgrade to Pro or contact admin to increase the limit.` 
      });
    }

    // 1. Create user in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: name,
    });

    const newUid = userRecord.uid;

    // 2. Set Custom Claims
    await admin.auth().setCustomUserClaims(newUid, {
      role: role,
      labId: String(labId)
    });

    // 3. Create document in Firestore
    const userData = {
      name: name || '',
      email,
      role,
      permissions: permissions || {},
      labId: String(labId),
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.uid
    };

    await db.collection('users').doc(newUid).set(userData);

    // If LabAdmin is created, maybe update the lab document
    if (role === 'LabAdmin') {
      await db.collection('labs').doc(String(labId)).set({ adminUid: newUid }, { merge: true });
    }

    res.json({ success: true, uid: newUid, message: "Staff user created successfully" });
  } catch (error) {
    console.error("Error creating staff:", error);
    res.status(500).json({ error: error.message });
  }
});

// Update existing staff user
app.put('/api/auth/staff/:uid', authenticateJWT, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  
  const { uid } = req.params;
  const { name, email, password, role, permissions, labId } = req.body;
  
  // Verify permissions for the edited user's lab
  if (req.user.role !== 'SuperAdmin' && (req.user.role !== 'LabAdmin' || String(req.user.labId) !== String(labId))) {
     return res.status(403).json({ error: "Forbidden: You do not have permission here" });
  }

  try {
    // 1. Update Firebase Auth Profile
    const updateData = {
      displayName: name || '',
      email: email
    };
    if (password && password.trim() !== '') {
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." });
      }
      updateData.password = password;
    }

    try {
      await admin.auth().updateUser(uid, updateData);
    } catch (authErr) {
      if (authErr.code === 'auth/user-not-found') {
        return res.status(400).json({ error: "This is a legacy 'pending' user. Please delete them and re-add them to set credentials." });
      }
      throw authErr;
    }

    // 2. Update Custom Claims completely overriding previous
    await admin.auth().setCustomUserClaims(uid, {
      role: role,
      labId: String(labId)
    });

    // 3. Update Firestore
    const userData = {
      name: name || '',
      email,
      role,
      permissions: permissions || {},
      labId: String(labId),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user.uid
    };

    await db.collection('users').doc(uid).set(userData, { merge: true });

    // Enforce Single LabAdmin Rule if changed
    if (role === 'LabAdmin') {
      await db.collection('labs').doc(String(labId)).set({ adminUid: uid }, { merge: true });
    }

    res.json({ success: true, message: "Staff user updated successfully" });
  } catch (error) {
    console.error("Error updating staff:", error);
    res.status(500).json({ error: error.message });
  }
});

// Delete staff user
app.delete('/api/auth/staff/:uid', authenticateJWT, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  
  const { uid } = req.params;

  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }
    const userData = userDoc.data();

    // Verify permissions: Only SuperAdmin or LabAdmin of the same lab can delete
    if (req.user.role !== 'SuperAdmin' && (req.user.role !== 'LabAdmin' || String(req.user.labId) !== String(userData.labId))) {
       return res.status(403).json({ error: "Forbidden: You do not have permission to delete this user" });
    }

    // A user cannot delete their own account
    if (uid === req.user.uid) {
       return res.status(400).json({ error: "You cannot delete your own account." });
    }

    // LabAdmins cannot be deleted without reassigning, or we just allow it but warn. The prompt says "delete only staff user", 
    // maybe we block deleting LabAdmin entirely? "Add a button to delete only staff user".
    if (userData.role === 'LabAdmin' && req.user.role !== 'SuperAdmin') {
       return res.status(403).json({ error: "Lab Admins cannot be deleted. Contact support." });
    }

    // Try to delete from Firebase Auth (ignore if not exists for legacy pending users)
    try {
      if (!uid.startsWith('pending_')) {
         await admin.auth().deleteUser(uid);
      }
    } catch (authErr) {
      if (authErr.code !== 'auth/user-not-found') throw authErr;
    }

    // Delete from Firestore
    await db.collection('users').doc(uid).delete();

    res.json({ success: true, message: "Staff user deleted successfully" });
  } catch (error) {
    console.error("Error deleting staff:", error);
    res.status(500).json({ error: error.message });
  }
});

// (Wait, these endpoints below use authenticateJWT which is now defined above)

app.post('/api/sync/patient', verifySyncKey, (req, res) => {
  secureSyncHandler('patients', 'PAT', req, res, false);
});

// DELETE /api/sync/patient/:id — Hard delete from Firestore
app.delete('/api/sync/patient/:id', verifySyncKey, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud connection down' });
  const { id } = req.params;
  try {
    await db.collection('patients').doc(id).delete();
    console.log(`[DELETE] Patient ${id} removed from Firestore`);
    res.json({ success: true, message: `Patient ${id} deleted` });
  } catch (error) {
    console.error('[DELETE] Patient error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- End of specific booking route (if any) ---

app.post('/api/sync/booking', verifySyncKey, (req, res) => {
  secureSyncHandler('bookings', 'BKG', req, res, false);
});

// DELETE /api/sync/booking/:id
app.delete('/api/sync/booking/:id', verifySyncKey, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud connection down' });
  const { id } = req.params;
  try {
    await db.collection('bookings').doc(id).delete();
    res.json({ success: true, message: `Booking ${id} deleted` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync/doctor', verifySyncKey, (req, res) => {
  secureSyncHandler('doctors', 'DOC', req, res, false);
});

// DELETE /api/sync/doctor/:id
app.delete('/api/sync/doctor/:id', verifySyncKey, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud connection down' });
  const { id } = req.params;
  try {
    await db.collection('doctors').doc(id).delete();
    res.json({ success: true, message: `Doctor ${id} deleted` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync/lab', verifySyncKey, (req, res) => {
  const { id, ...data } = req.body;
  handleSync('labs', id, data, res); // labs are standalone
});

app.post('/api/sync/test', verifySyncKey, (req, res) => {
  secureSyncHandler('tests', 'TST', req, res, false);
});

app.post('/api/sync/report', verifySyncKey, (req, res) => {
  secureSyncHandler('reports', 'REP', req, res, true); // Reports get versioning
});

app.post('/api/sync/testParameter', verifySyncKey, (req, res) => {
  const { id, ...data } = req.body;
  handleSync('testParameters', id, data, res);
});

app.post('/api/sync/parameterRule', verifySyncKey, (req, res) => {
  const { id, ...data } = req.body;
  handleSync('parameterRules', id, data, res);
});

app.post('/api/sync/user', verifySyncKey, async (req, res) => {
  const { id, ...data } = req.body;
  
  // 1. Sync to Firestore
  await handleSync('users', id, data, res);

  // 2. Also set Custom Claims in Firebase Auth if UID matches
  // This assumes 'id' passed from desktop app is the Firebase UID
  if (id && data.role && data.labId) {
    try {
      await admin.auth().setCustomUserClaims(id, {
        role: data.role,
        labId: data.labId
      });
      console.log(`Custom claims set for user ${id}`);
    } catch (err) {
      console.error(`Error setting custom claims for ${id}:`, err.message);
    }
  }
});

// Fetch Lab Details by Lab ID (String or INT)
app.get('/api/sync/lab/:labId', verifySyncKey, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    const { labId } = req.params;
    let snapshot = await db.collection('labs').where('labId', '==', labId).limit(1).get();
    if (snapshot.empty) {
        // Try looking up by Firestore doc ID
        const doc = await db.collection('labs').doc(labId).get();
        if (doc.exists) {
            return res.json({ id: doc.id, ...doc.data() });
        }
        return res.status(404).json({ error: "Lab not found" });
    }
    const lab = snapshot.docs[0].data();
    res.json({ id: snapshot.docs[0].id, ...lab });
  } catch (error) {
    console.error("Fetch Lab Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Download all users for a specific Lab (used to sync local DB)
app.get('/api/sync/users/:labId', verifySyncKey, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    const { labId } = req.params;
    const snapshot = await db.collection('users')
      .where('labId', '==', isNaN(labId) ? labId : parseInt(labId))
      .get();
    
    // Also try as string if not found, or just match both
    let users = [];
    snapshot.forEach(doc => users.push({ id: doc.id, ...doc.data() }));
    
    // If empty, try as string
    if (users.length === 0) {
        const snap2 = await db.collection('users').where('labId', '==', String(labId)).get();
        snap2.forEach(doc => users.push({ id: doc.id, ...doc.data() }));
    }

    res.json(users);
  } catch (error) {
    console.error("Users Download Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Download all tests (Global + Lab-specific) for a Lab
app.get('/api/sync/tests/:labId', verifySyncKey, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    const { labId } = req.params;
    const lid_str = String(labId);
    const lid_int = isNaN(labId) ? null : parseInt(labId);
    
    // Firestore "in" query for multiple labId values
    let targetIds = ["GLOBAL", lid_str];
    if (lid_int !== null) targetIds.push(lid_int);

    const snapshot = await db.collection('tests')
      .where('labId', 'in', targetIds)
      .get();
    
    let tests = [];
    snapshot.forEach(doc => tests.push({ id: doc.id, ...doc.data() }));

    // Also fetch associated parameters if they're stored in a separate collection
    // (In our current system, the 'tests' collection doc contains the 'groups' nested array,
    // which already includes parameters and rules. If they were separate, we'd fetch them here.)
    
    res.json(tests);
  } catch (error) {
    console.error("Tests Download Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Generic Download all records for a specific Collection and Lab
app.get('/api/sync/:collection/all/:labId', verifySyncKey, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    const { collection, labId } = req.params;
    
    // Only allow specific collections for security
    const allowed = ['patients', 'doctors', 'bookings', 'reports'];
    if (!allowed.includes(collection)) {
      return res.status(403).json({ error: "Unauthorized collection access" });
    }

    const lid_str = String(labId);
    const lid_int = isNaN(labId) ? null : parseInt(labId);
    
    // Query Firestore for documents matching string or numeric labId
    const snapshot = await db.collection(collection)
      .where('labId', 'in', lid_int !== null ? [lid_str, lid_int] : [lid_str])
      .get();
    
    let items = [];
    snapshot.forEach(doc => items.push({ id: doc.id, ...doc.data() }));

    res.json(items);
  } catch (error) {
    console.error(`Sync Download Error (${req.params.collection}):`, error);
    res.status(500).json({ error: error.message });
  }
});

// Delete Sync Endpoint (Optional but good for Doctors/Tests)
app.delete('/api/sync/:collection/:id', verifySyncKey, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    const { collection, id } = req.params;
    await db.collection(collection).doc(id).delete();
    res.json({ success: true, message: `${collection} ${id} deleted from cloud` });
  } catch (error) {
    console.error(`Delete Sync Error (${collection}):`, error);
    res.status(500).json({ error: error.message });
  }
});

// ─── LICENSE MANAGEMENT ENDPOINTS ────────────────────────────────────────────

// POST /api/license/validate — Called by Desktop App on login
// Checks Firestore for lab's subscription status
app.post('/api/license/validate', verifySyncKey, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud connection down. Using offline cache.' });

  let { license_key, lab_id } = req.body;
  if (!lab_id) {
    return res.status(400).json({ error: 'lab_id is required' });
  }

  try {
    let snapshot_lic;
    if (license_key) {
      snapshot_lic = await db.collection('subscriptions').where('license_key', '==', license_key).limit(1).get();
    } else {
      // Look up in subscriptions by lab_id
      snapshot_lic = await db.collection('subscriptions').where('labId', '==', String(lab_id)).limit(1).get();
      if (snapshot_lic.empty) {
        // Try numeric lab_id if string lookup fails
        snapshot_lic = await db.collection('subscriptions').where('labId', '==', parseInt(lab_id)).limit(1).get();
      }
    }

    if (snapshot_lic.empty) {
      return res.status(404).json({ valid: false, message: 'License / Lab mapping not found' });
    }

    const licData = snapshot_lic.docs[0].data();
    const today = new Date().toISOString().split('T')[0];
    const isExpired = licData.expiryDate < today;

    res.json({
      valid: !isExpired,
      plan: licData.plan || 'basic',
      status: isExpired ? 'expired' : (licData.status || 'active'),
      start_date: licData.startDate,
      expiry_date: licData.expiryDate,
      lab_name: licData.labName || '',
      license_key: licData.license_key, // Return it so client can save/cache it
      message: isExpired ? 'Subscription expired' : 'License valid'
    });
  } catch (error) {
    console.error('License validate error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/license/activate
app.post('/api/license/activate', authenticateJWT, isSuperAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud connection down' });
  const { lab_id, lab_name, plan, expiry_date, license_key } = req.body;
  try {
    const today = new Date().toISOString().split('T')[0];
    await db.collection('subscriptions').doc(String(lab_id)).set({
      labId: String(lab_id),
      labName: lab_name || `Lab ${lab_id}`,
      plan: plan,
      status: 'active',
      license_key: license_key || `LIC-${Date.now()}`,
      startDate: today,
      expiryDate: expiry_date,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true, message: `License activated for Lab ${lab_id}`, plan, expiry_date });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/subscription/:labId — Called by React Frontend on boot
app.get('/api/subscription/:labId', authenticateJWT, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud connection down' });
  const { labId } = req.params;
  try {
    // Try looking up by Firestore doc ID, then by labId field
    let docRef = db.collection('subscriptions').doc(labId);
    let doc = await docRef.get();

    if (!doc.exists) {
      // Fallback: search by labId field (string or int)
      let snap = await db.collection('subscriptions').where('labId', '==', String(labId)).limit(1).get();
      if (snap.empty) {
        snap = await db.collection('subscriptions').where('labId', '==', parseInt(labId)).limit(1).get();
      }
      
      if (snap.empty) {
        return res.status(404).json({ error: "No subscription found for this Lab ID" });
      }
      doc = snap.docs[0];
    }

    const data = doc.data();
    const today = new Date().toISOString().split('T')[0];
    const isExpired = data.expiryDate < today;

    res.json({
      ...data,
      isExpired,
      status: isExpired ? 'expired' : (data.status || 'active')
    });
  } catch (error) {
    console.error("Subscription Fetch Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/license/suspend/:labId
app.patch('/api/license/suspend/:labId', authenticateJWT, isSuperAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud connection down' });
  try {
    await db.collection('subscriptions').doc(req.params.labId).update({
      status: 'suspended',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, message: `Lab ${req.params.labId} suspended` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/superadmin/labs
app.get('/api/superadmin/labs', authenticateJWT, isSuperAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud connection down' });
  try {
    const snapshot = await db.collection('subscriptions').orderBy('createdAt', 'desc').get();
    const labs = [];
    snapshot.forEach(doc => labs.push({ id: doc.id, ...doc.data() }));
    res.json(labs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- SuperAdmin: Register New Lab (Master Registration Endpoint) ---
app.post('/api/superadmin/register-lab', authenticateJWT, isSuperAdmin, async (req, res) => {
  const { 
    labName, email, plan, months,
    labType, ownerName, phone, licenseNo,
    address, city, state, pincode,
    watermarkText, footerText
  } = req.body;

  if (!labName || !email) {
    return res.status(400).json({ error: 'Lab Name and Email are required' });
  }

  try {
    const labId = `LAB-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const licenseKey = `KEY-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const tempPassword = `Lab@${Math.floor(1000 + Math.random() * 9000)}`;

    const expiry = new Date();
    // For Pay As You Go, set a "Life-time" validity of 100 years (1200 months)
    const effectiveMonths = plan === 'pay_as_you_go' ? 1200 : parseInt(months || 12);
    expiry.setMonth(expiry.getMonth() + effectiveMonths);
    const expiryDate = expiry.toISOString().split('T')[0];
    const expiryTimestamp = admin.firestore.Timestamp.fromDate(expiry);
    const today = new Date().toISOString().split('T')[0];

    // 1. Create Firebase Auth User
    const userRecord = await admin.auth().createUser({
      email,
      password: tempPassword,
      displayName: ownerName || `${labName} Admin`
    });

    // 2. Set Custom Claims
    await admin.auth().setCustomUserClaims(userRecord.uid, {
      role: 'LabAdmin',
      labId: labId
    });

    // 3. Create Lab Document
    await db.collection('labs').doc(labId).set({
      labId,
      labName,
      email,
      labType: labType || 'Standalone',
      ownerName: ownerName || '',
      phone: phone || '',
      licenseNo: licenseNo || '',
      address: address || '',
      city: city || '',
      state: state || '',
      pincode: pincode || '',
      watermarkText: watermarkText || '',
      footerText: footerText || '',
      status: 'Active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Create Subscription Document
    await db.collection('subscriptions').doc(labId).set({
      labId,
      labName,
      plan: plan || 'basic',
      status: 'active',
      license_key: licenseKey,
      startDate: today,
      expiryDate, // String for frontend compatibility
      expiryTimestamp, // Timestamp for Firestore rules
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 5. Create User Document in Firestore
    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      name: ownerName || `${labName} Admin`,
      email,
      role: 'LabAdmin',
      labId: labId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 6. Send Welcome Email with full lab details
    try {
      const welcomeHtml = buildWelcomeEmailHtml({
        labName, ownerName, email, tempPassword, labId, licenseKey,
        plan: plan || 'basic', expiryDate, phone, address, city, state, pincode
      });
      await sendServerEmail({
        to: email,
        subject: `Welcome to Lab Mitra - Your Lab Account is Ready!`,
        html: welcomeHtml,
        labName: 'Lab Mitra'
      });
      console.log(`[Register] Welcome email sent to ${email}`);
    } catch (emailErr) {
      console.error('[Register] Welcome email failed:', emailErr.message);
      // Don't fail registration if email fails
    }

    res.json({
      success: true,
      labId,
      licenseKey,
      email,
      tempPassword,
      message: 'Lab and Admin User registered successfully'
    });
  } catch (error) {
    console.error('Master Registration Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Subscription: Fetch Lab Subscription (Secure Backend-Side) ---
app.get('/api/subscription/:labId', authenticateJWT, async (req, res) => {
  const { labId } = req.params;
  const { role, labId: userLabId } = req.user;

  // Authorization: Only SuperAdmin or the Lab's own Admin/Staff can see its subscription
  if (role !== 'SuperAdmin' && userLabId !== labId) {
    return res.status(403).json({ error: 'Permission denied. You can only access your own lab subscription.' });
  }

  try {
    const subDoc = await db.collection('subscriptions').doc(labId).get();
    if (!subDoc.exists) {
      return res.status(404).json({ error: 'Subscription not found for this lab.' });
    }
    res.json(subDoc.data());
  } catch (error) {
    console.error('Fetch Subscription Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- GLOBAL TEST MANAGEMENT ---

// Fetch all global tests
app.get('/api/tests/global', authenticateJWT, isSuperAdmin, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    const snapshot = await db.collection('tests').where('isGlobal', '==', true).get();
    const tests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(tests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Update global test with nested parameters and ranges
app.post('/api/tests/global', authenticateJWT, isSuperAdmin, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    const testData = req.body;
    const { id, ...data } = testData;
    
    // Ensure it's marked as global
    data.isGlobal = true;
    data.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    let docRef;
    if (id) {
      docRef = db.collection('tests').doc(id);
      await docRef.update(data);
    } else {
      docRef = await db.collection('tests').add({
        ...data,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ success: true, id: docRef.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete global test
app.delete('/api/tests/global/:id', authenticateJWT, isSuperAdmin, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    await db.collection('tests').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Broadcast/Sync Global Test to a specific Lab
app.post('/api/tests/sync-to-lab', authenticateJWT, isSuperAdmin, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Cloud connection down" });
  try {
    const { testId, labId } = req.body;
    if (!testId || !labId) return res.status(400).json({ error: "Missing testId or labId" });

    const testDoc = await db.collection('tests').doc(testId).get();
    if (!testDoc.exists) return res.status(404).json({ error: "Test not found" });

    const globalTestData = testDoc.data();
    
    // Create a copy for the specific lab
    const labTestRef = db.collection('labs').doc(labId).collection('tests').doc(testId);
    await labTestRef.set({
      ...globalTestData,
      isGlobal: false,
      labId: labId,
      syncedFrom: testId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// EMAIL NOTIFICATION ENDPOINT
// ─────────────────────────────────────────────────────────────
// POST /api/send-notification
// Body: { to, patientName, labName, bookingId, testNames, reportUrl? }
// Reads emailProvider from settings/global and routes accordingly.
app.post('/api/send-notification', authenticateJWT, async (req, res) => {
  try {
    let { to, subject, patientName, labName, bookingId, labId, testNames, reportUrl, reportHtml, pdfBase64 } = req.body;

    // ── DATA ENRICHMENT ──
    // If essential info is missing, fetch it using Admin SDK (bypasses client-side permission issues)
    if (bookingId && (!to || !patientName || !testNames)) {
      console.log(`Enriching notification data for bookingId: ${bookingId}`);
      
      // 1. Get Reports for this bookingId (Bill ID)
      const reportsSnap = await db.collection('reports').where('billId', '==', bookingId).get();
      if (!reportsSnap.empty) {
        const firstReport = reportsSnap.docs[0].data();
        patientName = patientName || firstReport.patientName;
        testNames = testNames || reportsSnap.docs.map(d => d.data().testName);
        const pId = firstReport.patientId;

        // 2. Get Patient Email from patients collection
        if (pId && !to) {
          const pDoc = await db.collection('patients').doc(pId).get();
          if (pDoc.exists) {
            to = pDoc.data().email;
          }
        }
      }

      // 3. Get Lab Details for branding
      if (labId && !labName) {
        const labSnap = await db.collection('labs').where('labId', '==', labId).get();
        if (!labSnap.empty) {
          const lData = labSnap.docs[0].data();
          labName = lData.labFullName || lData.labName;
        }
      }
    }

    if (!to || !patientName) {
      return res.status(400).json({ error: 'Missing recipient email (to) or patient name. Ensure patient profile has an email.' });
    }

    // 1. Fetch current email provider config from Firestore
    let provider = 'gas'; // default fallback
    let gasUrl = process.env.GAS_API_KEY;
    let resendApiKey = process.env.RESEND_API_KEY;

    try {
      const globalSettingsDoc = await db.collection('settings').doc('global').get();
      if (globalSettingsDoc.exists) {
        const gData = globalSettingsDoc.data();
        provider = gData.emailProvider || 'gas';
        // Allow override from Firestore if set (useful for multi-tenant)
        if (gData.gasUrl) gasUrl = gData.gasUrl;
        if (gData.resendApiKey) resendApiKey = gData.resendApiKey;
      }
    } catch (settingsErr) {
      console.warn('Could not fetch email settings from Firestore, using .env fallback.', settingsErr.message);
    }

    const testsFormatted = Array.isArray(testNames) ? testNames.join(', ') : (testNames || 'N/A');

    // Generate standard HTML template only if custom reportHtml is not provided
    const emailHtml = reportHtml || buildEmailHtml({ patientName, labName, bookingId, testsFormatted, reportUrl });

    // 2. Send via Unified Helper
    const result = await sendServerEmail({
      to,
      subject: subject || (pdfBase64 || reportHtml 
        ? `Pathology Report - ${patientName} (${labName || 'Lab'})`
        : `Your Lab Report is Ready - ${labName || 'Lab Mitra'}`),
      html: emailHtml,
      labName,
      pdfBase64
    });

    return res.json({ success: true, result });

  } catch (err) {
    console.error('send-notification error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper: Build HTML email template
function buildEmailHtml({ patientName, labName, bookingId, testsFormatted, reportUrl }) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f7f6; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
    .header { background: #0f172a; padding: 40px 40px 32px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 28px; letter-spacing: -0.5px; }
    .header p { color: rgba(255,255,255,0.4); margin: 8px 0 0; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; }
    .badge { display: inline-block; background: #a3e635; color: #0f172a; padding: 6px 20px; border-radius: 100px; font-size: 11px; font-weight: 900; letter-spacing: 2px; text-transform: uppercase; margin-top: 20px; }
    .body { padding: 40px; }
    .greeting { font-size: 22px; font-weight: 800; color: #0f172a; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 32px; }
    .info-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; margin-bottom: 24px; }
    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
    .info-row:last-child { border-bottom: none; }
    .info-label { font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
    .info-value { font-size: 13px; color: #0f172a; font-weight: 700; }
    .cta-btn { display: block; background: #0f172a; color: white; text-decoration: none; text-align: center; padding: 18px 32px; border-radius: 16px; font-weight: 900; font-size: 13px; letter-spacing: 1px; text-transform: uppercase; margin: 32px 0; }
    .footer { background: #f8fafc; padding: 24px 40px; text-align: center; font-size: 11px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${labName}</h1>
      <p>Pathology Management System</p>
      <div class="badge">Report Ready</div>
    </div>
    <div class="body">
      <div class="greeting">Hello, ${patientName}!</div>
      <div class="subtitle">Your lab test results are now ready for review.</div>
      <div class="info-card">
        <div class="info-row">
          <span class="info-label">Booking ID</span>
          <span class="info-value">#${bookingId}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Tests Conducted</span>
          <span class="info-value">${testsFormatted}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Status</span>
          <span class="info-value" style="color: #16a34a;">Results Ready ✓</span>
        </div>
      </div>
      ${reportUrl ? `<a href="${reportUrl}" class="cta-btn">View Full Report →</a>` : ''}
      <p style="color: #94a3b8; font-size: 13px; line-height: 1.7;">
        Please collect a printed copy from the lab or contact us if you have any questions about your report.
      </p>
    </div>
    <div class="footer">
      This is an automated notification from ${labName}. Please do not reply to this email.
    </div>
  </div>
</body>
</html>
  `.trim();
}

// Helper: Build HTML email for token status updates
function buildTokenStatusEmailHtml({ labName, adminName, status, requestedAmount, message }) {
  const isApproved = status.toLowerCase() === 'approved';
  const statusColor = isApproved ? '#16a34a' : '#e11d48';
  const statusText = isApproved ? 'Request Approved ✓' : 'Request Rejected ✕';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 32px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.04); border: 1px solid #f1f5f9; }
    .header { background: #0f172a; padding: 48px 40px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 24px; letter-spacing: -0.5px; text-transform: uppercase; font-weight: 900; }
    .header p { color: #94a3b8; margin: 8px 0 0; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; font-weight: 700; }
    .status-badge { display: inline-block; background: ${statusColor}; color: white; padding: 8px 24px; border-radius: 100px; font-size: 11px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; margin-top: 24px; box-shadow: 0 4px 12px ${statusColor}40; }
    .body { padding: 48px; }
    .greeting { font-size: 24px; font-weight: 900; color: #0f172a; margin-bottom: 12px; letter-spacing: -0.5px; }
    .content { color: #475569; font-size: 15px; line-height: 1.6; margin-bottom: 32px; font-weight: 500; }
    .info-grid { background: #f8fafc; border: 1px solid #f1f5f9; border-radius: 24px; padding: 32px; margin-bottom: 32px; }
    .info-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #f1f5f9; }
    .info-item:last-child { border-bottom: none; }
    .label { font-size: 11px; color: #94a3b8; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; }
    .value { font-size: 14px; color: #0f172a; font-weight: 700; }
    .footer { background: #f8fafc; padding: 32px; text-align: center; border-top: 1px solid #f1f5f9; }
    .footer p { margin: 0; font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${labName}</h1>
      <p>Laboratory Management</p>
      <div class="status-badge">${statusText}</div>
    </div>
    <div class="body">
      <div class="greeting">Hello, ${adminName}</div>
      <div class="content">
        ${message}
      </div>
      <div class="info-grid">
        <div class="info-item">
          <span class="label">Token Amount</span>
          <span class="value">${requestedAmount} Tokens</span>
        </div>
        <div class="info-item">
          <span class="label">Status</span>
          <span class="value" style="color: ${statusColor};">${status.toUpperCase()}</span>
        </div>
      </div>
      <p style="text-align: center; color: #94a3b8; font-size: 12px; margin: 0;">
        You can now view your updated balance in your dashboard.
      </p>
    </div>
    <div class="footer">
      <p>Automated message from Lab Mitra • SuperAdmin Action</p>
    </div>
  </div>
</body>
</html>`;
}

// Helper: Build Welcome Email for newly registered labs
function buildWelcomeEmailHtml({ labName, ownerName, email, tempPassword, labId, licenseKey, plan, expiryDate, phone, address, city, state, pincode }) {
  const fullAddress = [address, city, state, pincode].filter(Boolean).join(', ') || 'Not Provided';
  const planLabel = (plan || 'basic').replace(/_/g, ' ').toUpperCase();
  const formattedExpiry = expiryDate ? expiryDate.split('-').reverse().join('/') : 'N/A';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f4f8; margin: 0; padding: 20px; }
    .container { max-width: 640px; margin: 0 auto; background: white; border-radius: 32px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
    .header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 48px 40px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 28px; letter-spacing: -0.5px; font-weight: 900; text-transform: uppercase; }
    .header p { color: #94a3b8; margin: 8px 0 0; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; font-weight: 700; }
    .welcome-badge { display: inline-block; background: #a3e635; color: #0f172a; padding: 8px 28px; border-radius: 100px; font-size: 11px; font-weight: 900; letter-spacing: 2px; text-transform: uppercase; margin-top: 20px; box-shadow: 0 4px 12px rgba(163,230,53,0.3); }
    .body { padding: 48px 40px; }
    .greeting { font-size: 24px; font-weight: 900; color: #0f172a; margin-bottom: 8px; letter-spacing: -0.5px; }
    .subtitle { color: #64748b; font-size: 15px; line-height: 1.6; margin-bottom: 32px; }
    .section-title { font-size: 10px; font-weight: 900; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px; margin-top: 32px; padding-bottom: 8px; border-bottom: 2px solid #f1f5f9; }
    .info-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 20px; padding: 24px; margin-bottom: 16px; }
    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
    .info-row:last-child { border-bottom: none; }
    .label { font-size: 11px; color: #94a3b8; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; }
    .value { font-size: 14px; color: #0f172a; font-weight: 700; text-align: right; max-width: 60%; }
    .credential-card { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-radius: 20px; padding: 28px; margin-bottom: 16px; }
    .cred-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .cred-row:last-child { border-bottom: none; }
    .cred-label { font-size: 11px; color: #94a3b8; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; }
    .cred-value { font-size: 14px; color: #a3e635; font-weight: 700; font-family: 'Courier New', monospace; letter-spacing: 1px; }
    .warning { background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 16px; margin-top: 24px; font-size: 12px; color: #92400e; line-height: 1.6; }
    .warning strong { color: #78350f; }
    .footer { background: #f8fafc; padding: 28px 40px; text-align: center; border-top: 1px solid #f1f5f9; }
    .footer p { margin: 0; font-size: 11px; color: #94a3b8; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Lab Mitra</h1>
      <p>Laboratory Management Platform</p>
      <div class="welcome-badge">Welcome Aboard ✓</div>
    </div>
    <div class="body">
      <div class="greeting">Hello, ${ownerName || 'Admin'}!</div>
      <div class="subtitle">Your laboratory account has been successfully created. Below are your complete registration details and login credentials.</div>

      <div class="section-title">🔐 Login Credentials</div>
      <div class="credential-card">
        <div class="cred-row">
          <span class="cred-label">Email</span>
          <span class="cred-value">${email}</span>
        </div>
        <div class="cred-row">
          <span class="cred-label">Password</span>
          <span class="cred-value">${tempPassword}</span>
        </div>
      </div>

      <div class="section-title">🏥 Lab Profile</div>
      <div class="info-card">
        <div class="info-row">
          <span class="label">Lab Name</span>
          <span class="value">${labName}</span>
        </div>
        <div class="info-row">
          <span class="label">Owner / Admin</span>
          <span class="value">${ownerName || 'N/A'}</span>
        </div>
        <div class="info-row">
          <span class="label">Contact</span>
          <span class="value">${phone || 'N/A'}</span>
        </div>
        <div class="info-row">
          <span class="label">Lab ID</span>
          <span class="value">${labId}</span>
        </div>
      </div>

      <div class="section-title">📍 Facility Address</div>
      <div class="info-card">
        <div class="info-row">
          <span class="label">Address</span>
          <span class="value">${fullAddress}</span>
        </div>
      </div>

      <div class="section-title">📋 Subscription Details</div>
      <div class="info-card">
        <div class="info-row">
          <span class="label">Plan</span>
          <span class="value">${planLabel}</span>
        </div>
        <div class="info-row">
          <span class="label">License Key</span>
          <span class="value" style="font-family: 'Courier New', monospace; font-size: 12px;">${licenseKey}</span>
        </div>
        <div class="info-row">
          <span class="label">Valid Until</span>
          <span class="value">${formattedExpiry}</span>
        </div>
      </div>

      <div class="warning">
        <strong>⚠ Important:</strong> Please change your password after your first login for security purposes. Go to Settings → Change Password once logged in.
      </div>
    </div>
    <div class="footer">
      <p>This is an automated welcome email from Lab Mitra • Do not reply</p>
    </div>
  </div>
</body>
</html>`.trim();
}

// Helper: Build HTML email for Super Admin Signup Alerts
function buildAdminSignupAlertHtml({ labName, ownerName, email, phone, plan }) {
  const planLabel = (plan || 'basic').replace(/_/g, ' ').toUpperCase();
  const timestamp = new Date().toLocaleString('en-GB', { 
    day: '2-digit', month: 'long', year: 'numeric', 
    hour: '2-digit', minute: '2-digit', hour12: true 
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #fdf2f2; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 32px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.08); border: 1px solid #fee2e2; }
    .header { background: #991b1b; padding: 48px 40px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 22px; letter-spacing: 2px; text-transform: uppercase; font-weight: 900; }
    .header p { color: #fecaca; margin: 8px 0 0; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; font-weight: 700; }
    .alert-badge { display: inline-block; background: #ef4444; color: white; padding: 8px 24px; border-radius: 100px; font-size: 11px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; margin-top: 24px; box-shadow: 0 4px 12px rgba(239,68,68,0.3); }
    .body { padding: 48px; }
    .greeting { font-size: 24px; font-weight: 900; color: #1e293b; margin-bottom: 32px; letter-spacing: -0.5px; }
    .info-grid { background: #fffcfc; border: 1px solid #fee2e2; border-radius: 24px; padding: 32px; margin-bottom: 24px; }
    .info-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid #fee2e2; }
    .info-item:last-child { border-bottom: none; }
    .label { font-size: 11px; color: #94a3b8; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; }
    .value { font-size: 14px; color: #1e293b; font-weight: 700; }
    .cta-note { text-align: center; color: #64748b; font-size: 13px; margin-top: 32px; line-height: 1.6; }
    .footer { background: #fef2f2; padding: 32px; text-align: center; border-top: 1px solid #fee2e2; }
    .footer p { margin: 0; font-size: 11px; color: #991b1b; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; opacity: 0.6; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>New Lab Registration Request</h1>
      <p>System Alert • Internal Only</p>
      <div class="alert-badge">Action Required</div>
    </div>
    <div class="body">
      <div class="greeting">Hello Admin,</div>
      <div class="info-grid">
        <div class="info-item">
          <span class="label">Lab Name</span>
          <span class="value">${labName}</span>
        </div>
        <div class="info-item">
          <span class="label">Owner Name</span>
          <span class="value">${ownerName}</span>
        </div>
        <div class="info-item">
          <span class="label">Email</span>
          <span class="value">${email}</span>
        </div>
        <div class="info-item">
          <span class="label">Phone</span>
          <span class="value">${phone}</span>
        </div>
        <div class="info-item">
          <span class="label">Plan Request</span>
          <span class="value" style="color: #ef4444;">${planLabel}</span>
        </div>
        <div class="info-item" style="border-top: 2px solid #fee2e2; margin-top: 10px; padding-top: 20px;">
          <span class="label">Request Time</span>
          <span class="value" style="font-size: 12px; color: #64748b;">${timestamp}</span>
        </div>
      </div>
      <div class="cta-note">
        This request has been added to your signupRequests collection. Please review and approve/reject the account as soon as possible.
      </div>
    </div>
    <div class="footer">
      <p>Lab Mitra • Cloud Security Alert v4.2</p>
    </div>
  </div>
</body>
</html>`;
}

// ─── ADMIN NOTIFICATION ENDPOINT ──────────────────────────────────────────
// POST /api/signup/notify-admin
// Called when a new signupRequest is submitted to alert the Super Admin
app.post('/api/signup/notify-admin', async (req, res) => {
  try {
    const { labName, ownerName, email, phone, plan } = req.body;
    
    // 1. Fetch all Super Admins
    const adminsSnap = await db.collection('users').where('role', '==', 'SuperAdmin').get();
    if (adminsSnap.empty) {
      console.warn('[NotifyAdmin] No SuperAdmins found in system.');
      return res.json({ success: true, message: 'No admins to notify' });
    }

    const alertHtml = buildAdminSignupAlertHtml({ labName, ownerName, email, phone, plan });
    
    // 2. Send emails to all admins
    let notificationCount = 0;
    const promises = adminsSnap.docs.map(async (doc) => {
      const adminData = doc.data();
      if (adminData.email) {
        await sendServerEmail({
          to: adminData.email,
          subject: `🚨 Action Required: New Lab Registration (${labName})`,
          html: alertHtml,
          labName: 'Lab Mitra Alert'
        });
        notificationCount++;
      }
    });

    await Promise.all(promises);
    console.log(`[NotifyAdmin] Sent alerts to ${notificationCount} admins for ${labName}`);
    res.json({ success: true, notificationsSent: notificationCount });

  } catch (err) {
    console.error('[NotifyAdmin Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Internal Helper: Send Email via Resend or GAS
async function sendServerEmail({ to, subject, html, labName, pdfBase64 }) {
  try {
    let provider = 'gas';
    let gasUrl = process.env.GAS_API_KEY;
    let resendApiKey = process.env.RESEND_API_KEY;

    try {
      const globalSettingsDoc = await db.collection('settings').doc('global').get();
      if (globalSettingsDoc.exists) {
        const gData = globalSettingsDoc.data();
        provider = gData.emailProvider || 'gas';
        if (gData.gasUrl) gasUrl = gData.gasUrl;
        if (gData.resendApiKey) resendApiKey = gData.resendApiKey;
      }
    } catch (e) {
      console.warn('Email config fetch failed, using fallback.');
    }

    if (provider === 'resend' && resendApiKey) {
      const response = await axios.post('https://api.resend.com/emails', {
        from: `${labName || 'Lab Mitra'} <onboarding@resend.dev>`,
        to: [to],
        subject: subject,
        html: html
      }, {
        headers: { 'Authorization': `Bearer ${resendApiKey}` }
      });
      return response.data;
    } else if (gasUrl) {
      const payload = {
        action: pdfBase64 ? "SEND_PDF_BASE64" : "SEND_EMAIL_HTML",
        email: to,
        subject: subject,
        html: html,
        pdfBase64: pdfBase64
      };
      
      const response = await axios.post(gasUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        maxRedirects: 5,
        timeout: 10000 // 10s timeout
      });

      return response.data;
    }
    throw new Error('No email provider configured');
  } catch (error) {
    console.error('sendServerEmail Error:', error.message);
    // If it's a redirect issue or timeout but we're reasonably sure it hit the provider, we log but don't always crash
    if (error.code === 'ECONNABORTED' || error.response?.status === 302) {
      return { success: true, partial: true, message: "Request sent but response unclear" };
    }
    throw error;
  }
}

// ─── MANUAL DAILY REPORT TRIGGER ──────────────────────────────────────────
// POST /api/send-daily-report/:labId
// Allows SuperAdmin or LabAdmin to manually trigger the daily report email
app.post('/api/send-daily-report/:labId', authenticateJWT, async (req, res) => {
  try {
    const { labId } = req.params;
    
    // Auth check: Only SuperAdmin or LabAdmin of this lab
    if (req.user.role !== 'SuperAdmin' && req.user.labId !== labId) {
      return res.status(403).json({ error: 'Unauthorized: You can only trigger reports for your own lab.' });
    }

    // 1. Get Lab Data
    const labDoc = await db.collection('labs').doc(labId).get();
    if (!labDoc.exists) {
      return res.status(404).json({ error: 'Lab not found.' });
    }
    const labData = labDoc.data();
    const reportConfig = labData.reportSettings?.dailyReport;

    if (!reportConfig?.enabled) {
      return res.status(400).json({ error: 'Daily Report is not enabled for this lab. Please enable it in Lab Settings first.' });
    }

    const recipientEmail = reportConfig.notificationEmail || labData.email;
    if (!recipientEmail) {
      return res.status(400).json({ error: 'No recipient email configured. Please set a Recipient Email in Lab Settings.' });
    }

    // 2. Aggregate Today's Data
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const bookingsSnap = await db.collection('bookings')
      .where('labId', '==', String(labId))
      .get();

    let totalRevenue = 0;
    let bookingCount = 0;
    let testCounts = {};

    bookingsSnap.forEach(d => {
      const b = d.data();
      const createdAt = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
      if (createdAt < startOfDay) return;
      bookingCount++;
      totalRevenue += (parseFloat(b.paidAmount) || 0);
      const tests = b.testNames ? b.testNames.split(',') : [];
      tests.forEach(t => {
        const name = t.trim();
        if (name) testCounts[name] = (testCounts[name] || 0) + 1;
      });
    });

    const topTests = Object.entries(testCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');

    // 3. Construct Email
    const labName = labData.labFullName || labData.labName;
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    
    const reportHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
        <h2 style="color: #2D3250; text-align: center; border-bottom: 2px solid #9BCF83; padding-bottom: 10px;">Daily Performance Summary</h2>
        <p style="text-align: center; color: #666;">${labName} | ${dateStr}</p>
        <p style="text-align: center; color: #999; font-size: 11px; margin-top: -5px;">⚡ Manually triggered report</p>
        
        <div style="margin: 30px 0; background: #f9f9f9; padding: 20px; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
            <span style="font-weight: bold; color: #444;">Total Revenue:</span>
            <span style="color: #2D3250; font-weight: bold;">₹${totalRevenue.toLocaleString()}</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
            <span style="font-weight: bold; color: #444;">Bookings Today:</span>
            <span style="color: #2D3250; font-weight: bold;">${bookingCount}</span>
          </div>
          <div style="margin-top: 20px;">
            <p style="font-weight: bold; color: #444; margin-bottom: 5px;">Top Tests Today:</p>
            <p style="color: #666; font-size: 14px;">${topTests || 'No tests recorded today.'}</p>
          </div>
        </div>
        
        <p style="font-size: 12px; color: #999; text-align: center;">This is a manually triggered performance report generated by Lab Mitra.</p>
      </div>
    `;

    // 4. Send Email
    const globalSettingsDoc = await db.collection('settings').doc('global').get();
    const gData = globalSettingsDoc.exists ? globalSettingsDoc.data() : {};
    
    const provider = gData.emailProvider || 'gas';
    const gasUrl = gData.gasUrl || process.env.GAS_API_KEY;
    const resendApiKey = gData.resendApiKey || process.env.RESEND_API_KEY;
    
    if (provider === 'resend' && resendApiKey) {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendApiKey}` },
        body: JSON.stringify({
          from: `${labName} <onboarding@resend.dev>`,
          to: [recipientEmail],
          subject: `Daily Report: ${dateStr} - ${labName}`,
          html: reportHtml
        })
      });
      const emailData = await emailRes.json().catch(() => ({}));
      console.log(`[Manual Report] Resend response:`, emailRes.status, emailData);
      if (!emailRes.ok) {
        throw new Error(`Resend API error (${emailRes.status}): ${emailData.message || JSON.stringify(emailData)}`);
      }
    } else if (gasUrl) {
      console.log(`[Manual Report] Sending via GAS to: ${recipientEmail}, URL: ${gasUrl.substring(0, 50)}...`);
      const emailRes = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'follow',
        body: JSON.stringify({ 
          action: 'SEND_EMAIL_HTML',
          email: recipientEmail,
          patientName: labName,
          subject: `Daily Report: ${dateStr} - ${labName}`, 
          html: reportHtml 
        })
      });
      const emailText = await emailRes.text().catch(() => '');
      console.log(`[Manual Report] GAS response:`, emailRes.status, emailText);
      if (!emailRes.ok) {
        throw new Error(`GAS email error (${emailRes.status}): ${emailText}`);
      }
    } else {
      throw new Error('No email provider configured (GAS/Resend missing)');
    }

    // 5. Update Lab Metadata
    await db.collection('labs').doc(labId).update({
      'reportSettings.dailyReport.lastSent': admin.firestore.FieldValue.serverTimestamp(),
      'reportSettings.dailyReport.lastStatus': 'Success (Manual)'
    });

    console.log(`[Manual Report] Daily Report sent successfully for Lab ${labId} to ${recipientEmail}`);
    
    // --- PAY AS YOU GO TOKEN DEDUCTION ---
    const deduction = await deductTokens(labId, 'dailyReport', `Daily Report Sent (Manual)`);
    if (!deduction.success) {
      return res.status(403).json({ error: deduction.error }); // This rarely fails here since it sent already, but good for balance sync
    }
    // --- END TOKEN DEDUCTION ---

    res.json({ success: true, message: `Report sent successfully to ${recipientEmail}` });

  } catch (err) {
    console.error('[Manual Report Error]', err.message);
    res.status(500).json({ error: err.message || 'Failed to send daily report' });
  }
});

// --- TOKEN MANAGEMENT ENDPOINTS ---

// Generic endpoint to deduct 1 token for manual actions (like Printing/Emailing Ledger)
app.post('/api/tokens/deduct-action', authenticateJWT, checkSubscription, async (req, res) => {
    const { action, labId } = req.body;
    const targetLabId = req.user.role === 'SuperAdmin' ? labId : req.user.labId;
    
    if (!targetLabId) return res.status(400).json({ error: "Missing Lab ID" });
    
    const deduction = await deductTokens(targetLabId, 'ledgerAction', action || 'Generic Action');
    if (!deduction.success) {
        return res.status(403).json({ error: deduction.error });
    }
    
    res.json({ success: true, balance: deduction.newBalance });
});

// Request Tokens (LabAdmin)
app.post('/api/tokens/request', authenticateJWT, checkSubscription, async (req, res) => {
    const { requestedAmount, adminName, adminEmail, adminPhone } = req.body;
    if (!requestedAmount || requestedAmount <= 0) return res.status(400).json({ error: "Invalid amount" });
    
    try {
        const labId = String(req.user.labId);
        // Fetch fresh lab data for accurate name and notification email
        const labDoc = await db.collection('labs').doc(labId).get();
        const labData = labDoc.exists ? labDoc.data() : {};
        
        // Use lab data as primary source if frontend sends placeholders or missing data
        const finalLabName = labData.labFullName || labData.labName || req.subscription.labName || 'Unknown Lab';
        
        // Priority: Real string > Lab Settings > Lab Email > Placeholder
        let finalAdminEmail = adminEmail;
        if (!finalAdminEmail || finalAdminEmail === 'N/A' || finalAdminEmail === 'undefined') {
            finalAdminEmail = labData.reportSettings?.dailyReport?.notificationEmail || labData.email || 'N/A';
        }

        let finalAdminName = adminName;
        if (!finalAdminName || finalAdminName === 'Admin' || finalAdminName === 'undefined') {
            // Using lab names as fallback if ownerName is missing
            finalAdminName = labData.ownerName || labData.labFullName || labData.labName || 'Admin';
        }

        let finalAdminPhone = adminPhone;
        if (!finalAdminPhone || finalAdminPhone === 'N/A' || finalAdminPhone === 'undefined') {
            finalAdminPhone = labData.phone || labData.mobile || 'N/A';
        }

        await db.collection('tokenRequests').add({
            labId: labId,
            requestedAmount: parseInt(requestedAmount),
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: req.user.uid,
            labName: finalLabName,
            adminName: finalAdminName,
            adminEmail: finalAdminEmail,
            adminPhone: finalAdminPhone,
            requestTime: new Date().toISOString()
        });
        res.json({ success: true, message: "Token request submitted to Super Admin" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List Token Requests (SuperAdmin)
app.get('/api/superadmin/token-requests', authenticateJWT, isSuperAdmin, async (req, res) => {
    try {
        const snap = await db.collection('tokenRequests').orderBy('createdAt', 'desc').limit(50).get();
        const requests = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(requests);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add Tokens / Approve Request (SuperAdmin)
app.post('/api/superadmin/add-tokens', authenticateJWT, isSuperAdmin, async (req, res) => {
    const { labId, amount, requestId } = req.body;
    console.log(`[Backend-AddTokens] Request from ${req.user.uid} for Lab: ${labId}, Amount: ${amount}, RequestID: ${requestId}`);
    
    if (!labId || !amount) {
        console.error("[Backend-AddTokens] Validation Failed: Missing labId or amount");
        return res.status(400).json({ error: "Missing labId or amount" });
    }
    
    try {
        console.log(`[Backend-AddTokens] Updating subscription for Lab: ${labId}`);
        const subRef = db.collection('subscriptions').doc(String(labId));
        await subRef.set({
            tokenBalance: admin.firestore.FieldValue.increment(parseInt(amount)),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        console.log(`[Backend-AddTokens] Logging transaction...`);
        // Log top-up
        await db.collection('tokenLogs').add({
            labId: String(labId),
            amount: parseInt(amount),
            reason: 'Token Top-up (SuperAdmin Approved)',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            approvedBy: req.user.uid
        });
        
        // Update request status if provided
        if (requestId) {
            console.log(`[Backend-AddTokens] Updating request status and sending email for: ${requestId}`);
            await db.collection('tokenRequests').doc(requestId).update({ status: 'approved', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            
            // ── SEND CONFIRMATION EMAIL ──
            try {
                const reqDoc = await db.collection('tokenRequests').doc(requestId).get();
                if (reqDoc.exists) {
                    const rData = reqDoc.data();
                    const adminEmail = rData.adminEmail;
                    const adminName = rData.adminName || 'Admin';
                    const labName = rData.labName || 'Your Laboratory';
                    const requestedAmount = rData.requestedAmount || amount;

                    if (adminEmail && adminEmail !== 'N/A') {
                        const emailHtml = buildTokenStatusEmailHtml({
                            labName,
                            adminName,
                            status: 'Approved',
                            requestedAmount,
                            message: `Positive news! Your request for <b>${requestedAmount} tokens</b> has been approved by the Super Admin. Your balance has been updated accordingly.`
                        });

                        await sendServerEmail({
                            to: adminEmail,
                            subject: `Token Request Approved - ${labName}`,
                            html: emailHtml,
                            labName: 'Lab Mitra'
                        });
                        console.log(`[Backend-AddTokens] Approval email sent to ${adminEmail}`);
                    }
                }
            } catch (emailErr) {
                console.error("[Backend-AddTokens] Email notification failed:", emailErr.message);
            }
        }
        
        console.log(`[Backend-AddTokens] Success!`);
        res.json({ success: true, message: `Successfully added ${amount} tokens to Lab ${labId}` });
    } catch (error) {
        console.error("[Backend-AddTokens] Logic Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Reject Token Request (SuperAdmin)
app.post('/api/superadmin/reject-token-request', authenticateJWT, isSuperAdmin, async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: "Missing requestId" });
    
    try {
        console.log(`[Backend-RejectToken] Rejecting request: ${requestId}`);
        await db.collection('tokenRequests').doc(requestId).update({ 
            status: 'rejected', 
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            rejectedBy: req.user.uid
        });

        // ── SEND REJECTION EMAIL ──
        try {
            const reqDoc = await db.collection('tokenRequests').doc(requestId).get();
            if (reqDoc.exists) {
                const rData = reqDoc.data();
                const adminEmail = rData.adminEmail;
                const adminName = rData.adminName || 'Admin';
                const labName = rData.labName || 'Your Laboratory';
                const requestedAmount = rData.requestedAmount;

                if (adminEmail && adminEmail !== 'N/A') {
                    const emailHtml = buildTokenStatusEmailHtml({
                        labName,
                        adminName,
                        status: 'Rejected',
                        requestedAmount,
                        message: `We regret to inform you that your request for <b>${requestedAmount} tokens</b> has been rejected by the Super Admin at this time. Please contact support if you believe this is an error.`
                    });

                    await sendServerEmail({
                        to: adminEmail,
                        subject: `Token Request Rejected - ${labName}`,
                        html: emailHtml,
                        labName: 'Lab Mitra'
                    });
                    console.log(`[Backend-RejectToken] Rejection email sent to ${adminEmail}`);
                }
            }
        } catch (emailErr) {
            console.error("[Backend-RejectToken] Email notification failed:", emailErr.message);
        }

        res.json({ success: true, message: "Token request rejected successfully" });
    } catch (error) {
        console.error("[Backend-RejectToken] Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

// ─── DAILY REPORT SCHEDULER (node-cron) ───────────────────────────────────
// Runs every minute to check if any lab needs their daily report sent.
cron.schedule('* * * * *', async () => {
  if (!db) return;
  
  const now = new Date();
  console.log(`[Cron Heartbeat] Checking for daily reports at ${now.toISOString()}`);
  
  // ── TIMEZONE STANDARDIZATION (IST) ──
  // Convert UTC server time to Asia/Kolkata (IST) for comparison with lab set-time
  const istTimeStr = now.toLocaleString('en-US', { 
    timeZone: 'Asia/Kolkata', 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  const currentTime = istTimeStr; 
  
  try {
    // 1. Find all labs that have Daily Report enabled
    // We query enabled labs first, then filter by time in memory for better flexibility
    const labsSnap = await db.collection('labs')
      .where('reportSettings.dailyReport.enabled', '==', true)
      .get();

    if (labsSnap.empty) return;

    for (const labDoc of labsSnap.docs) {
      const labData = labDoc.data();
      const labId = labDoc.id;
      const reportConfig = labData.reportSettings.dailyReport;
      
      // Match HH:mm ignoring seconds
      const scheduledTimeShort = reportConfig.time ? reportConfig.time.substring(0, 5) : ""; 
      if (scheduledTimeShort !== currentTime) continue;

      console.log(`[Cron] Processing scheduled report for Lab ${labId} at ${currentTime}`);
      
      const recipientEmail = reportConfig.notificationEmail || labData.email;

      if (!recipientEmail) {
        console.warn(`[Cron] No recipient email found for Lab ${labId}. Skipping.`);
        continue;
      }

      // 2. Aggregate Today's Data (In-memory filtering to avoid composite index requirement)
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const bookingsSnap = await db.collection('bookings')
        .where('labId', '==', String(labId))
        .get();

      let totalRevenue = 0;
      let bookingCount = 0;
      let testCounts = {};

      bookingsSnap.forEach(doc => {
        const b = doc.data();
        
        // Manual date filter
        const createdAt = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
        if (createdAt < startOfDay) return;

        bookingCount++;
        totalRevenue += (parseFloat(b.paidAmount) || 0);
        
        const tests = b.testNames ? b.testNames.split(',') : [];
        tests.forEach(t => {
          const name = t.trim();
          if (name) testCounts[name] = (testCounts[name] || 0) + 1;
        });
      });

      const topTests = Object.entries(testCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name} (${count})`)
        .join(', ');

      // 3. Construct Email
      const labName = labData.labFullName || labData.labName;
      const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
      
      const reportHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
          <h2 style="color: #2D3250; text-align: center; border-bottom: 2px solid #9BCF83; padding-bottom: 10px;">Daily Performance Summary</h2>
          <p style="text-align: center; color: #666;">${labName} | ${dateStr}</p>
          
          <div style="margin: 30px 0; background: #f9f9f9; padding: 20px; border-radius: 8px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
              <span style="font-weight: bold; color: #444;">Total Revenue:</span>
              <span style="color: #2D3250; font-weight: bold;">₹${totalRevenue.toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
              <span style="font-weight: bold; color: #444;">Bookings Today:</span>
              <span style="color: #2D3250; font-weight: bold;">${bookingCount}</span>
            </div>
            <div style="margin-top: 20px;">
              <p style="font-weight: bold; color: #444; margin-bottom: 5px;">Top Tests Today:</p>
              <p style="color: #666; font-size: 14px;">${topTests || 'No tests recorded today.'}</p>
            </div>
          </div>
          
          <p style="font-size: 12px; color: #999; text-align: center;">This is an automated performance report generated by Lab Mitra.</p>
        </div>
      `;

      try {
        // ... (data aggregation and construct email logic stays the same) ...
        // (Sending email logic ...)

        const globalSettingsDoc = await db.collection('settings').doc('global').get();
        const gData = globalSettingsDoc.exists ? globalSettingsDoc.data() : {};
        
        const provider = gData.emailProvider || 'gas';
        const gasUrl = gData.gasUrl || process.env.GAS_API_KEY;
        const resendApiKey = gData.resendApiKey || process.env.RESEND_API_KEY;
        
        if (provider === 'resend' && resendApiKey) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendApiKey}` },
            body: JSON.stringify({
              from: `${labName} <onboarding@resend.dev>`,
              to: [recipientEmail],
              subject: `Daily Report: ${dateStr} - ${labName}`,
              html: reportHtml
            })
          });
        } else if (gasUrl) {
          await fetch(gasUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            redirect: 'follow',
            body: JSON.stringify({ 
              action: 'SEND_EMAIL_HTML',
              email: recipientEmail,
              patientName: labName,
              subject: `Daily Report: ${dateStr} - ${labName}`, 
              html: reportHtml 
            })
          });
        } else {
          throw new Error('No email provider configured (GAS/Resend missing)');
        }

        // 5. Update Lab Metadata with Success
        await db.collection('labs').doc(labId).update({
          'reportSettings.dailyReport.lastSent': admin.firestore.FieldValue.serverTimestamp(),
          'reportSettings.dailyReport.lastStatus': 'Success'
        });

        // --- PAY AS YOU GO TOKEN DEDUCTION ---
        await deductTokens(labId, 'dailyReport', `Daily Report Sent (Automated)`);

        console.log(`[Cron] Daily Report sent successfully for Lab ${labId} to ${recipientEmail}`);

      } catch (labErr) {
        console.error(`[Cron Lab Error] Failed for Lab ${labId}:`, labErr.message);
        await db.collection('labs').doc(labId).update({
          'reportSettings.dailyReport.lastStatus': `Error: ${labErr.message}`
        });
      }
    }
  } catch (err) {
    console.error(`[Cron Error] Problem sending daily reports:`, err);
    // Note: Since the loop might fail halfway, we'd ideally want to log per individual lab.
    // However, for the main catch, we log the system error.
  }
});
