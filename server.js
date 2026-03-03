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
 * Korrekt GPS-koordinater för Sveriges alla Lån, kommuner och Stockholmsstadsdelar.
 * Polisens API returnerar ofta fel koordinater (t.ex. Gällnö i skärgården för hela
 * "Stockholms Lån"), så vi slår upp mot denna tabell istället.
 *
 * Prioriteringsordning i lookupGPS():
 *   1. Exakt träff på location.name
 *   2. Stockholmsspecifik stadsdel hittad i summary-texten
 *   3. Delträff på location.name
 *   4. Polisens original-GPS (sista utväg)
 */
const SWEDEN_LOCATIONS = {
    // ── Alla 21 Lån ────────────────────────────────────────────────────────────
    'stockholms lån': '59.3293,18.0686',
    'stockholms lÄn': '59.3293,18.0686',
    'stockholm lån': '59.3293,18.0686',
    'uppsalas lån': '59.8594,17.6389',
    'södermanlands lån': '59.3666,16.5077',
    'östergötlands lån': '58.4109,15.6216',
    'jönköpings lån': '57.7826,14.1618',
    'kronobergs lån': '56.8777,14.8091',
    'kalmar lån': '56.6616,16.3562',
    'gotlands lån': '57.6348,18.2948',
    'blekinge lån': '56.1612,15.5869',
    'skåne lån': '55.6050,13.0038',
    'hallands lån': '56.6745,12.8577',
    'västra götalands lån': '57.7089,11.9746',
    'värmlands lån': '59.4022,13.5115',
    'örebro lån': '59.2741,15.2066',
    'västmanlands lån': '59.6099,16.5448',
    'dalarnas lån': '60.4858,15.4367',
    'gävleborgs lån': '60.6749,17.1413',
    'västernorrlands lån': '62.3913,17.3069',
    'jämtlands lån': '63.1792,14.6357',
    'västerbottens lån': '63.8258,20.2630',
    'norrbottens lån': '65.5848,22.1547',

    // ── Stockholms stadsdelar (sök också i summary-texten) ─────────────────────
    'södermalm': '59.3151,18.0717',
    'vasastan': '59.3445,18.0448',
    'kungsholmen': '59.3328,18.0276',
    'östermalm': '59.3390,18.0960',
    'norrmalm': '59.3354,18.0596',
    'djurgårdan': '59.3268,18.1198',
    'djurgården': '59.3268,18.1198',
    'lidingö': '59.3665,18.1576',
    'bromma': '59.3400,17.9538',
    'spånga': '59.3798,17.9049',
    'tensta': '59.3975,17.9096',
    'rinkeby': '59.3870,17.9280',
    'kista': '59.4038,17.9508',
    'akalla': '59.4227,17.9205',
    'husby': '59.4130,17.9387',
    'hjulsta': '59.3887,17.8793',
    'hässelby': '59.3626,17.8312',
    'vällingby': '59.3627,17.8713',
    'råcksta': '59.3617,17.8895',
    'blackeberg': '59.3450,17.8914',
    'ålsten': '59.3287,17.9193',
    'brommaplan': '59.3388,17.9338',
    'alvik': '59.3355,17.9610',
    'liljeholmen': '59.3105,18.0181',
    'midsommarkransen': '59.3070,18.0060',
    'älvsjö': '59.2822,18.0055',
    'rågsved': '59.2700,18.0266',
    'högdalen': '59.2755,18.0510',
    'farsta': '59.2447,18.0888',
    'skarpnäck': '59.2690,18.1325',
    'bagarmossen': '59.2779,18.1322',
    'hammarbyhöjden': '59.2955,18.1032',
    'gubbängen': '59.2660,18.0835',
    'enskede': '59.2787,18.0748',
    'johanneshov': '59.2990,18.0860',
    'hammarby sjöstad': '59.3046,18.1023',
    'gärdet': '59.3403,18.1044',
    'skeppsholmen': '59.3265,18.0838',
    'gamla stan': '59.3254,18.0710',
    'slussen': '59.3192,18.0718',
    'zinkensdamm': '59.3162,18.0563',
    'hornstull': '59.3140,18.0459',
    'skanstull': '59.3098,18.0679',
    'gullmarsplan': '59.3005,18.0714',
    'globen': '59.2930,18.0822',
    'nacka': '59.3157,18.1630',
    'tyresö': '59.2445,18.2288',
    'huddinge': '59.2357,17.9810',
    'botkyrka': '59.2090,17.8285',
    'södertälje': '59.1955,17.6253',
    'solna': '59.3601,18.0010',
    'sundbyberg': '59.3619,17.9712',
    'järfälla': '59.4280,17.8343',
    'upplands väsby': '59.5186,17.9136',
    'täby': '59.4439,18.0687',
    'danderyd': '59.4054,18.0327',
    'vallentuna': '59.5359,18.0766',
    'haninge': '59.1688,18.1427',
    'lidingö': '59.3665,18.1576',
    'ekerö': '59.2921,17.8099',
    'värmdö': '59.2875,18.4048',
    'österåker': '59.4773,18.3005',
    'norrtälje': '59.7584,18.7043',
    'nynäshamn': '58.9036,17.9476',
    'saltsjöbaden': '59.2955,18.2970',
    'vaxholm': '59.4018,18.3518',
    'sigtuna': '59.6168,17.7237',
    'stureplan': '59.3356,18.0703',
    'odenplan': '59.3432,18.0462',
    'fridhemsplan': '59.3320,18.0209',
    'hornsberg': '59.3355,18.0071',
    'lunda': '59.3751,17.8866',
    'hässelby gård': '59.3627,17.8460',
    'vällingby centrum': '59.3627,17.8713',
    'ulvsunda': '59.3516,17.9460',
    'traneberg': '59.3373,17.9714',
    'mariehäll': '59.3380,17.9530',
    'riksby': '59.3520,17.9290',
    'åkeshov': '59.3430,17.9195',
    'blackeberg': '59.3450,17.8914',
    'sätra': '59.2896,17.9367',
    'mälarhoijden': '59.2980,17.9740',
    'mälarhöjden': '59.2980,17.9740',
    'hägersten': '59.3029,17.9936',
    'fruängen': '59.2900,17.9700',
    'bredäng': '59.2994,17.9346',
    'vårberg': '59.2829,17.9161',
    'skärholmen': '59.2776,17.9023',
    'solberga': '59.2886,17.9941',
    'stureby': '59.2751,18.0173',
    'långbro': '59.2802,17.9827',
    'hägerstensåsen': '59.3065,17.9793',
    'aspudden': '59.3051,18.0040',
    'liljeholmskajen': '59.3085,18.0219',
    'årstadal': '59.3001,18.0377',
    'årstafältet': '59.2967,18.0462',
    'enskede gård': '59.2877,18.0604',
    'tallkrogen': '59.2670,18.0990',
    'skogskyrkogården': '59.2756,18.0599',
    'bandhagen': '59.2697,18.0469',
    'bjursätra': '59.2575,18.0615',
    'fagersjö': '59.2608,18.0213',
    'liseberg': '59.2824,17.9563',
    'hässelby strand': '59.3563,17.8117',
    'grimsta': '59.3585,17.8862',
    'södra hammarbyhamnen': '59.3046,18.1023',
    'hammarby': '59.3046,18.1023',
    'sickla': '59.2981,18.1380',
    'lövsta': '59.3673,17.8435',
    'granby': '59.3675,17.8498',
    'skärmarbrink': '59.3015,18.0820',
    'stadshagen': '59.3348,18.0177',
    'vasagatan': '59.3312,18.0590',
    'centralstationen': '59.3312,18.0590',
    'hornsgatan': '59.3179,18.0538',
    'sveavägen': '59.3397,18.0565',
    'karlaplan': '59.3402,18.1024',
    'valhallavägan': '59.3427,18.0953',
    'valhallavägen': '59.3427,18.0953',
    'birger jarlsgatan': '59.3351,18.0702',
    'drottninggatan': '59.3332,18.0647',
    'götgatan': '59.3171,18.0640',

    // ── Vanliga städer ─────────────────────────────────────────────────────────
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
    'karlstad': '59.4022,13.5115',
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
    'visby': '57.6348,18.2948',
    'härnösand': '62.6286,17.9353',
    'borlänge': '60.4856,15.4369',
    'trollhättan': '58.2837,12.2887',
    'uddevalla': '58.3490,11.9380',
    'varberg': '57.1056,12.2496',
    'nyköping': '58.7527,17.0093',
    'nässjö': '57.6541,14.6957',
    'ljungby': '56.8319,13.9381',
    'skövde': '58.3893,13.8456',
    'falköping': '58.1724,13.5507',
    'mariestad': '58.7097,13.8256',
    'lidköping': '58.5054,13.1575',
};

