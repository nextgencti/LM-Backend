const admin = require('firebase-admin');

/**
 * Generates an atomic sequential ID using a Firestore transaction.
 * Format: PREFIX-YYYY-XXXX (e.g., PAT-2026-0001)
 * 
 * @param {string} prefix - The ID prefix (e.g., 'PAT', 'REP', 'BKG')
 * @param {string} labId - The lab identifier to isolate the counter per lab
 * @returns {Promise<string>} The generated ID
 */
async function generateId(prefix, labId) {
  const db = admin.firestore();
  const year = new Date().getFullYear();
  
  // Namespace counter per lab. Format: {labId}_{prefix}_{year} OR {labId}_{prefix}
  let counterId;
  if (prefix === 'BL' || prefix === 'RA') {
    counterId = labId ? `${labId}_${prefix}` : `${prefix}`;
  } else {
    counterId = labId ? `${labId}_${prefix}_${year}` : `${prefix}_${year}`;
  }
  const counterRef = db.collection('system_counters').doc(counterId);

  try {
    const newId = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(counterRef);
      let currentVal = 0;

      if (!doc.exists) {
        currentVal = 1;
        transaction.set(counterRef, { current: 1 });
      } else {
        currentVal = doc.data().current + 1;
        transaction.update(counterRef, { current: currentVal });
      }

      const paddedNumber = String(currentVal).padStart(4, '0');
      if (prefix === 'BL') return `BL-${paddedNumber}`;
      if (prefix === 'RA') return `RA${paddedNumber}`;
      return `${prefix}-${year}-${paddedNumber}`;
    });

    return newId;
  } catch (error) {
    console.error(`Error generating ID for ${prefix}:`, error);
    throw new Error('Atomic ID generation failed');
  }
}

module.exports = { generateId };
