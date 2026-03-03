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

    // ── Polisens API-format: "Norrbottens län" (ä) ─────────────────────────────
    // Polisens API returnerar "X län" (med ä), vår tabell använder "X lån" (å).
    // Båda varianter behövs för att lookupGPS ska matcha oavsett källa.
    'stockholms län': '59.3293,18.0686',
    'stockholm lån': '59.3293,18.0686',
    'stockholm län': '59.3293,18.0686',
    'uppsala län': '59.8594,17.6389',
    'södermanlands län': '59.3666,16.5077',
    'östergötlands län': '58.4109,15.6216',
    'jönköpings län': '57.7826,14.1618',
    'kronobergs län': '56.8777,14.8091',
    'kalmar län': '56.6616,16.3562',
    'gotlands län': '57.6348,18.2948',
    'blekinge län': '56.1612,15.5869',
    'skåne län': '55.6050,13.0038',
    'hallands län': '56.6745,12.8577',
    'västra götalands län': '57.7089,11.9746',
    'värmlands län': '59.4022,13.5115',
    'örebro län': '59.2741,15.2066',
    'västmanlands län': '59.6099,16.5448',
    'dalarnas län': '60.4858,15.4367',
    'gävleborgs län': '60.6749,17.1413',
    'västernorrlands län': '62.3913,17.3069',
    'jämtlands län': '63.1792,14.6357',
    'västerbottens län': '63.8258,20.2630',
    'norrbottens län': '65.5848,22.1547',


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

    // ── Vanliga städer (fallback om ingen stadsdel träffar) ────────────────────
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
    'motala': '58.5383,15.0408',
    'mjölby': '58.3264,15.1302',
    'ystad': '55.4290,13.8201',
    'landskrona': '55.8707,12.8301',
    'ängelholm': '56.2424,12.8622',
    'lund': '55.7047,13.1910',
    'trelleborg': '55.3753,13.1569',
    'hässleholm': '56.1586,13.7652',
    'piteå': '65.3172,21.4791',
    'boden': '65.8255,21.6888',
    'kiruna': '67.8558,20.2253',
    'gällivare': '67.1335,20.6573',
    'haparanda': '65.8356,24.1361',
    'kalix': '65.8540,23.1498',
    'örnsköldsvik': '63.2905,18.7157',
    'kramfors': '62.9308,17.7947',
    'sollefteå': '63.1630,17.2716',
    'timrå': '62.4926,17.3208',
    'kungsbacka': '57.4894,12.0762',
    'kungälv': '57.8712,11.9757',
    'mölndal': '57.6561,12.0131',
    'partille': '57.7392,12.1059',
    'lerum': '57.7706,12.2687',
    'alingsås': '57.9305,12.5337',
    'stenungsund': '58.0715,11.8207',
    'kungshamn': '58.3630,11.2479',
    'strömstad': '58.9346,11.1724',
    'lysekil': '58.2764,11.4367',
    'herrljunga': '58.0784,13.0280',
    'tibro': '58.4228,14.1620',
    'karlsborg': '58.5334,14.5081',
    'hjo': '58.3005,14.2939',
    'tibro': '58.4228,14.1620',
    'töreboda': '58.7012,14.1167',
    'tidaholm': '58.1780,13.9548',
    'mullsjö': '57.9195,13.8797',
    'vaggeryd': '57.4978,14.1433',
    'vetlanda': '57.4274,15.0794',
    'tranås': '58.0378,14.9821',
    'eksjö': '57.6660,14.9671',

    // ── Göteborg stadsdelar ────────────────────────────────────────────────────
    'hisingen': '57.7311,11.9268',
    'majorna': '57.6939,11.9282',
    'linnéstaden': '57.6994,11.9461',
    'örgryte': '57.6983,12.0165',
    'härlanda': '57.7071,12.0302',
    'kortedala': '57.7371,12.0566',
    'bergsjön': '57.7440,12.0802',
    'angered': '57.7851,12.0393',
    'frölunda': '57.6506,11.9254',
    'tynnered': '57.6416,11.9207',
    'biskopsgården': '57.7202,11.8854',
    'lundby': '57.7180,11.9374',
    'backa': '57.7458,11.9538',
    'tuve': '57.7582,11.9083',
    'säve': '57.7741,11.8797',
    'kärra': '57.7739,11.9999',
    'bergum': '57.8078,12.0600',
    'askim': '57.6224,11.9679',
    'västra frölunda': '57.6457,11.9099',
    'högsbo': '57.6646,11.9227',
    'johanneberg': '57.6871,11.9822',
    'annedal': '57.7024,11.9492',
    'masthugget': '57.6994,11.9367',
    'haga': '57.7027,11.9570',
    'nordstaden': '57.7074,11.9657',
    'lorensberg': '57.6946,11.9843',
    'landala': '57.6906,11.9750',
    'stampen': '57.7090,12.0013',
    'gårda': '57.7063,12.0067',
    'olskroken': '57.7147,12.0107',
    'kviberg': '57.7226,12.0413',
    'utby': '57.7349,12.0568',
    'gamlestaden': '57.7256,12.0137',
    'sävenäs': '57.7130,12.0381',
    'krokslätt': '57.6775,11.9881',
    'molndal': '57.6561,12.0131',
    'mölnlycke': '57.6566,12.1131',
    'partille': '57.7392,12.1059',
    'öckerö': '57.7106,11.6516',

    // ── Malmö stadsdelar ───────────────────────────────────────────────────────
    'rosengård': '55.5868,13.0432',
    'husie': '55.5704,13.0914',
    'kirseberg': '55.6026,13.0410',
    'limhamn': '55.5726,12.9332',
    'oxie': '55.5347,13.0730',
    'hyllie': '55.5510,12.9910',
    'fosie': '55.5684,13.0239',
    'segevång': '55.5972,13.0622',
    'husie': '55.5704,13.0914',
    'södra innerstaden': '55.5990,13.0120',
    'västra innerstaden': '55.6046,13.0067',
    'centrum malmö': '55.6050,13.0038',
    'triangeln': '55.5972,13.0036',
    'möllevången': '55.5931,13.0136',
    'nobeltorget': '55.5985,12.9975',
    'castellum': '55.6159,13.0234',
    'husiegård': '55.5649,13.1043',
    'holma': '55.5698,12.9759',
    'kroksbäck': '55.5627,13.0028',
    'gullviksborg': '55.6139,12.9966',
    'husievång': '55.5658,13.1229',
    'bunkeflostrand': '55.5265,12.9352',
    'husie': '55.5704,13.0914',
    'lindängen': '55.5507,13.0136',
    'sofielund': '55.5917,13.0163',
    'kungsbacka malmö': '55.5770,12.9754',
    'husie': '55.5704,13.0914',
    'tygelsjö': '55.5108,13.0250',
    'hyllie station': '55.5510,12.9910',
    'bellevue': '55.6097,13.0291',
    'oxie socken': '55.5347,13.0730',
    'husie kyrka': '55.5704,13.0914',

    // ── Uppsala stadsdelar ─────────────────────────────────────────────────────
    'luthagen': '59.8687,17.6089',
    'svartbäcken': '59.8759,17.6371',
    'kungsängen': '59.8528,17.6311',
    'salabacke': '59.8633,17.6802',
    'gottsunda': '59.8346,17.6016',
    'sunnersta': '59.8109,17.6297',
    'ultuna': '59.8196,17.6558',
    'berthåga': '59.8833,17.6671',
    'gränby': '59.8870,17.6706',
    'storvreta': '59.9685,17.7013',
    'valsätra': '59.8341,17.6310',
    'stenhagen': '59.8453,17.5872',
    'åkby': '59.8269,17.7082',
    'fyristorg': '59.8575,17.6387',
    'dragarbrunn': '59.8637,17.6283',
    'flogsta': '59.8545,17.5855',
    'sala backe': '59.8633,17.6802',
    'eriksberg': '59.8744,17.6003',
    'täljaren': '59.8750,17.6480',
    'linnéas': '59.8623,17.6490',

    // ── Örebro stadsdelar ──────────────────────────────────────────────────────
    'adolfsberg': '59.2994,15.1762',
    'brickebacken': '59.2712,15.1571',
    'baronbackarna': '59.2682,15.1854',
    'varberga': '59.2633,15.2133',
    'oxhagen': '59.2800,15.1898',
    'hagaby': '59.2551,15.2262',
    'lundby örebro': '59.2650,15.2550',
    'sörbyängen': '59.2491,15.2198',
    'vivalla': '59.3009,15.1572',
    'hovsta': '59.3289,15.1393',
    'rosta': '59.2595,15.2468',
    'eklunda': '59.3110,15.2419',
    'mellringe': '59.3311,15.2108',
    'täby örebro': '59.2957,15.2680',
    'norrbyås': '59.3479,15.1640',
    'kransen': '59.2852,15.2289',
    'garphyttan': '59.3041,14.9285',

    // ── Västerås stadsdelar ────────────────────────────────────────────────────
    'bäckby': '59.6185,16.5028',
    'brandthovda': '59.5970,16.4813',
    'erikslund': '59.5894,16.5809',
    'hammarby': '59.6279,16.5597',
    'haga västerås': '59.6216,16.5234',
    'hälla': '59.6039,16.5224',
    'önsta': '59.6423,16.4768',
    'råby': '59.6139,16.5701',
    'viksäng': '59.5993,16.5501',
    'gryta västerås': '59.5805,16.5317',
    'malmaberg': '59.6003,16.5166',

    // ── Norrköping stadsdelar ──────────────────────────────────────────────────
    'kneippen': '58.5878,16.1809',
    'butängen': '58.5778,16.1884',
    'hageby': '58.5646,16.1770',
    'marielund': '58.5759,16.2108',
    'berget': '58.5957,16.2076',
    'lindö': '58.6037,16.2315',
    'vilbergen': '58.5610,16.2146',
    'eneby': '58.5520,16.1660',
    'borg': '58.5320,16.1808',
    'skarphagen': '58.5882,16.2369',
    'åby': '58.5393,16.1453',
    'kimstad': '58.5250,15.9850',

    // ── Linköping stadsdelar ────────────────────────────────────────────────────
    'ryd': '58.4230,15.5802',
    'tornby': '58.4413,15.5710',
    'lambohov': '58.3967,15.5668',
    'ekholmen': '58.3862,15.6138',
    'berga linköping': '58.3956,15.5980',
    'skäggetorp': '58.4378,15.5891',
    'vasastaden linköping': '58.4183,15.6221',
    'hackefors': '58.4022,15.5338',
    'johannelund': '58.4017,15.6428',
    'hjulsbro': '58.3762,15.6052',

    // ── Umeå stadsdelar ────────────────────────────────────────────────────────
    'röbäck': '63.7943,20.2127',
    'ålidhem': '63.8218,20.3020',
    'carlshem': '63.8334,20.2753',
    'tomtebo': '63.8116,20.2890',
    'mariehem': '63.8360,20.3278',
    'böleäng': '63.8264,20.2321',
    'haga umeå': '63.8357,20.2510',
    'ersmark': '63.8654,20.4045',
    'teg': '63.8100,20.2745',
    'sandbacka': '63.8498,20.2283',
    'sörmjöle': '63.7551,20.1875',
    'innertavle': '63.7937,20.0695',
    'bullmark': '63.9127,20.7145',
    'hörnefors': '63.6176,19.9023',
    'nordmaling': '63.5766,19.5028',

    // ── Luleå stadsdelar ───────────────────────────────────────────────────────
    'gammelstad': '65.6433,22.0171',
    'bergnäset': '65.5651,22.1278',
    'örnäset': '65.5814,22.1778',
    'porsön': '65.6136,22.1358',
    'råneå': '65.8590,22.2866',
    'hertsön': '65.5716,22.2003',
    'björkskatan': '65.5596,22.1894',
    'kronan luleå': '65.5849,22.1671',
    'mjölkudden': '65.5730,22.1486',
    'gültzauudden': '65.5872,22.1344',
    'notviken': '65.6001,22.0867',
    'råneå': '65.8590,22.2866',
    'vittjärv': '65.8059,21.9622',

    // ── Härnösand & Västernorrland ─────────────────────────────────────────────
    'bjästa': '63.1991,18.5192',
    'kramfors': '62.9308,17.7947',
    'sollefteå': '63.1630,17.2716',
    'timrå': '62.4926,17.3208',
    'alnö': '62.4194,17.4392',
    'bosvedjan': '62.4066,17.3508',
    'fagervik': '62.3942,17.3298',
    'kvissleby': '62.3562,17.3775',
    'matfors': '62.3469,17.0199',
    'tuna': '62.3813,17.2967',

    // ── Sundsvall stadsdelar ────────────────────────────────────────────────────
    'birsta': '62.4318,17.2748',
    'njurundabommen': '62.2799,17.3741',
    'kovland': '62.5018,17.6016',
    'skönsmon': '62.4202,17.3282',
    'södermalm sundsvall': '62.3811,17.3086',
    'norrmalm sundsvall': '62.3933,17.3161',
    'selånger': '62.4500,17.2175',

    // ── Östersund stadsdelar ────────────────────────────────────────────────────
    'torvalla': '63.1487,14.6819',
    'brunflo': '63.0663,14.8029',
    'lit': '63.3155,14.8695',
    'optand': '63.2239,14.5620',
    'frösön': '63.1867,14.5354',
    'lugnvik': '63.1803,14.6751',
    'lugnvik': '63.1803,14.6751',
    'odenskog': '63.2019,14.7131',
    'odensala': '63.1656,14.5854',
    'remonthagen': '63.1830,14.6534',
    'söder östersund': '63.1708,14.6359',

    // ── Gävle stadsdelar ────────────────────────────────────────────────────────
    'sätra gävle': '60.6577,17.1154',
    'andersberg': '60.6468,17.1504',
    'hemlingby': '60.7013,17.2118',
    'stigslund': '60.6666,17.1616',
    'söder gävle': '60.6665,17.1378',
    'brynäs': '60.6760,17.1497',
    'bomhus': '60.6952,17.2085',
    'strömsbro': '60.7073,17.1538',
    'valbo': '60.7312,17.0938',
    'hille': '60.7667,17.0875',
    'sandviken': '60.6209,16.7756',
    'hofors': '60.5456,16.2788',

    // ── Skåne (utöver Malmö) ───────────────────────────────────────────────────
    'husie': '55.5704,13.0914',
    'bjästa malmö': '63.1991,18.5192',
    'hjärup': '55.5028,13.1148',
    'staffanstorp': '55.6409,13.2091',
    'burlöv': '55.6277,13.1013',
    'vellinge': '55.4702,12.9648',
    'svedala': '55.5067,13.2353',
    'skurup': '55.4784,13.5017',
    'sjöbo': '55.6268,13.7206',
    'eslöv': '55.8378,13.3036',
    'höör': '55.9419,13.5438',
    'klippan': '56.1321,13.1299',
    'bjuv': '56.0836,12.9211',
    'åstorp': '56.1352,12.9486',
    'perstorp': '56.1371,13.3970',
    'örkelljunga': '56.2829,13.2825',
    'markaryd': '56.4631,13.5979',
    'osby': '56.3770,13.9933',
    'hässleholm': '56.1586,13.7652',
    'tomelilla': '55.5441,13.9574',
    'simrishamn': '55.5571,14.3583',
    'bromölla': '56.0793,14.4685',
    'mjällby': '56.1009,14.6605',
    'sölvesborg': '56.0516,14.5836',
    'ronneby': '56.2092,15.2739',
    'karlshamn': '56.1714,14.8614',
    'olofström': '56.2793,14.5312',

    // ── Västra Götaland (utöver Göteborg) ──────────────────────────────────────
    'fristaden': '57.7219,12.9323',
    'norrby borås': '57.7326,12.9285',
    'hässleholmen': '57.7170,12.9205',
    'torpavallen': '57.7437,12.9602',
    'viared': '57.7131,12.9727',
    'fristad': '57.8179,12.9290',
    'viskafors': '57.6819,12.8546',
    'kinna': '57.5029,12.6881',
    'skene': '57.4954,12.6475',
    'marks': '57.5280,12.6826',
    'herrljunga': '58.0784,13.0280',
    'vårgårda': '58.0383,12.8023',
    'grästorp': '58.3217,12.6749',
    'götene': '58.5284,13.4858',
    'skara': '58.3872,13.4406',
    'tibro': '58.4228,14.1620',
    'hjo': '58.3005,14.2939',
    'tidaholm': '58.1780,13.9548',
    'mullsjö': '57.9195,13.8797',
    'tranemo': '57.4870,13.3504',
    'ulricehamn': '57.7924,13.4228',
    'svenljunga': '57.4868,13.1082',
    'borås centrum': '57.7210,12.9401',
    'allegatan': '57.7220,12.9423',
    'åbo': '57.7130,12.9186',
    'ramnaparken': '57.7346,12.9422',
    'sandared': '57.7022,12.9028',

    // ── Jämtland & fjäll ───────────────────────────────────────────────────────
    'åre': '63.3987,13.0799',
    'duved': '63.3940,12.9269',
    'undersåker': '63.3799,13.2418',
    'järpen': '63.3463,13.4608',
    'bräcke': '62.7447,15.4275',
    'kälarne': '62.8474,16.2462',
    'strömsund': '63.8512,15.5528',
    'hammerdal': '63.5648,15.3613',
    'hoting': '63.9029,16.2211',
    'gällö': '62.9850,15.2700',
    'krokom': '63.3187,14.4604',
    'ragunda': '63.1094,16.3876',
    'borgvattnet': '63.4253,15.9573',
    'stugun': '63.0810,16.1093',
    'svenstavik': '62.9016,14.4145',
    'hede': '62.3944,13.5133',
    'funäsdalen': '62.5329,12.5308',
    'vemdalen': '62.4538,13.8724',

    // ── Norrbotten & Västerbotten (förutom Luleå/Umeå/Skellefteå) ─────────────
    'arjeplog': '66.0533,17.8816',
    'arvidsjaur': '65.5885,19.1779',
    'jokkmokk': '66.6043,19.8310',
    'pajala': '67.2121,23.3629',
    'älvsbyn': '65.6771,21.0048',
    'överkalix': '66.3284,22.8360',
    'övertorneå': '66.3858,23.6611',
    'gällivare': '67.1335,20.6573',
    'malmberget': '67.1778,20.6591',
    'kiruna': '67.8558,20.2253',
    'abisko': '68.3508,18.8301',
    'vittangi': '67.6706,21.6438',
    'karesuando': '68.4472,22.4889',
    'tärendö': '67.1570,22.6432',
    'korpilombolo': '66.9706,23.5503',
    'vuollerim': '66.4285,20.6009',
    'norrfjärden': '65.4390,21.5552',
    'sunderby': '65.6100,22.0100',
    'antnäs': '65.5345,21.8963',
    'klöverträsk': '65.5400,20.4167',
    'burträsk': '64.5230,20.6651',
    'byske': '64.9587,21.2101',
    'boliden': '64.8756,20.3779',
    'bureå': '64.6093,21.2164',
    'jörn': '65.0502,19.8580',
    'vindeln': '64.2009,19.7177',
    'vännäs': '63.9128,19.7554',
    'robertsfors': '64.1869,20.8527',
    'lycksele': '64.5966,18.6707',
    'storuman': '65.0917,17.1063',
    'sorsele': '65.5340,17.5339',
    'dorotea': '64.2586,16.3890',
    'vilhelmina': '64.6233,16.6630',
    'åsele': '64.1609,17.3510',
    'fredrika': '63.9971,18.0700',
    'bjurholm': '63.9372,19.2526',
    'nordmaling': '63.5766,19.5028',
    'örnsköldsvik': '63.2905,18.7157',
    'husum': '63.3400,18.9700',
    'kramfors': '62.9308,17.7947',
    'härnösand': '62.6286,17.9353',
    'söråker': '62.4981,17.4976',
    'sundsvall centrum': '62.3909,17.3069',

    // ── Dalarna & Gävleborg ────────────────────────────────────────────────────
    'mora': '61.0047,14.5373',
    'orsa': '61.1202,14.6153',
    'älvdalen': '61.2315,14.0369',
    'malung': '60.6870,13.7222',
    'sälen': '61.1630,13.2611',
    'leksand': '60.7315,14.9982',
    'rättvik': '60.8871,15.1138',
    'ludvika': '60.1455,15.1868',
    'smedjebacken': '60.1370,15.4118',
    'säter': '60.3476,15.7533',
    'hedemora': '60.2765,15.9934',
    'avesta': '60.1426,16.1657',
    'krylbo': '60.1127,16.2354',
    'hofors': '60.5456,16.2788',
    'ockelbo': '60.8910,16.7260',
    'söderhamn': '61.2987,17.0556',
    'hudiksvall': '61.7280,17.1000',
    'ljusdal': '61.8298,16.0974',
    'bollnäs': '61.3474,16.3948',
    'ovanåker': '61.3472,16.0019',
    'edsbyn': '61.3825,15.8019',
    'alfta': '61.3432,15.8614',
    'arbrå': '61.4440,16.3980',

    // ── Värmland ───────────────────────────────────────────────────────────────
    'hagfors': '60.0259,13.6499',
    'munkfors': '59.8367,13.5510',
    'torsby': '60.1383,12.9990',
    'sunne': '59.8374,13.1462',
    'kristinehamn': '59.3094,14.1089',
    'filipstad': '59.7121,14.1673',
    'storfors': '59.5336,14.2656',
    'degerfors': '59.2341,14.4315',
    'grums': '59.2636,13.0932',
    'säffle': '59.1325,12.9256',
    'åmål': '58.9975,12.7017',
    'arvika': '59.6530,12.5877',
    'eda': '59.7500,12.2900',
    'charlottenberg': '59.8846,12.2876',
    'kil': '59.4998,13.3248',
    'forshaga': '59.5310,13.4739',
    'hammarö': '59.3328,13.5191',

    // ── Halland ────────────────────────────────────────────────────────────────
    'falkenberg': '56.9068,12.4905',
    'varberg': '57.1056,12.2497',
    'kungsbacka': '57.4894,12.0762',
    'laholm': '56.5162,13.0497',
    'båstad': '56.4277,12.8513',
    'knäred': '56.5382,13.3277',
    'mellbystrand': '56.5077,12.9327',
    'skrea': '56.8831,12.4813',
    'lövstad falkenberg': '56.8949,12.5007',
    'ullared': '57.1241,12.7133',
    'vinberg': '56.8499,12.7041',
    'tvåaker': '57.0451,12.4020',

    // ── Södermanland ───────────────────────────────────────────────────────────
    'strängnäs': '59.3779,17.0295',
    'katrineholm': '58.9956,16.2085',
    'flen': '59.0600,16.5875',
    'vingåker': '59.0600,15.8700',
    'oxelösund': '58.6668,17.1052',
    'trosa': '58.8959,17.5466',
    'gnesta': '59.0467,17.3186',
    'en körsdalen': '59.3560,17.0410',

    // ── Östergötland (utöver Linköping/Norrköping) ─────────────────────────────
    'mjölby': '58.3264,15.1302',
    'motala': '58.5383,15.0408',
    'vadstena': '58.4485,14.8876',
    'kinda': '57.9919,15.6411',
    'ydre': '57.8416,15.2436',
    'åtvidaberg': '58.2019,16.0095',
    'valdemarsvik': '58.2122,16.5896',
    'söderköping': '58.4787,16.3223',
    'finspång': '58.7055,15.7696',
    'norsholm': '58.5168,15.9519',
    'åby norrköping': '58.5393,16.1453',

    // ── Jönköping stadsdelar & orter ───────────────────────────────────────────
    'huskvarna': '57.7887,14.2695',
    'norrahammar': '57.7375,14.1054',
    'bankeryd': '57.8495,14.1286',
    'taberg': '57.6918,14.0805',
    'barnarp': '57.7629,14.1867',
    'vaggeryd': '57.4978,14.1433',
    'skillingaryd': '57.4372,14.0829',
    'värnamo': '57.1839,14.0433',
    'gislaved': '57.3024,13.5396',
    'anderstorp': '57.2667,13.6380',
    'habo': '57.9074,14.0888',
    'mullsjö': '57.9195,13.8797',
    'sävsjö': '57.4036,14.6738',
    'västervik': '57.7573,16.6349',
    'vimmerby': '57.6646,15.8578',
    'hultsfred': '57.4895,15.8441',
    'eksjö': '57.6660,14.9671',
    'tranås': '58.0378,14.9821',
    'aneby': '57.8342,14.8156',
    'nässjö': '57.6541,14.6957',
};

