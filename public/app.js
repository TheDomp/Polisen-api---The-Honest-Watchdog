/* ============================================
   THE HONEST WATCHDOG — Frontend Logic (SPA)
   ============================================ */

const API_BASE = 'https://polisen-api-the-honest-watchdog.onrender.com';

let allIncidents = [];
let qaLogs = [];
let currentFilter = 'all';
let currentPage = 'dashboard';

// Maps
let miniMap = null, fullMap = null;
let miniMarkers = null, fullMarkers = null;
let mapFilter = 'all';

// QA Lab — keep test injections separate from real data
let qaTestResults = [];

// ─── INIT ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setupRouter();
    fetchPoliceData();
});

// ─── SPA ROUTER ─────────────────────────────
function setupRouter() {
    window.addEventListener('hashchange', handleRoute);
    handleRoute();
}

function handleRoute() {
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    navigateTo(hash, false);
}

function navigateTo(page, updateHash = true) {
    currentPage = page;
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.page === page);
    });
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    const target = document.getElementById(`page-${page}`);
    if (target) target.classList.remove('hidden');
    if (updateHash) window.location.hash = page;

    if (page === 'karta') setTimeout(() => initFullMap(), 100);
    if (page === 'statistik') {
        setTimeout(() => { updateCrimeTypes(); updateTimePattern(); updateRegions(); }, 100);
    }
}

// ─── PARSE DATETIME ─────────────────────────
function parsePoliceDate(str) {
    if (!str) return null;
    const fixed = str.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-]\d{2}):(\d{2})$/, (_, d, h, m, s, oh, om) => `${d}T${h.padStart(2, '0')}:${m}:${s}${oh}:${om}`);
    const d = new Date(fixed);
    return isNaN(d.getTime()) ? null : d;
}

// ─── FETCH POLICE DATA ─────────────────────
async function fetchPoliceData() {
    addQALog('info', 'Hämtar data från Databasen...');
    try {
        const res = await fetch(`${API_BASE}/api/incidents`);
        const data = await res.json();
        allIncidents = Array.isArray(data) ? data : (data.incidents || []);

        addQALog('info', `Hämtade ${allIncidents.length} incidenter från databasen`);
        addQALog('info', `Laddar backend-validerade resultat...`);

        let flaggedCount = 0, verifiedCount = 0;
        allIncidents.forEach((inc, i) => {
            if (inc.qa_integrity && inc.qa_integrity.isLowConfidence) {
                flaggedCount++;
                if (flaggedCount <= 5) {
                    setTimeout(() => {
                        addQALog('flagged', `#${inc.id || i} flaggad: ${inc.qa_integrity.reasons[0] || 'Låg integritet'}`);
                    }, 200 + i * 30);
                }
            } else {
                verifiedCount++;
                if (verifiedCount <= 3) {
                    setTimeout(() => {
                        addQALog('verified', `#${inc.id || i} verifierad: ${inc.qa_integrity ? inc.qa_integrity.score : 0}/100`);
                    }, 200 + i * 30);
                }
            }
        });

        setTimeout(() => {
            addQALog('info', `Laddning klar: ${verifiedCount} verifierade, ${flaggedCount} flaggade`);
        }, 300 + Math.min(allIncidents.length, 100) * 10);

        updateStats(allIncidents.length, verifiedCount);
        setTimeout(() => initMiniMap(), 100);
        updateCrimeTypes();
        renderIncidents();
        updateScoreDistribution();
        updateTimePattern();
        updateDayPattern();
        updateRegions();
        updateIntegrityRegions();
        updateTimeRangeInfo();

    } catch (err) {
        addQALog('flagged', `FEL: Kunde inte hämta data — ${err.message}`);
    }
}

// ─── UPDATE STATS ───────────────────────────
function updateStats(total, verified) {
    animateNumber('totalCount', total);
    animateNumber('verifiedCount', verified);
    setTimeout(() => {
        document.getElementById('totalBar').style.width = '100%';
        const pct = total > 0 ? (verified / total * 100) : 0;
        document.getElementById('verifiedBar').style.width = pct + '%';
    }, 200);
}

function animateNumber(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    let current = 0;
    const step = Math.ceil(target / 40);
    const interval = setInterval(() => {
        current += step;
        if (current >= target) { current = target; clearInterval(interval); }
        el.textContent = current;
    }, 25);
}

function updateTimeRangeInfo() {
    const realIncidents = allIncidents.filter(i => !i.isMockedData);
    if (realIncidents.length < 2) return;

    // Sortera för att hitta äldsta och nyaste (API är ofta sorterat men bra att vara säker)
    const sorted = [...realIncidents].sort((a, b) => {
        const da = a.timestamp || new Date(a.datetime).getTime();
        const db = b.timestamp || new Date(b.datetime).getTime();
        return da - db; // äldsta först
    });

    const oldestTime = sorted[0].timestamp || new Date(sorted[0].datetime).getTime();
    const newestTime = sorted[sorted.length - 1].timestamp || new Date(sorted[sorted.length - 1].datetime).getTime();
    const msDiff = newestTime - oldestTime;
    const daysDiff = Math.max(1, Math.ceil(msDiff / (1000 * 60 * 60 * 24)));

    // Uppdatera Dashboard Label
    const totalLabel = document.getElementById('timeRangeLabel');
    if (totalLabel) totalLabel.innerText = `(Senaste ${daysDiff} dagarna)`;

    // Uppdatera de andra rubrikerna som vi förut hårdkodade till "Senaste 500 händelserna"
    document.querySelectorAll('.panel-header h2 span').forEach(el => {
        if (el.innerText.includes('Senaste')) {
            if (el.id === 'timeChartRangeLabel') {
                el.innerText = `(Totalt per timme, senaste ${daysDiff} dagarna)`;
            } else {
                el.innerText = `(Senaste ${daysDiff} dagarna)`;
            }
        }
    });
}

