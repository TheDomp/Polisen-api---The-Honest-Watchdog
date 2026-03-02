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
        reasons.push('Saknar helt GPS-koordinater. (Detta gör att incidenten inte kan visas på kartan)');
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
        reasons.push('Administrativt meddelande (Detta är ingen faktisk polisincident utan information från polisen)');
    } else {
        if (textLen > 15) {
            // Korta sammanfattningar är bra så länge de beskriver en konktret incident! (resten finns på URL)
            score += 30;
        } else if (textLen > 0) {
            score += 15;
            reasons.push('Kortfattad beskrivning. (Incidenten har så lite text att allmänheten får väldigt lite information)');
        } else {
            reasons.push('Saknar text och beskrivning helt. (Endast typ av brott är ifyllt)');
        }
    }

    // 3. Logical timestamp (no future dates, no massive delays) (20pts)
    // Police API format: "2026-02-24 13:55:28 +01:00" — fix for JS parsing
    let dateStr = event.datetime || '';
    dateStr = dateStr.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2}):(\d{2})$/, '$1T$2$3:$4');
    const eventDate = new Date(dateStr);
    const now = new Date();
    if (isNaN(eventDate.getTime())) {
        reasons.push('Ogiltigt format på tidsstämpel (Systemet kunde inte tolka när händelsen skedde)');
    } else if (eventDate > now) {
        reasons.push('Ologiskt datum: Händelsen påstås ha skett i framtiden');
    } else if ((now - eventDate) / (1000 * 60 * 60 * 24) > 30) {
        score += 10;
        reasons.push('Kraftigt fördröjd rapport (Händelsen publicerades över 30 dagar efter att den skedde)');
    } else {
        score += 20;
    }

    // 4. Proper Location Tagging (Län/Kommun) (20pts)
    const hasLocationTags = event.location && event.location.name;
    if (hasLocationTags) {
        score += 20;
    } else {
        reasons.push('Saknar geografisk region (Län eller kommun angavs inte, vilket gör regional statistik svår)');
    }

    return {
        score,
        reasons,
        isLowConfidence: score < 50
    };
}

/**
 * Delay execution to respect rate limits
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get exact GPS from OpenStreetMap Nominatim, with memory and Firestore cache
 */
async function getExactGPS(locationName, originalGPS, inMemoryCache) {
    if (!locationName) return originalGPS;

    // Rensa upp namnet (t.ex. "Södermalm, Stockholm" -> "Södermalm")
    const cleanName = locationName.split(',')[0].trim();
    const query = `${cleanName}, Sweden`;

    // Skapa ett säkert ID för Firestore cache
    const cacheId = query.toLowerCase().replace(/[^a-z0-9]/g, '_');

    // 1. Kolla lokal memory-cache från nuvarande loop
    if (inMemoryCache[cacheId]) {
        return inMemoryCache[cacheId] === 'NOT_FOUND' ? originalGPS : inMemoryCache[cacheId];
    }

    try {
        // 2. Kolla databas-cachen i Firestore
        const cacheDoc = await db.collection('geocache').doc(cacheId).get();
        if (cacheDoc.exists) {
            const cachedGps = cacheDoc.data().gps;
            inMemoryCache[cacheId] = cachedGps;
            return cachedGps === 'NOT_FOUND' ? originalGPS : cachedGps;
        }

        // 3. Hämta från OpenStreetMap (Max 1 request/sekund)
        console.log(`[Geocoding] Slår upp: ${query}...`);
        const res = await axios.get(`https://nominatim.openstreetmap.org/search`, {
            params: { format: 'json', q: query, limit: 1 },
            headers: { 'User-Agent': 'TheHonestWatchdog/1.0' }
        });

        await sleep(1200); // 1.2s delay för att vara snälla mot Nominatim

        let newGps = 'NOT_FOUND';
        if (res.data && res.data.length > 0) {
            newGps = `${res.data[0].lat},${res.data[0].lon}`;
            console.log(`[Geocoding] Hittade: ${newGps}`);
        } else {
            console.log(`[Geocoding] Hittade INTE: ${query}`);
        }

        // Spara till cache (även NOT_FOUND så vi inte spammar felaktiga adresser)
        inMemoryCache[cacheId] = newGps;
        await db.collection('geocache').doc(cacheId).set({
            gps: newGps,
            query: query,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return newGps === 'NOT_FOUND' ? originalGPS : newGps;

    } catch (err) {
        console.error(`[Geocoding] Fel vid uppslag av ${query}:`, err.message);
        return originalGPS;
    }
}

/**
 * Helper to enrich and upsert raw events to Firestore
 */
async function upsertEvents(rawEvents) {
    let upsertCount = 0;
    const inMemoryCache = {}; // Cache för pågående uppdaterings-loop

    for (const event of rawEvents) {
        const integrity = calculateIntegrityScore(event);
        let dateStr = event.datetime || '';
        dateStr = dateStr.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-]\d{2}):(\d{2})$/, (_, d, h, m, s, oh, om) => `${d}T${h.padStart(2, '0')}:${m}:${s}${oh}:${om}`);
        const eventTime = new Date(dateStr).getTime() || Date.now();

        // Få exakt GPS i bakgrunden (Hemnet-style) istället för enbart Län-koordinater
        let exactGps = event.location ? event.location.gps : null;
        if (event.location && event.location.name) {
            exactGps = await getExactGPS(event.location.name, event.location.gps, inMemoryCache);
        }

        const enrichedLocation = event.location ? { ...event.location, gps: exactGps || event.location.gps } : event.location;

        const enriched = {
            ...event,
            location: enrichedLocation,
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
        dateStr = dateStr.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-]\d{2}):(\d{2})$/, (_, d, h, m, s, oh, om) => `${d}T${h.padStart(2, '0')}:${m}:${s}${oh}:${om}`);
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