/**
 * Geografiska bounding boxes för varje lån [minLat, maxLat, minLng, maxLng].
 * Används när vi inte kan hitta en specifik ort — sprider incidenten
 * deterministiskt inom hela länet istället för att stapla allt på en punkt.
 */
const COUNTY_BOUNDS = {
    'stockholms': [58.89, 59.84, 17.32, 18.94],
    'uppsalas': [59.52, 60.65, 16.48, 18.56],
    'södermanlands': [58.64, 59.47, 15.84, 17.62],
    'östergötlands': [57.72, 59.06, 14.39, 16.85],
    'jönköpings': [56.86, 58.15, 12.95, 15.70],
    'kronobergs': [56.23, 57.62, 13.26, 15.45],
    'kalmar': [56.06, 57.91, 15.37, 16.90],
    'gotlands': [56.93, 57.98, 18.05, 19.33],
    'blekinge': [55.90, 56.47, 14.26, 15.87],
    'skåne': [55.20, 56.45, 12.43, 14.57],
    'hallands': [56.28, 57.57, 11.97, 13.60],
    'västra götalands': [57.10, 59.13, 10.96, 14.49],
    'värmlands': [58.81, 61.05, 11.78, 14.64],
    'örebro': [58.76, 60.11, 14.14, 15.61],
    'västmanlands': [59.24, 60.28, 15.57, 16.97],
    'dalarnas': [59.71, 62.16, 12.08, 16.76],
    'gävleborgs': [60.35, 62.43, 14.86, 18.23],
    'västernorrlands': [62.05, 64.11, 15.71, 19.12],
    'jämtlands': [61.68, 65.07, 11.81, 18.18],
    'västerbottens': [63.30, 66.14, 14.05, 21.63],
    'norrbottens': [65.22, 69.06, 17.08, 24.17],
};