// ─── SCORE DISTRIBUTION ─────────────────────
function updateScoreDistribution() {
    const ranges = { r0: 0, r25: 0, r50: 0, r75: 0 };
    allIncidents.forEach(inc => {
        const s = inc.qa_integrity.score;
        if (s < 25) ranges.r0++;
        else if (s < 50) ranges.r25++;
        else if (s < 75) ranges.r50++;
        else ranges.r75++;
    });
    const max = Math.max(ranges.r0, ranges.r25, ranges.r50, ranges.r75, 1);
    setTimeout(() => {
        document.getElementById('bar0').style.width = (ranges.r0 / max * 100) + '%';
        document.getElementById('bar25').style.width = (ranges.r25 / max * 100) + '%';
        document.getElementById('bar50').style.width = (ranges.r50 / max * 100) + '%';
        document.getElementById('bar75').style.width = (ranges.r75 / max * 100) + '%';
        document.getElementById('count0').textContent = ranges.r0;
        document.getElementById('count25').textContent = ranges.r25;
        document.getElementById('count50').textContent = ranges.r50;
        document.getElementById('count75').textContent = ranges.r75;
    }, 400);
}

// ─── RENDER INCIDENTS (only real data) ──────
function renderIncidents() {
    const list = document.getElementById('incidentList');
    if (!list) return;
    // Filter out test data — only show real incidents
    let source = allIncidents.filter(i => !i.isMockedData);
    let filtered = source;

    if (currentFilter === 'verified') filtered = source.filter(i => !i.qa_integrity.isLowConfidence);
    else if (currentFilter === 'flagged') filtered = source.filter(i => i.qa_integrity.isLowConfidence);

    if (currentRegionFilter) {
        filtered = filtered.filter(i => {
            const locName = (i.location && i.location.name) || '';
            return locName.includes(currentRegionFilter);
        });
    }

    if (filtered.length === 0) {
        list.innerHTML = `<div class="feed-item feed-info" style="margin:20px 0"><span class="feed-icon">📭</span><span class="feed-text">Inga incidenter att visa.</span></div>`;
        return;
    }

    list.innerHTML = filtered.slice(0, 100).map((inc) => {
        const score = inc.qa_integrity.score;
        const isFlagged = inc.qa_integrity.isLowConfidence;
        const badgeClass = score >= 75 ? 'badge-high' : score >= 50 ? 'badge-medium' : score >= 25 ? 'badge-low' : 'badge-critical';
        const statusClass = isFlagged ? 'flagged' : 'verified';
        const typeName = inc.type || inc.name || 'Okänd typ';
        const locationName = (inc.location && inc.location.name) || 'Okänd plats';
        const d = parsePoliceDate(inc.datetime);
        const dateStr = d ? d.toLocaleDateString('sv-SE') + ' ' + d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '';
        const summary = inc.summary || '';

        return `
            <div class="incident-item ${statusClass}" onclick='openIncidentModal(${JSON.stringify(inc).replace(/'/g, "&#39;")})'>
                <div class="incident-score-badge ${badgeClass}">${score}</div>
                <div class="incident-info">
                    <div class="incident-type">${escapeHtml(typeName)}</div>
                    <div class="incident-meta">${escapeHtml(locationName)} · ${dateStr}</div>
                    ${summary ? `<div class="incident-summary">${escapeHtml(summary)}</div>` : ''}
                </div>
                <div class="incident-arrow">›</div>
            </div>
        `;
    }).join('');
}

let currentRegionFilter = null;

function filterIncidentsByRegion(region) {
    currentRegionFilter = region;
    navigateTo('incidenter');

    const allPill = document.querySelector('#page-incidenter .pill[data-filter="all"]');
    if (allPill) {
        currentFilter = 'all';
        document.querySelectorAll('#page-incidenter .pill').forEach(p => p.classList.remove('active'));
        allPill.classList.add('active');
    }

    updateRegionHeader();
    renderIncidents();
}

function clearRegionFilter() {
    currentRegionFilter = null;
    updateRegionHeader();
    renderIncidents();
}

function updateRegionHeader() {
    const sub = document.getElementById('incidentRegionSubHeader');
    if (sub) {
        if (currentRegionFilter) {
            sub.innerHTML = ` i ${escapeHtml(currentRegionFilter)} <button class="clear-region-btn" onclick="clearRegionFilter()" title="Rensa län-sökning">✖</button>`;
        } else {
            sub.innerHTML = '';
        }
    }
}

