const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const admin = require('firebase-admin');
const serviceAccount = require('./firebase-key.json');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

/**
 * The "Honesty Engine" Calculator
 * Calculates Integrity Score (0-100)
 */
function calculateIntegrityScore(event) {
    let score = 0;
    const reasons = [];

    // 1. Presence of GPS coordinates (30pts)
    const hasGPS = event.location && event.location.gps && event.location.gps !== '0,0';
    if (hasGPS) {
        score += 30;
    } else {
        reasons.push('Missing GPS coordinates');
    }

    // 2. Information Value & Description Quality (30pts)
    const summary = event.summary || '';
    const textLen = summary.length + (event.description || '').length;
    const lowerSummary = summary.toLowerCase();

    // Endast straffa om det är administrativt skräp eller extremt kort
    const isMetaPost =
        lowerSummary.includes('frågor från media') ||
        lowerSummary.includes('ingen presstalesperson i tjänst') ||
        lowerSummary.includes('ändrade öppettider');

    if (isMetaPost) {
        reasons.push('Administrativt meddelande (ej specifik incident)');
    } else {
        if (textLen > 15) {
            // Korta sammanfattningar är bra så länge de beskriver en konktret incident! (resten finns på URL)
            score += 30;
        } else if (textLen > 0) {
            score += 15;
            reasons.push('Väldigt kort beskrivning');
        } else {
            reasons.push('Saknar beskrivning helt');
        }
    }

    // 3. Logical timestamp (no future dates, no massive delays) (20pts)
    // Police API format: "2026-02-24 13:55:28 +01:00" — fix for JS parsing
    let dateStr = event.datetime || '';
    dateStr = dateStr.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2}):(\d{2})$/, '$1T$2$3:$4');
    const eventDate = new Date(dateStr);
    const now = new Date();
    if (isNaN(eventDate.getTime())) {
        reasons.push('Invalid timestamp format');
    } else if (eventDate > now) {
        reasons.push('Event date is in the future');
    } else if ((now - eventDate) / (1000 * 60 * 60 * 24) > 30) {
        score += 10;
        reasons.push('Event is significantly delayed/old');
    } else {
        score += 20;
    }

    // 4. Proper Location Tagging (Län/Kommun) (20pts)
    const hasLocationTags = event.location && event.location.name;
    if (hasLocationTags) {
        score += 20;
    } else {
        reasons.push('Missing proper location tags (Län/Kommun)');
    }

    return {
        score,
        reasons,
        isLowConfidence: score < 50
    };
}

/**
 * Helper to enrich and upsert raw events to Firestore
 */
async function upsertEvents(rawEvents) {
    let upsertCount = 0;
    for (const event of rawEvents) {
        const integrity = calculateIntegrityScore(event);
        let dateStr = event.datetime || '';
        dateStr = dateStr.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2}):(\d{2})$/, '$1T$2$3:$4');
        const eventTime = new Date(dateStr).getTime() || Date.now();

        const enriched = {
            ...event,
            qa_integrity: integrity,
            timestamp: eventTime
        };

        const docRef = db.collection('incidents').doc(String(event.id));
        await docRef.set(enriched, { merge: true });
        upsertCount++;
    }
    return upsertCount;
}

/**
 * Fetch real data from Swedish Police API and sync to Firestore
 */
async function syncPoliceData() {
    try {
        console.log('Fetching new data from Polisen API...');
        const response = await axios.get('https://polisen.se/api/events');
        const upsertCount = await upsertEvents(response.data);
        console.log(`Successfully synced ${upsertCount} latest incidents to Firebase.`);
        await pruneOldIncidents();
    } catch (error) {
        console.error('Error syncing data:', error.message);
    }
}

/**
 * Fetch historical data for the past 7 days (runs once on startup)
 */
async function fetchHistoricalData() {
    try {
        console.log('Fetching historical data for the past 7 days...');
        let totalHistorical = 0;
        for (let i = 1; i <= 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateString = d.toISOString().split('T')[0];

            try {
                const response = await axios.get(`https://polisen.se/api/events?DateTime=${dateString}`);
                const count = await upsertEvents(response.data);
                totalHistorical += count;
                console.log(`Fetched ${count} incidents for ${dateString}`);
            } catch (err) {
                console.error(`Error fetching historical for ${dateString}:`, err.message);
            }
            // Small delay to be polite to the police API
            await new Promise(res => setTimeout(res, 500));
        }
        console.log(`Historical sync complete! Added/Updated ${totalHistorical} older incidents.`);
    } catch (error) {
        console.error('Error fetching historical data:', error.message);
    }
}

/**
 * Prune incidents older than 7 days
 */
async function pruneOldIncidents() {
    try {
        console.log('Pruning incidents older than 7 days...');
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const snapshot = await db.collection('incidents')
            .where('timestamp', '<', sevenDaysAgo)
            .get();

        if (snapshot.empty) {
            console.log('No old incidents to prune.');
            return;
        }

        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        console.log(`Pruned ${snapshot.size} old incidents.`);
    } catch (err) {
        console.error('Error pruning data:', err.message);
    }
}

// Start background sync immediately
(async () => {
    // 1. First time startup: Fill the blanks (last 7 days)
    await fetchHistoricalData();
    // 2. Fetch the absolute latest
    await syncPoliceData();
    // 3. Keep polling every 10 minutes
    setInterval(syncPoliceData, 10 * 60 * 1000);
})();

/**
 * Manual trigger for debugging
 */
app.get('/api/fetch-police-data', async (req, res) => {
    await syncPoliceData();
    res.json({ message: 'Sync triggered successfully!' });
});

/**
 * Get all incidents from Firestore
 */
app.get('/api/incidents', async (req, res) => {
    try {
        const snapshot = await db.collection('incidents')
            .orderBy('timestamp', 'desc')
            .limit(1000)
            .get();
        const results = [];
        snapshot.forEach(doc => results.push(doc.data()));
        res.json(results);
    } catch (error) {
        console.error('Error fetching from DB:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * The QA Sandbox Endpoint - Inject Corrupt Data to Firestore
 */
app.post('/api/test-sandbox/inject', async (req, res) => {
    try {
        const corruptData = req.body;
        const integrity = calculateIntegrityScore(corruptData);
        let dateStr = corruptData.datetime || '';
        dateStr = dateStr.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2}):(\d{2})$/, '$1T$2$3:$4');
        const eventTime = new Date(dateStr).getTime() || Date.now();

        const enrichedData = {
            ...corruptData,
            qa_integrity: integrity,
            isMockedData: true,
            timestamp: eventTime + 10000 // Boost a bit to ensure it shows at the top
        };

        const docRef = db.collection('incidents').doc('mock_' + corruptData.id);
        await docRef.set(enrichedData);

        res.json({
            message: 'Corrupt data injected and scored!',
            result: enrichedData
        });
    } catch (error) {
        console.error('Error injecting mock data:', error);
        res.status(500).json({ error: 'Failed to inject Mock Data' });
    }
});

const PORT = 3030;
app.listen(PORT, () => {
    console.log(`Honest Watchdog API running on http://localhost:${PORT}`);
});