/**
 * Slår upp GPS-koordinat från platstabell.
 *
 * Steg:
 *  1. Exakt träff på locationName.
 *  2. Genomsök summary-texten efter kända platser (viktigt för "Stockholms Lån").
 *  3. Delträff på locationName.
 *  4. Polisens originalkoordinat (sista utväg).
 *
 * Lägger till en liten deterministisk offset (baserad på incident-id) för att
 * undvika att hundratals markörer staplas exakt ovanpå varandra i kartan.
 */
function lookupGPS(locationName, originalGPS, summary = '', incidentId = 0) {
    const key = locationName ? locationName.toLowerCase().trim() : '';
    const isCountyLevel = key.includes('lån') || key.includes('lan') || key.includes('lä');
    let coords = null;

    // 1. Om platsen är ett lån (t.ex. "Stockholms Lån"), försök hitta stadsdel i summary-texten FÖRST
    //    Det ger mycket bättre precision (Södermalm, Vasastan etc.) än bara länets centrum.
    if (summary && isCountyLevel) {
        const summaryLower = summary.toLowerCase();
        const sortedKeys = Object.keys(SWEDEN_LOCATIONS).sort((a, b) => b.length - a.length);
        for (const k of sortedKeys) {
            if (k.includes('lån') || k.includes('lan') || k.includes('lä')) continue;
            if (k === 'stockholm') continue; // för generell
            if (summaryLower.includes(k)) {
                coords = SWEDEN_LOCATIONS[k];
                break;
            }
        }
    }

    // 2. Exakt träff på location.name (används om summary-sökning misslyckades)
    if (!coords && key && SWEDEN_LOCATIONS[key]) {
        coords = SWEDEN_LOCATIONS[key];
    }

    // 3. Sök i summary-texten för icke-lånplatser (t.ex. "Stockholm" utan lån)
    if (!coords && summary && !isCountyLevel) {
        const summaryLower = summary.toLowerCase();
        const sortedKeys = Object.keys(SWEDEN_LOCATIONS).sort((a, b) => b.length - a.length);
        for (const k of sortedKeys) {
            if (k.includes('lån') || k.includes('lan') || k.includes('lä')) continue;
            if (k === 'stockholm') continue;
            if (summaryLower.includes(k)) {
                coords = SWEDEN_LOCATIONS[k];
                break;
            }
        }
    }

    // 3. Delträff på locationName
    if (!coords && key) {
        for (const [k, v] of Object.entries(SWEDEN_LOCATIONS)) {
            if (key.includes(k) || k.includes(key)) {
                coords = v;
                break;
            }
        }
    }

    // 4. Sista utväg: polisens original-GPS
    if (!coords) return originalGPS;

    // Liten deterministisk offset (±0.002° ≈ 200m) baserad på incident-id
    // Gör att markörer på samma plats sprids ut i kartan istället för att staplas
    const idNum = parseInt(String(incidentId).replace(/\D/g, ''), 10) || 0;
    const latOffset = ((idNum % 19) - 9) * 0.00022;   // -0.00198 … +0.00198
    const lngOffset = ((idNum % 23) - 11) * 0.00032;  // -0.00352 … +0.00352
    const [lat, lng] = coords.split(',').map(Number);
    return `${(lat + latOffset).toFixed(6)},${(lng + lngOffset).toFixed(6)}`;
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

        // Slå upp GPS — prioritera vår tabell med stadsdels-precision
        // Skickar med summary-text och id för att kunna söka efter stadsdelar
        const exactGps = lookupGPS(
            event.location ? event.location.name : null,
            event.location ? event.location.gps : null,
            event.summary || '',
            event.id || 0
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