function filterIncidents(filter, btnEl) {
    currentFilter = filter;
    document.querySelectorAll('#page-incidenter .pill').forEach(p => p.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderIncidents();
}

// ─── QA LIVE FEED ───────────────────────────
function addQALog(type, message) {
    const iconMap = { verified: '✅', flagged: '⚠️', info: 'ℹ️', sandbox: '🧪' };
    const now = new Date();
    const timeStr = now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    qaLogs.unshift({ type, message, time: timeStr });

    const feed = document.getElementById('qaFeed');
    if (!feed) return;
    const item = document.createElement('div');
    item.className = `feed-item feed-${type}`;
    item.innerHTML = `<span class="feed-icon">${iconMap[type] || 'ℹ️'}</span><span class="feed-text">${escapeHtml(message)}</span><span class="feed-time">${timeStr}</span>`;

    // Gör loggar klickbara om vi kan hitta en matchande incident (t.ex "#12345" eller Sandbox "QA Test")
    const matchId = message.match(/#(\d+)/);
    const matchSandbox = message.match(/QA Test: "(.+?)"/);
    if (matchId || matchSandbox) {
        item.classList.add('clickable');
        item.onclick = function () {
            let inc = null;
            if (matchId) inc = allIncidents.find(i => String(i.id) === matchId[1]);
            if (matchSandbox) inc = allIncidents.find(i => i._testLabel === matchSandbox[1] || i.name === matchSandbox[1] || i.name === 'TestEvent - ' + matchSandbox[1]);
            if (inc) openIncidentModal(inc);
            else if (matchId) {
                // Fallback (i fall index !== id under laddningens start)
                const nr = parseInt(matchId[1], 10);
                if (nr < allIncidents.length && allIncidents[nr]) openIncidentModal(allIncidents[nr]);
            }
        };
    }

    feed.prepend(item);
    while (feed.children.length > 50) feed.removeChild(feed.lastChild);
    const countEl = document.getElementById('feedCount');
    if (countEl) countEl.textContent = Math.min(qaLogs.length, 50) + ' loggar';
}

// ─── HONESTY MODAL ──────────────────────────
function openIncidentModal(inc) {
    const score = inc.qa_integrity.score;
    const reasons = inc.qa_integrity.reasons || [];

    document.getElementById('modalTitle').textContent = inc.type || inc.name || 'Incident';
    document.getElementById('modalType').textContent = inc.type || 'Typ okänd';
    document.getElementById('modalLocation').textContent = (inc.location && inc.location.name) || 'Plats okänd';

    let descHtml = escapeHtml(inc.summary || inc.description || 'Ingen beskrivning tillgänglig.');
    if (inc._explains) {
        descHtml = `<div class="qa-modal-explains"><strong>🧪 QA Test:</strong> ${escapeHtml(inc._explains)}</div>` + descHtml;
    }
    document.getElementById('modalDescription').innerHTML = descHtml;

    document.getElementById('modalScoreText').textContent = score;

    const linkEl = document.getElementById('modalLink');
    if (inc.url) { linkEl.href = 'https://polisen.se' + inc.url; linkEl.style.display = 'block'; }
    else { linkEl.style.display = 'none'; }

    const circumference = 326.73;
    const offset = circumference - (score / 100) * circumference;
    const ring = document.getElementById('modalRingProgress');
    ring.style.strokeDashoffset = circumference;
    ring.style.stroke = score >= 75 ? '#10b981' : score >= 50 ? '#3b82f6' : score >= 25 ? '#f59e0b' : '#ef4444';
    setTimeout(() => { ring.style.strokeDashoffset = offset; }, 100);

    const hasGPS = inc.location && inc.location.gps && inc.location.gps !== '0,0';
    const textLen = ((inc.summary || '').length + (inc.description || '').length);
    const hasLocation = inc.location && inc.location.name;

    const lowerSummary = (inc.summary || '').toLowerCase();
    const isMetaPost =
        lowerSummary.includes('frågor från media') ||
        lowerSummary.includes('ingen presstalesperson i tjänst') ||
        lowerSummary.includes('ändrade öppettider');

    let gpsScore = hasGPS ? 30 : 0;
    let textScore = isMetaPost ? 0 : textLen > 15 ? 30 : textLen > 0 ? 15 : 0;
    let timeScore = 20;
    let locScore = hasLocation ? 20 : 0;
    if (reasons.some(r => r.includes('future') || r.includes('Invalid'))) timeScore = 0;
    else if (reasons.some(r => r.includes('delayed'))) timeScore = 10;

    document.getElementById('integrityBreakdown').innerHTML = `
        ${makeBreakdownRow('📍', 'GPS-koordinater', gpsScore, 30)}
        ${makeBreakdownRow('📝', 'Beskrivningskvalitet', textScore, 30)}
        ${makeBreakdownRow('⏰', 'Logisk tidsstämpel', timeScore, 20)}
        ${makeBreakdownRow('🏷️', 'Plats-taggning', locScore, 20)}
    `;

    const reasonsSection = document.getElementById('flagReasonsSection');
    const reasonsList = document.getElementById('flagReasonsList');
    if (reasons.length > 0) {
        reasonsSection.style.display = 'block';
        reasonsList.innerHTML = reasons.map(r => `<li>⛔ ${escapeHtml(r)}</li>`).join('');
    } else { reasonsSection.style.display = 'none'; }

    document.getElementById('modalOverlay').classList.add('active');
}

function makeBreakdownRow(icon, label, points, maxPoints) {
    let cls = 'fail';
    if (points >= maxPoints) cls = 'pass';
    else if (points > 0) cls = 'partial';
    return `<div class="breakdown-item"><span class="breakdown-icon">${icon}</span><span class="breakdown-label">${label}</span><span class="breakdown-points ${cls}">${points}/${maxPoints}</span></div>`;
}

function closeModal() { document.getElementById('modalOverlay').classList.remove('active'); }

// ─── INTERACTIVE MAPS ───────────────────────
const CRIME_COLORS = {
    'Trafikolycka': '#3b82f6', 'Trafikolycka, personskada': '#2563eb',
    'Trafikolycka, singel': '#60a5fa', 'Trafikolycka, vilt': '#93c5fd',
    'Brand': '#f59e0b', 'Misshandel': '#ef4444',
    'Stöld': '#8b5cf6', 'Stöld/inbrott': '#a78bfa',
    'Bedrägeri': '#ec4899', 'Rån': '#dc2626',
    'Rattfylleri': '#f97316', 'Explosion': '#fbbf24',
    'Trafikkontroll': '#06b6d4', 'Sammanfattning natt': '#64748b',
    'Försvunnen person': '#14b8a6', 'Övrigt': '#6b7280'
};

function createClusterIcon(cluster) {
    const count = cluster.getChildCount();
    let sizeClass = 'cluster-small';
    if (count > 10) sizeClass = 'cluster-medium';
    if (count > 30) sizeClass = 'cluster-large';

    return L.divIcon({
        html: `<div><span>${count}</span></div>`,
        className: `custom-marker-cluster ${sizeClass}`,
        iconSize: L.point(40, 40)
    });
}

function initMiniMap() {
    if (miniMap) { updateMapMarkers(miniMap, miniMarkers, 'all'); miniMap.invalidateSize(); return; }
    miniMap = L.map('miniMap', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false }).setView([62.5, 17.5], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(miniMap);

    miniMarkers = L.markerClusterGroup({
        maxClusterRadius: 25,
        iconCreateFunction: createClusterIcon,
        spiderfyOnMaxZoom: false,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: false
    });
    miniMap.addLayer(miniMarkers);

    updateMapMarkers(miniMap, miniMarkers, 'all');
    // Force Leaflet to recalculate container size so tiles fill the whole area
    setTimeout(() => miniMap.invalidateSize(), 300);
}

function initFullMap() {
    if (fullMap) { updateMapMarkers(fullMap, fullMarkers, mapFilter); fullMap.invalidateSize(); return; }
    fullMap = L.map('fullMap', { zoomControl: true, attributionControl: false }).setView([62.5, 17.5], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(fullMap);

    fullMarkers = L.markerClusterGroup({
        maxClusterRadius: 40,
        iconCreateFunction: createClusterIcon,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true
    });
    fullMap.addLayer(fullMarkers);

    updateMapMarkers(fullMap, fullMarkers, mapFilter);
}

function updateMapMarkers(map, markerLayer, filter) {
    if (!map || !markerLayer) return;
    markerLayer.clearLayers();
    // Only real data on maps
    let source = allIncidents.filter(i => !i.isMockedData);
    let filtered = source;
    if (filter === 'verified') filtered = source.filter(i => !i.qa_integrity.isLowConfidence);
    if (filter === 'flagged') filtered = source.filter(i => i.qa_integrity.isLowConfidence);

    filtered.forEach(inc => {
        if (!inc.location || !inc.location.gps) return;
        const parts = inc.location.gps.split(',');
        const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
        if (isNaN(lat) || isNaN(lng)) return;

        const color = CRIME_COLORS[inc.type] || '#6b7280';
        const score = inc.qa_integrity.score;
        const scoreClass = score >= 75 ? 'score-high' : score >= 50 ? 'score-medium' : score >= 25 ? 'score-low' : 'score-critical';

        const marker = L.circleMarker([lat, lng], {
            radius: map === miniMap ? 4 : 7,
            fillColor: color, color: 'rgba(255,255,255,0.3)', weight: 1, fillOpacity: 0.85
        });

        if (map !== miniMap) {
            const typeName = inc.type || 'Okänd';
            const locName = inc.location.name || '';
            const d = parsePoliceDate(inc.datetime);
            const timeStr = d ? d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '';
            const summary = (inc.summary || '').substring(0, 120);
            const url = inc.url ? `<a class="popup-link" href="https://polisen.se${inc.url}" target="_blank" rel="noopener">Läs mer på Polisen.se →</a>` : '';

            marker.bindPopup(`
                <div class="popup-title">${escapeHtml(typeName)}</div>
                <div class="popup-meta">📍 ${escapeHtml(locName)} · ${timeStr}</div>
                ${summary ? `<div class="popup-summary">${escapeHtml(summary)}</div>` : ''}
                <span class="popup-score-badge ${scoreClass}">Score: ${score}/100</span>
                ${url}
            `, { maxWidth: 280 });
        }
        markerLayer.addLayer(marker);
    });
}

function setMapFilter(filter, btn) {
    mapFilter = filter;
    btn.parentElement.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    if (fullMap && fullMarkers) updateMapMarkers(fullMap, fullMarkers, mapFilter);
}

// ─── CRIME TYPE BREAKDOWN ───────────────────
function updateCrimeTypes() {
    const types = {};
    allIncidents.filter(i => !i.isMockedData).forEach(inc => {
        const t = inc.type || 'Okänd';
        types[t] = (types[t] || 0) + 1;
    });
    const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]);
    const max = sorted[0] ? sorted[0][1] : 1;
    const container = document.getElementById('crimeTypeList');
    if (!container) return;

    container.innerHTML = sorted.slice(0, 15).map(([name, count], i) => {
        const color = CRIME_COLORS[name] || '#6b7280';
        return `
            <div class="crime-type-item">
                <span class="crime-type-rank">${i + 1}</span>
                <div class="crime-type-bar-wrap">
                    <span class="crime-type-name">${escapeHtml(name)}</span>
                    <div class="crime-type-bar-track">
                        <div class="crime-type-bar" style="background:${color}" data-width="${(count / max * 100)}"></div>
                    </div>
                </div>
                <span class="crime-type-count">${count}</span>
            </div>
        `;
    }).join('');

    setTimeout(() => {
        container.querySelectorAll('.crime-type-bar').forEach(bar => { bar.style.width = bar.dataset.width + '%'; });
    }, 200);
}

// ─── TIME PATTERN (24H) ────────────────────
function updateTimePattern() {
    const hours = new Array(24).fill(0);
    allIncidents.filter(i => !i.isMockedData).forEach(inc => {
        // Hämta incidentens faktiska tid från name-fältet (t.ex. "25 februari 15.00, Brand")
        // Polisen använder punkt som separator: "HH.MM" (ibland ensiffrig timme)
        const name = inc.name || '';
        const timeMatch = name.match(/\b(\d{1,2})\.(\d{2})\b/);

        if (timeMatch) {
            const hour = parseInt(timeMatch[1], 10);
            hours[hour]++;
        } else {
            // Fallback om tiden saknas i titeln (använder publiceringstiden)
            const d = parsePoliceDate(inc.datetime);
            if (d) hours[d.getHours()]++;
        }
    });

    const max = Math.max(...hours, 1);
    const total = hours.reduce((a, b) => a + b, 0);
    const container = document.getElementById('timeChart');
    const noteEl = document.getElementById('timeChartNote');
    if (!container) return;

    const peakHour = hours.indexOf(Math.max(...hours));

    container.innerHTML = hours.map((count, h) => {
        const pct = (count / max * 100);
        const intensity = count / max;
        const r = Math.round(59 + intensity * 180);
        const g = Math.round(130 - intensity * 60);
        const b = Math.round(246 - intensity * 100);
        const color = `rgb(${r},${g},${b})`;
        const label = h % 3 === 0 ? h.toString().padStart(2, '0') : '&nbsp;';

        return `
            <div class="time-bar-wrap">
                <div class="time-bar-container">
                    <div class="time-bar" style="background:${color}" data-height="${pct}%">
                        <div class="time-bar-tooltip">${h.toString().padStart(2, '0')}:00 — ${count} incidenter</div>
                    </div>
                </div>
                <span class="time-bar-label">${label}</span>
            </div>
        `;
    }).join('');

    setTimeout(() => {
        container.querySelectorAll('.time-bar').forEach(bar => { bar.style.height = bar.dataset.height; });
    }, 300);

    if (noteEl) noteEl.textContent = `Mest aktivitet kl ${peakHour.toString().padStart(2, '0')}:00 (${hours[peakHour]} incidenter) · ${total} med tidsstämplar`;
}

// ─── DAY PATTERN (Weekly) ──────────────────
function updateDayPattern() {
    const days = new Array(7).fill(0);
    allIncidents.filter(i => !i.isMockedData).forEach(inc => {
        const d = parsePoliceDate(inc.datetime);
        if (d) {
            let day = d.getDay() - 1; // Måndag = 0
            if (day === -1) day = 6;  // Söndag = 6
            days[day]++;
        }
    });

    const max = Math.max(...days, 1);
    const container = document.getElementById('dayChart');
    if (!container) return;

    const dayNames = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];
    container.innerHTML = days.map((val, i) => {
        const height = (val / max) * 100;
        return `
            <div class="time-bar-wrap">
                <div class="time-bar-container">
                    <div class="time-bar" 
                         style="height: 0; background: linear-gradient(to top, #3b82f6, #8b5cf6);"
                         data-height="${height}%">
                        <div class="time-bar-tooltip">${val}st</div>
                    </div>
                </div>
                <div class="time-bar-label">${dayNames[i]}</div>
            </div>
        `;
    }).join('');

    setTimeout(() => {
        container.querySelectorAll('.time-bar').forEach(bar => { bar.style.height = bar.dataset.height; });
    }, 300);
}

