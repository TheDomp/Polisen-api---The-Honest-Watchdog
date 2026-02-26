async function test() {
    const res = await fetch('https://polisen-api-the-honest-watchdog.onrender.com/api/incidents');
    const allIncidents = await res.json();

    function parsePoliceDate(str) {
        if (!str) return null;
        const fixed = str.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-]\d{2}):(\d{2})$/, (_, d, h, m, s, oh, om) => `${d}T${h.padStart(2, '0')}:${m}:${s}${oh}:${om}`);
        const d = new Date(fixed);
        return isNaN(d.getTime()) ? null : d;
    }

    const hours = new Array(24).fill(0);
    allIncidents.forEach(inc => {
        const d = parsePoliceDate(inc.datetime);
        if (d) hours[d.getHours()]++;
    });

    const max = Math.max(...hours, 1);
    console.log("Max count:", max);
    console.log("Hours array:", hours);

    const html = hours.map((count, h) => {
        const pct = (count / max * 100);
        const label = h % 3 === 0 ? h.toString().padStart(2, '0') : '';
        return `<div class="time-bar-wrap">
    <div class="time-bar-container">
        <div class="time-bar" style="background:color" data-height="${pct}%">
            <div class="time-bar-tooltip">${h.toString().padStart(2, '0')}:00 — ${count} incidenter</div>
        </div>
    </div>
    <span class="time-bar-label">${label}</span>
</div>`;
    }).join('\n');
    console.log(html.substring(0, 1000));
}
test();
