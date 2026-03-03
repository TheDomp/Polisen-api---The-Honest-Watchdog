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
 * Korrekt GPS-koordinater för Sveriges alla Län och vanliga städer i polisens data.
 * Nominatim-geocodingen ersätts med denna tabell för att undvika felaktig placering
 * (t.ex. "Stockholms Län" → Gällnö i skärgården).
 */
const SWEDEN_LOCATIONS = {
    // ── Alla 21 Län (koordinat = resp. residensstad centrum) ──────────────────
    'stockholms län': '59.3293,18.0686',  // Stockholm
    'uppsala län': '59.8594,17.6389',  // Uppsala
    'södermanlands län': '59.3666,16.5077',  // Eskilstuna
    'östergötlands län': '58.4109,15.6216',  // Linköping
    'jönköpings län': '57.7826,14.1618',  // Jönköping
    'kronobergs län': '56.8777,14.8091',  // Växjö
    'kalmar län': '56.6616,16.3562',  // Kalmar
    'gotlands län': '57.6348,18.2948',  // Visby
    'blekinge län': '56.1612,15.5869',  // Karlskrona
    'skåne län': '55.6050,13.0038',  // Malmö
    'hallands län': '56.6745,12.8577',  // Halmstad
    'västra götalands län': '57.7089,11.9746',  // Göteborg
    'värmlands län': '59.4022,13.5115',  // Karlstad
    'örebro län': '59.2741,15.2066',  // Örebro
    'västmanlands län': '59.6099,16.5448',  // Västerås
    'dalarnas län': '60.4858,15.4367',  // Falun
    'gävleborgs län': '60.6749,17.1413',  // Gävle
    'västernorrlands län': '62.3913,17.3069',  // Härnösand
    'jämtlands län': '63.1792,14.6357',  // Östersund
    'västerbottens län': '63.8258,20.2630',  // Umeå
    'norrbottens län': '65.5848,22.1547',  // Luleå

    // ── Vanliga städer i polisens data ─────────────────────────────────────────
    'stockholm': '59.3293,18.0686',
    'göteborg': '57.7089,11.9746',
    'malmö': '55.6050,13.0038',
    'uppsala': '59.8594,17.6389',
    'linköping': '58.4109,15.6216',
    'örebro': '59.2741,15.2066',
    'västerås': '59.6099,16.5448',
    'helsingborg': '56.0465,12.6945',
    'norrköping': '58.5877,16.1924',
    'jönköping': '57.7826,14.1618',
    'umeå': '63.8258,20.2630',
    'luleå': '65.5848,22.1547',
    'gävle': '60.6749,17.1413',
    'borås': '57.7210,12.9401',
    'eskilstuna': '59.3666,16.5077',
    'södertälje': '59.1955,17.6253',
    'karlstad': '59.4022,13.5115',
    'täby': '59.4439,18.0687',
    'sundsvall': '62.3908,17.3069',
    'östersund': '63.1792,14.6357',
    'halmstad': '56.6745,12.8577',
    'växjö': '56.8777,14.8091',
    'falun': '60.4858,15.4367',
    'skellefteå': '64.7507,20.9528',
    'karlskrona': '56.1612,15.5869',
    'kalmar': '56.6616,16.3562',
    'kristianstad': '56.0294,14.1567',
    'gotland': '57.6348,18.2948',
};

/**
 * Slår upp GPS-koordinat från vår tabell. Faller tillbaka på polisens
 * original-GPS om platsen inte finns i tabellen.
 */
function lookupGPS(locationName, originalGPS) {
    if (!locationName) return originalGPS;
    const key = locationName.toLowerCase().trim();
    // Exakt träff
    if (SWEDEN_LOCATIONS[key]) return SWEDEN_LOCATIONS[key];
    // Delträff (t.ex. "Göteborg" matchar "västra götalands län")
    for (const [k, v] of Object.entries(SWEDEN_LOCATIONS)) {
        if (key.includes(k) || k.includes(key)) return v;
    }
    return originalGPS;
}

/**
 * Helper to enrich and upsert raw events to Firestore
 */
async function upsertEvents(rawEvents) {
    let upsertCount = 0;

    for (const event of rawEvents) {
        const integrity = calculateIntegrityScore(event);
        let dateStr = event.datetime || '';
        dateStr = dateStr.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-]\d{2}):(\d{2})$/, (_, d, h, m, s, oh, om) => `${d}T${h.padStart(2, '0')}:${m}:${s}${oh}:${om}`);
        const eventTime = new Date(dateStr).getTime() || Date.now();

        // Slå upp exakt GPS från vår svenska koordinattabell
        const exactGps = lookupGPS(
            event.location ? event.location.name : null,
            event.location ? event.location.gps : null
        );
        const enrichedLocation = event.location
            ? { ...event.location, gps: exactGps || event.location.gps }
            : event.location;

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