// ─── REGIONS INTEGRITY (Kvalitetsligan) ──────
function updateIntegrityRegions() {
    const regionScores = {};
    const realIncidents = allIncidents.filter(i => !i.isMockedData);
    if (realIncidents.length === 0) return;

    realIncidents.forEach(inc => {
        const name = (inc.location && inc.location.name) || 'Okänd';
        const parts = name.split(',');
        const lan = parts[parts.length - 1].trim();
        const score = inc.qa_integrity ? inc.qa_integrity.score : 0;

        if (!regionScores[lan]) regionScores[lan] = { totalScore: 0, count: 0 };
        regionScores[lan].totalScore += score;
        regionScores[lan].count += 1;
    });

    const sorted = Object.entries(regionScores)
        .map(([name, data]) => ({ name, avgScore: Math.round(data.totalScore / data.count) }))
        .sort((a, b) => b.avgScore - a.avgScore);

    const container = document.getElementById('integrityRegionList');
    if (!container) return;

    container.innerHTML = sorted.slice(0, 10).map((r, i) => {
        const rankClass = i < 3 ? `rank-${i + 1}` : '';
        const medal = i === 0 ? '🏆' : i === 1 ? '🌟' : i === 2 ? '⭐' : `${i + 1}`;
        const scoreClass = r.avgScore >= 75 ? 'score-high' : r.avgScore >= 50 ? 'score-medium' : r.avgScore >= 25 ? 'score-low' : 'score-critical';
        return `
            <div class="region-item" onclick="filterIncidentsByRegion('${r.name.replace(/'/g, "\\'")}')" title="Snittpoäng: ${r.avgScore}/100">
                <span class="region-rank ${rankClass}">${medal}</span>
                <span class="region-name">${escapeHtml(r.name)}</span>
                <span class="region-score ${scoreClass}" style="margin-left:auto; font-weight:bold; padding: 2px 8px; border-radius:12px; font-size: 0.8rem; border: 1px solid currentColor;">${r.avgScore}p</span>
            </div>
        `;
    }).join('');
}

