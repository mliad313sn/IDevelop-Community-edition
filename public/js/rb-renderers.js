/* ================================================================
   REPORT BUILDER — Chart Renderers (13 types)
   ================================================================ */
window.RBRenderers = (function () {
    'use strict';

    // Escape user-supplied dimension/label values before innerHTML injection.
    const esc = (s) =>
        String(s == null ? '' : s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );

    const CT = window.ChartTheme || {};

    // The report builder used to carry its OWN seven colour ramps here — a second
    // palette table no theme could reach, which is why report-builder charts would
    // have stayed gold inside a green product while every other chart followed the
    // brand. The ramps now live in chart-theme.js (which keeps these exact arrays
    // as its fallback) and are
    // selected there from the running identity. The scheme KEYS are persisted in
    // saved report definitions, so they must not be renamed.
    const PALETTES = CT.SCHEMES || {
        gold: ['#7C6CFF', '#6F61E6', '#6356CC', '#564BB3', '#4A4099', '#3E3580', '#322B66'],
        emerald: ['#2DD4A0', '#28C090', '#23AC80', '#1E9870', '#198460', '#147050', '#0F5C40'],
        multi: [
            '#7C6CFF',
            '#2DD4A0',
            '#5B9DF5',
            '#F06060',
            '#F5A623',
            '#9B7DFF',
            '#22D3EE',
            '#FF6B9D',
        ],
        heatscale: ['#F06060', '#F5A623', '#F5D423', '#A8D86D', '#2DD4A0'],
        cool: ['#5B9DF5', '#4E8DE0', '#417DCB', '#346DB6', '#275DA1', '#1A4D8C', '#0D3D77'],
        mono: ['#E4E8F0', '#C8CDD8', '#ACB2C0', '#9097A8', '#747C90', '#586178', '#3C4660'],
        sunset: ['#F06060', '#F07840', '#F09020', '#F0A800', '#F0C000', '#E8D020', '#E0E040'],
    };
    // Conditional formatting is STATUS, so it reads the semantic tokens, never a
    // palette slot: "below target" has to stay red-ish in a green-branded product.
    const SEM = CT.SEMANTIC || { good: '#2DD4A0', mid: '#F5A623', low: '#F06060' };

    function getColors(scheme, count) {
        const p = PALETTES[scheme] || PALETTES.multi;
        const out = [];
        for (let i = 0; i < count; i++) out.push(p[i % p.length]);
        return out;
    }

    function cfColor(value, preset) {
        if (!preset) return null;
        const rules = {
            readiness: (v) => (v < 50 ? SEM.low : v < 80 ? SEM.mid : SEM.good),
            gap: (v) => (v === 0 ? SEM.good : v === 1 ? SEM.mid : SEM.low),
            level: (v) => (v <= 1 ? SEM.low : v === 2 ? SEM.mid : SEM.good),
            coverage: (v) => (v < 60 ? SEM.low : v <= 85 ? SEM.mid : SEM.good),
        };
        return rules[preset] ? rules[preset](value) : null;
    }

    function cfBadge(value, preset) {
        if (!preset) return '';
        const badges = {
            readiness: (v) =>
                v < 50
                    ? '<span class="rb-badge critical">Critical</span>'
                    : v < 80
                      ? '<span class="rb-badge watch">Watch</span>'
                      : '<span class="rb-badge ready">Ready</span>',
            gap: (v) =>
                v === 0
                    ? '<span class="rb-badge ready">OK</span>'
                    : v === 1
                      ? '<span class="rb-badge watch">Watch</span>'
                      : '<span class="rb-badge critical">Critical</span>',
            level: (v) =>
                v <= 1
                    ? '<span class="rb-badge critical">Low</span>'
                    : v === 2
                      ? '<span class="rb-badge watch">Mid</span>'
                      : '<span class="rb-badge ready">High</span>',
            coverage: (v) =>
                v < 60
                    ? '<span class="rb-badge critical">Low</span>'
                    : v <= 85
                      ? '<span class="rb-badge watch">Mid</span>'
                      : '<span class="rb-badge ready">Good</span>',
        };
        return badges[preset] ? badges[preset](value) : '';
    }

    // ── 1. Bar ──
    function render_bar(container, data, config) {
        const canvas = _makeCanvas(container);
        const colors = getColors(config.colorScheme, data.labels.length);
        return new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: data.labels,
                datasets: [
                    {
                        label: config.metric || 'Value',
                        data: data.data,
                        backgroundColor: colors,
                        borderRadius: 4,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#8899aa' },
                    },
                    x: { grid: { display: false }, ticks: { color: '#8899aa', maxRotation: 45 } },
                },
            },
        });
    }

    // ── 2. Stacked Bar ──
    function render_stackedBar(container, data, config) {
        const canvas = _makeCanvas(container);
        const colors = getColors(config.colorScheme, data.datasets ? data.datasets.length : 1);
        const datasets = data.datasets
            ? data.datasets.map((ds, i) => ({ ...ds, backgroundColor: colors[i], borderRadius: 2 }))
            : [{ label: 'Value', data: data.data, backgroundColor: colors[0] }];
        return new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: { labels: data.labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#8899aa' } } },
                scales: {
                    x: { stacked: true, grid: { display: false }, ticks: { color: '#8899aa' } },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#8899aa' },
                    },
                },
            },
        });
    }

    // ── 3. Horizontal Bar ──
    function render_horizontalBar(container, data, config) {
        const canvas = _makeCanvas(container);
        const colors = getColors(config.colorScheme, data.labels.length);
        return new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: data.labels,
                datasets: [
                    {
                        label: config.metric || 'Value',
                        data: data.data,
                        backgroundColor: colors,
                        borderRadius: 4,
                    },
                ],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#8899aa' },
                    },
                    y: { grid: { display: false }, ticks: { color: '#8899aa' } },
                },
            },
        });
    }

    // ── 4. Line ──
    function render_line(container, data, config) {
        const canvas = _makeCanvas(container);
        const colors = getColors(config.colorScheme, data.datasets ? data.datasets.length : 1);
        const datasets = data.datasets
            ? data.datasets.map((ds, i) => ({
                  ...ds,
                  borderColor: colors[i],
                  backgroundColor: 'transparent',
                  tension: 0.3,
                  pointRadius: 4,
                  pointBackgroundColor: colors[i],
              }))
            : [
                  {
                      label: 'Value',
                      data: data.data,
                      borderColor: colors[0],
                      backgroundColor: 'transparent',
                      tension: 0.3,
                      pointRadius: 4,
                  },
              ];
        return new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels: data.labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#8899aa' } } },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#8899aa' },
                    },
                    x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8899aa' } },
                },
            },
        });
    }

    // ── 5. Area ──
    function render_area(container, data, config) {
        const canvas = _makeCanvas(container);
        const colors = getColors(config.colorScheme, data.datasets ? data.datasets.length : 1);
        const datasets = data.datasets
            ? data.datasets.map((ds, i) => ({
                  ...ds,
                  borderColor: colors[i],
                  backgroundColor: colors[i] + '33',
                  fill: true,
                  tension: 0.3,
              }))
            : [
                  {
                      label: 'Value',
                      data: data.data,
                      borderColor: colors[0],
                      backgroundColor: colors[0] + '33',
                      fill: true,
                      tension: 0.3,
                  },
              ];
        return new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels: data.labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#8899aa' } } },
                scales: {
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#8899aa' },
                    },
                    x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8899aa' } },
                },
            },
        });
    }

    // ── 6. Radar ──
    function render_radar(container, data, config) {
        const canvas = _makeCanvas(container);
        const colors = getColors(config.colorScheme, data.datasets ? data.datasets.length : 1);
        const datasets = data.datasets
            ? data.datasets.map((ds, i) => ({
                  ...ds,
                  borderColor: colors[i],
                  backgroundColor: colors[i] + '30',
                  pointBackgroundColor: colors[i],
                  borderWidth: 2,
              }))
            : [
                  {
                      label: 'Value',
                      data: data.data,
                      borderColor: colors[0],
                      backgroundColor: colors[0] + '30',
                      borderWidth: 2,
                  },
              ];
        return new Chart(canvas.getContext('2d'), {
            type: 'radar',
            data: { labels: data.labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#8899aa' } } },
                scales: {
                    r: {
                        beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        angleLines: { color: 'rgba(255,255,255,0.06)' },
                        pointLabels: { color: '#8899aa', font: { size: 11 } },
                        ticks: { color: '#666', backdropColor: 'transparent' },
                    },
                },
            },
        });
    }

    // ── 7. Doughnut ──
    function render_doughnut(container, data, config) {
        const canvas = _makeCanvas(container);
        const colors = getColors(config.colorScheme, data.labels.length);
        return new Chart(canvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: data.labels,
                datasets: [{ data: data.data, backgroundColor: colors, borderWidth: 0 }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '55%',
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { color: '#8899aa', padding: 12, font: { size: 11 } },
                    },
                },
            },
        });
    }

    // ── 8. Gauge ──
    function render_gauge(container, data, config) {
        container.innerHTML =
            '<div class="rb-gauge-wrap"><div class="rb-chart-wrap" style="height:200px"><canvas></canvas></div><div class="rb-gauge-center"><div class="rb-gauge-value" style="color:' +
            (cfColor(data.data[0], config.cfPreset) ||
                (CT.SEMANTIC ? CT.SEMANTIC.accent : '#7C6CFF')) +
            '">' +
            Math.round(data.data[0]) +
            '%</div><div class="rb-gauge-label">' +
            esc(data.labels[0] || '') +
            '</div></div></div>';
        const canvas = container.querySelector('canvas');
        const val = data.data[0],
            remainder = 100 - val;
        const col = cfColor(val, config.cfPreset) || getColors(config.colorScheme, 1)[0];
        return new Chart(canvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                datasets: [
                    {
                        data: [val, remainder],
                        backgroundColor: [col, 'rgba(255,255,255,0.06)'],
                        borderWidth: 0,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                rotation: -90,
                circumference: 180,
                cutout: '75%',
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
            },
        });
    }

    // ── 9. Scatter ──
    function render_scatter(container, data, config) {
        const canvas = _makeCanvas(container);
        const colors = getColors(config.colorScheme, data.points ? data.points.length : 0);
        const points = data.points || [];
        return new Chart(canvas.getContext('2d'), {
            type: 'scatter',
            data: {
                datasets: [
                    {
                        data: points.map((p) => ({ x: p.x, y: p.y })),
                        backgroundColor: colors,
                        pointRadius: 8,
                        pointHoverRadius: 11,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const p = points[ctx.dataIndex];
                                return p ? p.label + ' (' + p.x + ', ' + p.y + ')' : '';
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        min: 0,
                        max: 4,
                        title: { display: true, text: 'Performance', color: '#8899aa' },
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#8899aa' },
                    },
                    y: {
                        min: 0,
                        max: 4,
                        title: { display: true, text: 'Potential', color: '#8899aa' },
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#8899aa' },
                    },
                },
            },
        });
    }

    // ── 10. Heatmap (HTML) ──
    function render_heatmap(container, data, config) {
        if (!data.rows || !data.cols) {
            container.innerHTML =
                '<div class="rb-error">Heatmap requires a secondary dimension (dimension2).</div>';
            return null;
        }
        const maxVal = Math.max(...data.cells.flat(), 1);
        let html = '<table class="rb-heatmap"><thead><tr><th></th>';
        data.cols.forEach((c) => (html += '<th>' + esc(c) + '</th>'));
        html += '</tr></thead><tbody>';
        data.rows.forEach((r, ri) => {
            html += '<tr><td class="label-cell">' + esc(r) + '</td>';
            data.cols.forEach((c, ci) => {
                const v = data.cells[ri][ci];
                const pct = v / maxVal;
                const col = cfColor(v, config.cfPreset) || _heatColor(pct, config.colorScheme);
                html +=
                    '<td style="background:' +
                    col +
                    '22;color:' +
                    col +
                    '">' +
                    (v !== null ? v.toFixed(1) : '—') +
                    '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
        return null;
    }

    // ── 11. Table (HTML) ──
    function render_table(container, data, config) {
        if (!data.rows || !data.rows.length) {
            container.innerHTML = '<div class="rb-error">No data available</div>';
            return null;
        }
        const cols = data.columns || Object.keys(data.rows[0]);
        let html = '<table class="rb-data-table"><thead><tr>';
        cols.forEach((c) => (html += '<th>' + esc(c) + '</th>'));
        html += '</tr></thead><tbody>';
        data.rows.forEach((row) => {
            html += '<tr>';
            cols.forEach((c) => {
                const v = row[c];
                const badge = typeof v === 'number' ? cfBadge(v, config.cfPreset) : '';
                html +=
                    '<td>' +
                    (v !== null && v !== undefined ? esc(v) : '—') +
                    (badge ? ' ' + badge : '') +
                    '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
        return null;
    }

    // ── 12. KPI Cards (HTML) ──
    function render_kpi(container, data, config) {
        let html = '<div class="rb-kpi-grid">';
        (data.items || []).forEach((item) => {
            const col = cfColor(item.value, config.cfPreset) || getColors(config.colorScheme, 1)[0];
            html +=
                '<div class="rb-kpi-card"><div class="rb-kpi-value" style="color:' +
                col +
                '">' +
                esc(item.display) +
                '</div><div class="rb-kpi-label">' +
                esc(item.label) +
                '</div></div>';
        });
        html += '</div>';
        container.innerHTML = html;
        return null;
    }

    // ── 13. Progress Bars (HTML) ──
    function render_progress(container, data, config) {
        let html = '';
        (data.labels || []).forEach((label, i) => {
            const v = data.data[i];
            const col =
                cfColor(v, config.cfPreset) || getColors(config.colorScheme, data.labels.length)[i];
            html +=
                '<div class="rb-progress-row"><div class="rb-prog-label">' +
                esc(label) +
                '</div><div class="rb-prog-bar"><div class="rb-prog-fill" style="width:' +
                Math.min(v, 100) +
                '%;background:' +
                col +
                '"><span class="rb-prog-value">' +
                Math.round(v) +
                '%</span></div></div></div>';
        });
        container.innerHTML = html;
        return null;
    }

    // ── Helpers ──
    function _makeCanvas(container) {
        container.innerHTML = '<div class="rb-chart-wrap"><canvas></canvas></div>';
        return container.querySelector('canvas');
    }

    function _heatColor(pct, scheme) {
        const scale = PALETTES.heatscale;
        const idx = Math.min(Math.floor(pct * (scale.length - 1)), scale.length - 1);
        return scale[idx];
    }

    // Public API
    return {
        render_bar,
        render_stackedBar,
        render_horizontalBar,
        render_line,
        render_area,
        render_radar,
        render_doughnut,
        render_gauge,
        render_scatter,
        render_heatmap,
        render_table,
        render_kpi,
        render_progress,
        getColors,
        cfColor,
        cfBadge,
        PALETTES,
    };
})();
