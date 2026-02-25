/* ============================================
   THE HONEST WATCHDOG — Frontend Logic (SPA)
   ============================================ */

const API_BASE = window.location.origin;

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
    const fixed = str.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2}):(\d{2})$/, '$1T$2$3:$4');
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
        initMiniMap();
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
            el.innerText = `(Senaste ${daysDiff} dagarna)`;
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
    document.getElementById('modalDescription').textContent = inc.summary || inc.description || 'Ingen beskrivning tillgänglig.';
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

function initMiniMap() {
    if (miniMap) { updateMapMarkers(miniMap, miniMarkers, 'all'); return; }
    miniMap = L.map('miniMap', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false }).setView([62.5, 17.5], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(miniMap);
    miniMarkers = L.layerGroup().addTo(miniMap);
    updateMapMarkers(miniMap, miniMarkers, 'all');
}

function initFullMap() {
    if (fullMap) { updateMapMarkers(fullMap, fullMarkers, mapFilter); fullMap.invalidateSize(); return; }
    fullMap = L.map('fullMap', { zoomControl: true, attributionControl: false }).setView([62.5, 17.5], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(fullMap);
    fullMarkers = L.layerGroup().addTo(fullMap);
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
        const d = parsePoliceDate(inc.datetime);
        if (d) hours[d.getHours()]++;
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
        const label = h % 3 === 0 ? h.toString().padStart(2, '0') : '';

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
//  QA LAB — Sandbox Testing
// ═══════════════════════════════════════════

const SANDBOX_PRESETS = {
    missing_gps: {
        id: 99901, datetime: new Date().toISOString(),
        name: 'TestEvent - Ingen GPS', type: 'Stöld',
        summary: 'En misstänkt stöld rapporterades i centrala Stockholm, men inga koordinater angavs.',
        description: 'Polisen fick in en anmälan om stöld. Gärningsmannen är okänd. Ärendet utreds vidare.',
        location: { name: 'Stockholm', gps: '' },
        _testLabel: 'Ingen GPS', _testCategory: 'GPS-koordinater',
        _explains: 'Incidenten saknar GPS-koordinater helt, vilket ger 0 av 30 möjliga GPS-poäng.'
    },
    future_date: {
        id: 99902, datetime: '2030-12-31T23:59:00+0100',
        name: 'TestEvent - Framtida datum', type: 'Trafikolycka',
        summary: 'Trafikolycka med framtida datum för att testa tidsstämpelvalidering.',
        description: 'Incidenten har ett datum satt i framtiden, 2030-12-31.',
        location: { name: 'Göteborg', gps: '57.7089,11.9746' },
        _testLabel: 'Ologisk tidsstämpel', _testCategory: 'Tidsstämpel',
        _explains: 'Incidenten testas med ett datum långt in i framtiden (här 2030-12-31). Systemet upptäcker logikfelet och ger 0 av 20 tidsstämpelpoäng.'
    },
    empty_text: {
        id: 99903, datetime: new Date().toISOString(),
        name: 'TestEvent - Tom text', type: 'Brand',
        summary: '', description: '',
        location: { name: 'Malmö', gps: '55.6049,13.0038' },
        _testLabel: 'Tom beskrivning', _testCategory: 'Beskrivningskvalitet',
        _explains: 'Helt tom sammanfattning och beskrivning — systemet ger 0 av 30 textpoäng.'
    },
    swedish_in_gps: {
        id: 99904, datetime: new Date().toISOString(),
        name: 'TestEvent - Svenska i GPS', type: 'Misshandel',
        summary: 'GPS som innehåller svenska tecken (ÅÄÖ) för att testa sanering.',
        description: 'GPS: 59.ÅÄÖ,18.ÖÄÅ — bör inte kunna parsas till giltiga koordinater.',
        location: { name: 'Uppsala', gps: '59.ÅÄÖ,18.ÖÄÅ' },
        _testLabel: 'Svenska i GPS', _testCategory: 'GPS-koordinater + Gen AI',
        _explains: 'AI-genererat test: GPS med svenska tecken (ÅÄÖ) istället för siffror. Systemet ger 0 GPS-poäng.'
    },
    perfect: {
        id: 99905, datetime: new Date().toISOString(),
        name: 'TestEvent - Perfekt data', type: 'Rån',
        summary: 'Ett rån begicks mot en butik i centrala Linköping vid middagstid.',
        description: 'Gärningsmannen maskerad, ca 180cm lång, flydde söderut. Polisen söker vittnen via telefon: 114 14.',
        location: { name: 'Linköping, Östergötlands län', gps: '58.4108,15.6214' },
        _testLabel: 'Perfekt data', _testCategory: 'Kontrolltest',
        _explains: 'Alla fält är korrekta och fullständiga. Bör ge full poäng: 100/100.'
    },
    total_garbage: {
        id: 99906, datetime: 'inte-ett-datum',
        name: 'TestEvent - Skräpdata', type: '', summary: '', description: '',
        location: { name: '', gps: 'abc,xyz' },
        _testLabel: 'Total skräpdata', _testCategory: 'Stressttest',
        _explains: 'Alla fält är felaktiga: ogiltigt datum, tom typ, tom text, ogiltiga GPS, ingen plats. Bör ge 0/100.'
    }
};

let sandboxIdCounter = 99900;

async function injectPreset(key) {
    const presetSource = SANDBOX_PRESETS[key];
    if (!presetSource) return;

    // Clone and clean internal fields
    const preset = { ...presetSource };
    const testLabel = preset._testLabel;
    const testCategory = preset._testCategory;
    const explains = preset._explains;
    delete preset._testLabel;
    delete preset._testCategory;
    delete preset._explains;

    sandboxIdCounter++;
    preset.id = sandboxIdCounter;

    addQALog('sandbox', `Injicerar testdata: ${testLabel}`);

    try {
        const res = await fetch(`${API_BASE}/api/test-sandbox/inject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(preset)
        });
        const result = await res.json();
        const score = result.result.qa_integrity.score;
        const isFlagged = result.result.qa_integrity.isLowConfidence;
        const reasons = result.result.qa_integrity.reasons || [];

        // Don't add to main incidents — keep QA separate
        // (it's added on server, but we filter it out in renderIncidents)
        allIncidents.unshift(result.result);

        // Build result detail for QA results panel
        const now = new Date();
        const timeStr = now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const hasGPS = result.result.location && result.result.location.gps && result.result.location.gps !== '0,0';
        const textLen = ((result.result.summary || '').length + (result.result.description || '').length);
        const hasLoc = result.result.location && result.result.location.name;

        const lowerSummary = (result.result.summary || '').toLowerCase();
        const isMetaPost =
            lowerSummary.includes('frågor från media') ||
            lowerSummary.includes('ingen presstalesperson i tjänst') ||
            lowerSummary.includes('ändrade öppettider');

        const gpsOk = hasGPS;
        const textOk = !isMetaPost && textLen > 15;
        const textPartial = !isMetaPost && textLen > 0 && textLen <= 15;
        const locOk = hasLoc;
        const timeOk = !reasons.some(r => r.includes('future') || r.includes('Invalid'));

        qaTestResults.unshift({
            name: testLabel, category: testCategory, explains,
            score, isFlagged, reasons, timeStr,
            checks: { gpsOk, textOk, textPartial, locOk, timeOk }
        });

        renderQAResults();

        // Log
        if (isFlagged) addQALog('flagged', `QA Test: "${testLabel}" → ${score}/100 (FLAGGAD)`);
        else addQALog('verified', `QA Test: "${testLabel}" → ${score}/100 (OK)`);

        showToast(testLabel, score, isFlagged);

    } catch (err) {
        addQALog('flagged', `QA Test FEL: ${err.message}`);
        showToast('FEL', 0, true);
    }
}

function renderQAResults() {
    const container = document.getElementById('qaResultsList');
    if (!container) return;

    if (qaTestResults.length === 0) {
        container.innerHTML = `<div class="qa-empty-state"><div class="qa-empty-icon">🔬</div><p>Klicka på en testprofil till vänster för att se resultatet här.</p></div>`;
        return;
    }

    container.innerHTML = qaTestResults.map(r => {
        const scoreClass = r.score >= 75 ? 'score-pass' : r.score >= 50 ? 'score-warn' : 'score-fail';
        const statusText = r.isFlagged ? 'FLAGGAD' : 'GODKÄND';

        return `
            <div class="qa-result-item">
                <div class="qa-result-header">
                    <div class="qa-result-score ${scoreClass}">${r.score}</div>
                    <span class="qa-result-name">${escapeHtml(r.name)}</span>
                    <span class="qa-result-time">${r.timeStr}</span>
                </div>
                <div class="qa-result-checks">
                    <div class="qa-result-check"><span class="${r.checks.gpsOk ? 'check-pass' : 'check-fail'}">${r.checks.gpsOk ? '✅' : '❌'}</span> GPS-koordinater (30p)</div>
                    <div class="qa-result-check"><span class="${r.checks.textOk ? 'check-pass' : r.checks.textPartial ? 'check-warn' : 'check-fail'}">${r.checks.textOk ? '✅' : r.checks.textPartial ? '⚠️' : '❌'}</span> Beskrivning (30p)</div>
                    <div class="qa-result-check"><span class="${r.checks.timeOk ? 'check-pass' : 'check-fail'}">${r.checks.timeOk ? '✅' : '❌'}</span> Tidsstämpel (20p)</div>
                    <div class="qa-result-check"><span class="${r.checks.locOk ? 'check-pass' : 'check-fail'}">${r.checks.locOk ? '✅' : '❌'}</span> Platstaggning (20p)</div>
                </div>
                ${r.explains ? `<div class="qa-result-reasons"><div class="qa-result-reason" style="color:var(--text-secondary)">💡 ${escapeHtml(r.explains)}</div></div>` : ''}
                ${r.reasons.length > 0 ? `<div class="qa-result-reasons">${r.reasons.map(reason => `<div class="qa-result-reason">⛔ ${escapeHtml(reason)}</div>`).join('')}</div>` : ''}
            </div>
        `;
    }).join('');
}

// ─── TOAST ──────────────────────────────────
let toastTimeout = null;
function showToast(name, score, isFlagged) {
    const toast = document.getElementById('sandboxToast');
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