// ─── TOP REGIONS ────────────────────────────
function updateRegions() {
    const regions = {};
    const realIncidents = allIncidents.filter(i => !i.isMockedData);
    realIncidents.forEach(inc => {
        const name = (inc.location && inc.location.name) || 'Okänd';
        const parts = name.split(',');
        const lan = parts[parts.length - 1].trim();
        regions[lan] = (regions[lan] || 0) + 1;
    });

    const sorted = Object.entries(regions).sort((a, b) => b[1] - a[1]);
    const total = realIncidents.length;
    const container = document.getElementById('regionList');
    if (!container) return;

    container.innerHTML = sorted.slice(0, 21).map(([name, count], i) => {
        const pct = ((count / total) * 100).toFixed(1);
        const rankClass = i < 3 ? `rank-${i + 1}` : '';
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
        return `
            <div class="region-item" onclick="filterIncidentsByRegion('${name.replace(/'/g, "\\'")}')" title="Klicka för att visa alla incidenter från ${escapeHtml(name)}">
                <span class="region-rank ${rankClass}">${medal}</span>
                <span class="region-name">${escapeHtml(name)}</span>
                <span class="region-count">${count}</span>
                <span class="region-pct">${pct}%</span>
            </div>
        `;
    }).join('');
}

// ═══════════════════════════════════════════
//  QA LAB — AI Auto-Fix Simulator
// ═══════════════════════════════════════════