/**
 * Returnerar en deterministisk punkt inom ett låns bounding box.
 * Används för incidenter vi bara vet är "i Norrbotten" o.s.v.
 */
function spreadWithinCounty(countyKey, incidentId) {
    const id = parseInt(String(incidentId).replace(/\D/g, ''), 10) || 0;
    for (const [k, bounds] of Object.entries(COUNTY_BOUNDS)) {
        if (countyKey.includes(k)) {
            const [minLat, maxLat, minLng, maxLng] = bounds;
            // Deterministisk pseudo-slump via Knuth-hash av incident-id
            const latFrac = ((id * 2654435761) >>> 0) % 10000 / 10000;
            const lngFrac = ((id * 2246822519) >>> 0) % 10000 / 10000;
            const lat = minLat + latFrac * (maxLat - minLat);
            const lng = minLng + lngFrac * (maxLng - minLng);
            return `${lat.toFixed(6)},${lng.toFixed(6)}`;
        }
    }
    return null;
}

/**
 * Slår upp GPS-koordinat från platstabell.
 *
 * Steg:
 *  1. Lånplatser: sök specifik ort i summary-texten (stadsdels-precision)
 *  2. Exakt träff på location.name
 *  3. Sök i summary för icke-lånplatser
 *  4. Delträff på location.name
 *  5. Lån-fallback: sprid INOM hela länet via bounding box (inga spiderfy-högar!)
 *  6. Polisens original-GPS (sista utväg)
 */