const CHAOS_SCENARIOS = [
    {
        id: 'north_pole_gps',
        icon: '🧊',
        title: 'GPS pekar på Nordpolen',
        subtitle: 'Koordinaterna hamnade i Arktis',
        broken: {
            type: 'Rån',
            location: 'Stockholm',
            gps: '90.0000, 0.0000',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: 'Ett rån begicks mot en butik på Drottninggatan i centrala Stockholm. Gärningsmannen hotade personalen med kniv och flydde med kontanter söderut.'
        },
        fixed: {
            type: 'Rån',
            location: 'Stockholm',
            gps: '59.3326, 18.0649',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: 'Ett rån begicks mot en butik på Drottninggatan i centrala Stockholm. Gärningsmannen hotade personalen med kniv och flydde med kontanter söderut.'
        },
        errors: [
            { field: 'gps', explanation: 'GPS visar 90.0, 0.0 — det är Nordpolen! Texten säger "Drottninggatan i centrala Stockholm".' }
        ],
        fixExplanation: 'Watchdog-AI läste sammanfattningen, hittade "Drottninggatan i centrala Stockholm", och ersatte Nordpolens koordinater (90.0, 0.0) med Stockholms centrum (59.33, 18.06). Nu pekar kartan rätt.'
    },
    {
        id: 'future_date',
        icon: '⏰',
        title: 'Händelse från framtiden',
        subtitle: 'Tidsstämpeln pekar på år 2030',
        broken: {
            type: 'Trafikolycka',
            location: 'Göteborg, Västra Götalands län',
            gps: '57.7089, 11.9746',
            datetime: '2030-12-31 23:59:00',
            summary: 'En trafikolycka inträffade på E6 i höjd med Tingstadstunneln. Två personbilar var inblandade. Inga allvarliga personskador.'
        },
        fixed: {
            type: 'Trafikolycka',
            location: 'Göteborg, Västra Götalands län',
            gps: '57.7089, 11.9746',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: 'En trafikolycka inträffade på E6 i höjd med Tingstadstunneln. Två personbilar var inblandade. Inga allvarliga personskador.'
        },
        errors: [
            { field: 'datetime', explanation: 'Datumet "2030-12-31" ligger nästan 5 år i framtiden. Incidenter kan inte ha skett i framtiden.' }
        ],
        fixExplanation: 'Watchdog-AI upptäckte att tidsstämpeln låg i framtiden (år 2030) och ersatte den med dagens datum och tid. Övrig data var korrekt.'
    },
    {
        id: 'empty_description',
        icon: '📝',
        title: 'Helt tom beskrivning',
        subtitle: 'Bara brottstypen finns — inget annat',
        broken: {
            type: 'Brand',
            location: 'Malmö, Skåne län',
            gps: '55.6049, 13.0038',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: ''
        },
        fixed: {
            type: 'Brand',
            location: 'Malmö, Skåne län',
            gps: '55.6049, 13.0038',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: 'En brand har rapporterats i Malmö, Skåne län. Ytterligare detaljer saknas ännu. Kontakta polisen på 114 14 för mer information.'
        },
        errors: [
            { field: 'summary', explanation: 'Sammanfattningen är helt tom! Allmänheten får ingen information alls om vad som har hänt.' }
        ],
        fixExplanation: 'Watchdog-AI såg att beskrivningen var helt tom. Baserat på brottstypen (Brand) och platsen (Malmö) genererades en grundläggande sammanfattning så att medborgarna åtminstone vet att något har hänt.'
    },
    {
        id: 'swedish_gps',
        icon: '🇸🇪',
        title: 'Svenska tecken i GPS',
        subtitle: 'ÅÄÖ istället för siffror i koordinaterna',
        broken: {
            type: 'Misshandel',
            location: 'Uppsala',
            gps: '59.ÅÄÖ, 18.ÖÄÅ',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: 'En man misshandlades utanför en restaurang på Dragarbrunnsgatan i Uppsala under natten. Vittnen har hörts.'
        },
        fixed: {
            type: 'Misshandel',
            location: 'Uppsala',
            gps: '59.8586, 17.6389',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: 'En man misshandlades utanför en restaurang på Dragarbrunnsgatan i Uppsala under natten. Vittnen har hörts.'
        },
        errors: [
            { field: 'gps', explanation: 'GPS-fältet innehåller "59.ÅÄÖ, 18.ÖÄÅ" — bokstäver fungerar inte som koordinater! Kartan kan inte tolka detta.' }
        ],
        fixExplanation: 'Watchdog-AI identifierade att GPS-fältet innehöll ogiltiga svenska tecken (ÅÄÖ). Genom att läsa texten och identifiera "Dragarbrunnsgatan i Uppsala" slogs korrekta koordinater upp (59.86, 17.64).'
    },
    {
        id: 'wrong_region',
        icon: '🗺️',
        title: 'Fel stad i platsfältet',
        subtitle: 'Texten säger Malmö men platsen säger Kiruna',
        broken: {
            type: 'Stöld',
            location: 'Kiruna, Norrbottens län',
            gps: '67.8558, 20.2253',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: 'En cykelstöld rapporterades vid Triangelns köpcentrum i centrala Malmö. Lås hade klippts med bultklippare.'
        },
        fixed: {
            type: 'Stöld',
            location: 'Malmö, Skåne län',
            gps: '55.5953, 13.0017',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: 'En cykelstöld rapporterades vid Triangelns köpcentrum i centrala Malmö. Lås hade klippts med bultklippare.'
        },
        errors: [
            { field: 'location', explanation: 'Platsfältet säger "Kiruna, Norrbottens län" men texten beskriver tydligt "Triangelns köpcentrum i centrala Malmö".' },
            { field: 'gps', explanation: 'GPS-koordinaterna (67.86, 20.23) pekar på Kiruna i norra Sverige — 150 mil från Malmö.' }
        ],
        fixExplanation: 'Watchdog-AI jämförde platsfältet (Kiruna) med sammanfattningen (Malmö). Den insåg att texten refererade "Triangelns köpcentrum i centrala Malmö" och korrigerade både plats och GPS till Malmö, Skåne län (55.60, 13.00).'
    },
    {
        id: 'total_chaos',
        icon: '💀',
        title: 'Totalt kaos',
        subtitle: 'Allting är fel samtidigt',
        broken: {
            type: '',
            location: '',
            gps: 'abc, xyz',
            datetime: 'inte-ett-datum',
            summary: ''
        },
        fixed: {
            type: 'Okänd brottstyp',
            location: 'Plats ej angiven',
            gps: 'Ej tillgänglig',
            datetime: new Date().toLocaleString('sv-SE'),
            summary: 'En incident har rapporterats men saknar fullständig information. Ärendet markeras med låg tillförlitlighet tills polisen uppdaterar rapporten.'
        },
        errors: [
            { field: 'type', explanation: 'Brottstypen är helt tom — vi vet inte ens vad för typ av händelse det gäller.' },
            { field: 'location', explanation: 'Platsfältet är tomt. Incidenten kan inte kopplas till någon region.' },
            { field: 'gps', explanation: 'GPS-koordinaterna "abc, xyz" är bokstäver. Kart-systemet kraschar om det försöker tolka detta.' },
            { field: 'datetime', explanation: '"inte-ett-datum" kan inte tolkas som ett datum. Vi vet inte när händelsen skedde.' },
            { field: 'summary', explanation: 'Beskrivningen är helt tom. Medborgarna får ingen information alls.' }
        ],
        fixExplanation: 'Watchdog-AI hittade 5 av 5 fält trasiga. Datumet sattes till idag, ogiltiga GPS-koordinater flaggades som otillgängliga, brottstypen och platsen markerades som okända, och en bastext genererades. Incidenten markeras med låg tillförlitlighet — den rödmarkeras i dashboarden.'
    }
];