function lookupGPS(locationName, originalGPS, summary = '', incidentId = 0) {
    const key = locationName ? locationName.toLowerCase().trim() : '';
    const isCountyLevel = key.includes('lån') || key.includes('lan') || key.includes('lä');
    let coords = null;
    let specificMatch = false;

    // 1. Lånplatser: sök specifik ort i summary-texten FÖRST
    //    Ger stadsdels-/ortsnivå precision (Södermalm, Röbäck, Angered etc.)
    if (summary && isCountyLevel) {
        const summaryLower = summary.toLowerCase();
        const sortedKeys = Object.keys(SWEDEN_LOCATIONS).sort((a, b) => b.length - a.length);
        for (const k of sortedKeys) {
            if (k.includes('lån') || k.includes('lan') || k.includes('lä')) continue;
            if (k === 'stockholm') continue;
            if (summaryLower.includes(k)) {
                coords = SWEDEN_LOCATIONS[k];
                specificMatch = true;
                break;
            }
        }
    }

    // 2. Exakt träff på location.name
    if (!coords && key && SWEDEN_LOCATIONS[key]) {
        coords = SWEDEN_LOCATIONS[key];
        specificMatch = !isCountyLevel;
    }

    // 3. Sök i summary för icke-lånplatser
    if (!coords && summary && !isCountyLevel) {
        const summaryLower = summary.toLowerCase();
        const sortedKeys = Object.keys(SWEDEN_LOCATIONS).sort((a, b) => b.length - a.length);
        for (const k of sortedKeys) {
            if (k.includes('lån') || k.includes('lan') || k.includes('lä')) continue;
            if (k === 'stockholm') continue;
            if (summaryLower.includes(k)) {
                coords = SWEDEN_LOCATIONS[k];
                specificMatch = true;
                break;
            }
        }
    }

    // 4. Delträff på location.name
    if (!coords && key) {
        for (const [k, v] of Object.entries(SWEDEN_LOCATIONS)) {
            if (key.includes(k) || k.includes(key)) {
                coords = v;
                specificMatch = !isCountyLevel;
                break;
            }
        }
    }

    // 5. Sista utväg: polisens original-GPS
    if (!coords) return originalGPS;

    // Beräkna offset baserat på incident-id
    const idNum = parseInt(String(incidentId).replace(/\D/g, ''), 10) || 0;

    if (specificMatch) {
        // Specifik ort hittad → liten offset (±300m) för att undvika exakt stacking
        const latOffset = ((idNum % 29) - 14) * 0.00030;
        const lngOffset = ((idNum % 31) - 15) * 0.00045;
        const [lat, lng] = coords.split(',').map(Number);
        return `${(lat + latOffset).toFixed(6)},${(lng + lngOffset).toFixed(6)}`;
    } else {
        // County-center fallback → måttlig offset (±8km) så markörer inte
        // staplas på exakt samma pixel, men stannar nära centralorten
        const latOffset = ((idNum % 71) - 35) * 0.0011;   // ≈ ±3.8° / 10 ≈ ±8km
        const lngOffset = ((idNum % 79) - 39) * 0.0016;
        const [lat, lng] = coords.split(',').map(Number);
        return `${(lat + latOffset).toFixed(6)},${(lng + lngOffset).toFixed(6)}`;
    }
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
        snapshot.forEach(doc => {
            const data = doc.data();
            // Re-tillämpa lookupGPS on-the-fly så att gamla Firestore-poster
            // med felaktiga county-GPS (t.ex. Gällivare-fjällen) rättas till
            // korrekt koordinat innan de skickas till frontend.
            if (data.location && data.location.name) {
                const correctedGps = lookupGPS(
                    data.location.name,
                    data.location.gps,
                    data.summary || '',
                    data.id || 0
                );
                data.location = { ...data.location, gps: correctedGps };
            }
            results.push(data);
        });
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