let currentChaosScenario = null;
let chaosIsFixed = false;

function renderChaosScenarios() {
    const container = document.getElementById('chaosScenarios');
    if (!container) return;
    container.innerHTML = CHAOS_SCENARIOS.map(s => `
        <button class="chaos-scenario-btn ${currentChaosScenario && currentChaosScenario.id === s.id ? 'active' : ''}" onclick="chaosSelectScenario('${s.id}')">
            <span class="chaos-scenario-icon">${s.icon}</span>
            <div class="chaos-scenario-info">
                <strong>${escapeHtml(s.title)}</strong>
                <span>${escapeHtml(s.subtitle)}</span>
            </div>
        </button>
    `).join('');
}

function chaosSelectScenario(id) {
    const scenario = CHAOS_SCENARIOS.find(s => s.id === id);
    if (!scenario) return;
    currentChaosScenario = scenario;
    chaosIsFixed = false;

    // Show viewer section
    document.getElementById('chaosViewerSection').style.display = '';

    // Update phase badge
    const badge = document.getElementById('phaseBadge');
    badge.className = 'phase-badge phase-broken';
    badge.textContent = '⚠️ Trasig data inmatad';

    // Fill broken data
    const b = scenario.broken;
    document.getElementById('chaosType').textContent = b.type || '(tomt)';
    document.getElementById('chaosLocation').textContent = b.location || '(tomt)';
    document.getElementById('chaosGps').textContent = b.gps || '(tomt)';
    document.getElementById('chaosDatetime').textContent = b.datetime || '(tomt)';
    document.getElementById('chaosSummary').textContent = b.summary || '(tomt)';

    // Clear all error/fixed classes
    ['Type', 'Location', 'Gps', 'Datetime', 'Summary'].forEach(f => {
        const el = document.getElementById('chaosField' + f);
        el.classList.remove('has-error', 'is-fixed');
    });

    // Highlight broken fields
    const fieldMap = { type: 'Type', location: 'Location', gps: 'Gps', datetime: 'Datetime', summary: 'Summary' };
    scenario.errors.forEach(err => {
        const el = document.getElementById('chaosField' + fieldMap[err.field]);
        if (el) el.classList.add('has-error');
    });

    // Render error explanations
    const errContainer = document.getElementById('chaosErrors');
    errContainer.innerHTML = scenario.errors.map(err => `
        <div class="chaos-error-item">
            <span class="chaos-error-icon">❌</span>
            <p>${escapeHtml(err.explanation)}</p>
        </div>
    `).join('');
    errContainer.style.display = '';

    // Show fix button, hide result
    document.getElementById('chaosActions').style.display = '';
    document.getElementById('chaosFixBtn').disabled = false;
    document.getElementById('chaosFixResult').style.display = 'none';

    // Update scenario buttons
    renderChaosScenarios();

    // Log
    addQALog('sandbox', `Scenario valt: "${scenario.title}"`);

    // Scroll to viewer
    document.getElementById('chaosViewerSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function chaosRunFix() {
    if (!currentChaosScenario || chaosIsFixed) return;

    const btn = document.getElementById('chaosFixBtn');
    btn.disabled = true;
    btn.querySelector('strong').textContent = 'Watchdog-AI analyserar...';

    addQALog('info', `Watchdog-AI aktiverad för "${currentChaosScenario.title}"`);

    // Simulate AI "thinking" with a delay
    await new Promise(r => setTimeout(r, 800));

    const scenario = currentChaosScenario;
    const fieldMap = { type: 'Type', location: 'Location', gps: 'Gps', datetime: 'Datetime', summary: 'Summary' };

    // Animate each error field one at a time
    for (let i = 0; i < scenario.errors.length; i++) {
        const err = scenario.errors[i];
        const fieldId = fieldMap[err.field];
        const fieldEl = document.getElementById('chaosField' + fieldId);
        const valueEl = document.getElementById('chaos' + fieldId);

        // Flash the field
        fieldEl.classList.add('fixing');
        await new Promise(r => setTimeout(r, 500));

        // Replace with fixed value
        const fixedVal = scenario.fixed[err.field];
        if (fixedVal !== undefined) {
            valueEl.textContent = fixedVal || '(tomt)';
        }

        // Swap classes
        fieldEl.classList.remove('has-error', 'fixing');
        fieldEl.classList.add('is-fixed');

        await new Promise(r => setTimeout(r, 300));
    }

    // Update phase badge
    const badge = document.getElementById('phaseBadge');
    badge.className = 'phase-badge phase-fixed';
    badge.textContent = '✅ Alla fel har reparats';

    // Hide errors, hide button, show result
    document.getElementById('chaosErrors').style.display = 'none';
    document.getElementById('chaosActions').style.display = 'none';
    document.getElementById('chaosFixResult').style.display = '';
    document.getElementById('chaosFixExplanation').textContent = scenario.fixExplanation;

    chaosIsFixed = true;

    addQALog('verified', `Watchdog-AI fixade ${scenario.errors.length} fel i "${scenario.title}"`);
}

// Initialize chaos scenarios on page load
document.addEventListener('DOMContentLoaded', () => {
    renderChaosScenarios();
});

// ─── TOAST ──────────────────────────────────
let toastTimeout = null;
function showToast(name, score, isFlagged) {
    const toast = document.getElementById('sandboxToast');
    if (!toast) return;
    document.getElementById('toastIcon').textContent = isFlagged ? '⚠️' : '✅';
    document.getElementById('toastTitle').textContent = name;
    const detail = document.getElementById('toastDetail');
    detail.textContent = `Score: ${score}/100 — ${isFlagged ? 'FLAGGAD' : 'VERIFIERAD'}`;
    detail.className = 'toast-detail ' + (isFlagged ? 'toast-flagged' : 'toast-verified');
    toast.classList.add('active');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('active'), 3500);
}

// ─── UTILITIES ──────────────────────────────
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
});
