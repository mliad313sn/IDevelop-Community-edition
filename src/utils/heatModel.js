'use strict';
/**
 * heatModel — the data contract of every heatmap. Pure: the builders below
 * turn aggregates into the model that views/partials/viz/heat.ejs renders,
 * and nothing else decides a colour, a mask or an order.
 *
 * Kinds
 *   attain    demonstrated ÷ required (summed levels), DIVERGING around 100 %
 *   deficit   required − demonstrated, in levels (mean over the measured rows)
 *   coverage  people at the required level ÷ people ASSESSED (an unassessed
 *             holder is never a gap), printed as counts « a of r »
 *
 * Rules (the same for every kind)
 *   - nothing measured ⇒ state 'unmeasured': no value, no bin — hatched, never 0;
 *   - fewer than 5 people behind a % ⇒ state 'masked' (« < 5 »): no value, no
 *     colour, no link; a line holding exactly one masked cell gets its smallest
 *     other cell masked too, so the hidden value cannot be worked out from the
 *     line total (complementary suppression);
 *   - units with fewer than 5 measured people are POOLED into one « Others »
 *     column computed on the pooled people (attain / deficit);
 *   - the marginals (« Overall » column, « All … » row) are population
 *     aggregates, never a mean of cells;
 *   - rows and columns are ordered worst first, ties by the larger n;
 *   - colour and ▼ are decided on the value the cell PRINTS (displayedValue).
 *
 * Model
 *   { kind, cols:[{key,label,none,pooled,n,marg}], rows:[{key,label,marg,cells}],
 *     total, flat, restRows, binsPresent, hasMasked, hasUnmeasured, hasBelow,
 *     layout: 'grid' (>= 3 columns) | 'list', topRows? }
 *   cell = { state: 'ok'|'masked'|'unmeasured'|'na', value, bin, below, n,
 *            actual?, required?, available?, measured?, href? }
 */
const HB = require('./heatBins');
const { displayedValue } = require('./displayedValue');

const HEAT_MIN_N = 5;
const HEAT_COVERAGE_ROWS = 10;
const FLAT_GRID = 10;
const FLAT_LIST = 30;

const isNum = (v) =>
    v !== null &&
    v !== undefined &&
    v !== '' &&
    typeof v !== 'boolean' &&
    Number.isFinite(Number(v));

const byLabel = (a, b) => String(a || '').localeCompare(String(b || ''), 'fr');

/** One heat cell from summed levels: attain = Σdemonstrated ÷ Σrequired, deficit = mean gap. */
function heatCellOf(kind, x) {
    if (!x) return { state: 'na' };
    if (!x.measured || !isNum(x.sumRequired) || Number(x.sumRequired) <= 0)
        return { state: 'unmeasured', n: x.n || 0 };
    if ((x.n || 0) < HEAT_MIN_N) return { state: 'masked', n: null };
    const actual = displayedValue(Number(x.sumActual) / x.measured, 'level');
    const required = displayedValue(Number(x.sumRequired) / x.measured, 'level');
    // the deficit is decided on the same one-decimal levels the cell prints
    const value =
        kind === 'deficit'
            ? displayedValue(Math.max(0, required - actual), 'level')
            : Number(x.sumActual) / Number(x.sumRequired);
    const shown = kind === 'attain' ? displayedValue(value, 'ratio') : value;
    return {
        state: 'ok',
        value,
        actual,
        required,
        n: x.n,
        bin: HB.binOf(kind, shown),
        below: HB.belowMark(kind, shown),
    };
}

/** Sum two summed-level records (disjoint people: n is additive). */
function heatAdd(a, b) {
    if (!a) return b ? { ...b } : null;
    if (!b) return { ...a };
    const s = (p, q) => (isNum(p) || isNum(q) ? (Number(p) || 0) + (Number(q) || 0) : null);
    return {
        sumActual: s(a.sumActual, b.sumActual),
        sumRequired: s(a.sumRequired, b.sumRequired),
        measured: (a.measured || 0) + (b.measured || 0),
        n: (a.n || 0) + (b.n || 0),
    };
}

/**
 * Complementary suppression: a line (row or column) with exactly ONE masked
 * cell gets its smallest other measured cell masked too. Iterates until
 * stable. Mutates the matrix.
 */
function heatComplement(matrix) {
    const line = (cells) => {
        const masked = cells.filter((c) => c && c.state === 'masked');
        if (masked.length !== 1) return false;
        const ok = cells.filter((c) => c && c.state === 'ok').sort((a, b) => a.n - b.n);
        if (!ok.length) return false;
        for (const k of ['value', 'bin', 'below', 'actual', 'required', 'href']) delete ok[0][k];
        ok[0].state = 'masked';
        ok[0].complementary = true;
        ok[0].n = null;
        return true;
    };
    const R = matrix.length;
    const C = R ? matrix[0].length : 0;
    for (let pass = 0; pass < 6; pass++) {
        let changed = false;
        for (let i = 0; i < R; i++) if (line(matrix[i])) changed = true;
        for (let j = 0; j < C; j++) if (line(matrix.map((r) => r[j]))) changed = true;
        if (!changed) break;
    }
}

/** Worst-first comparator on a marginal: attain / coverage ascending, deficit descending. */
function heatWorstFirst(kind) {
    return (a, b) => {
        const va = a.marg && a.marg.state === 'ok' ? a.marg.value : null;
        const vb = b.marg && b.marg.state === 'ok' ? b.marg.value : null;
        if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
        if (va !== null && va !== vb) return kind === 'deficit' ? vb - va : va - vb;
        const na = (a.marg && a.marg.n) || 0;
        const nb = (b.marg && b.marg.n) || 0;
        if (na !== nb) return nb - na;
        return byLabel(a.label, b.label);
    };
}

/**
 * The list beside or instead of the grid: on a grid (the phone view) the 10
 * measured cells furthest behind; when the list IS the view (< 3 columns)
 * every measured cell then the unmeasured ones — an unmeasured cell stays
 * visible, said in words, never dropped and never coloured.
 */
function heatFlat(flat, rows, cols, layout) {
    if (layout === 'grid') return flat.slice(0, FLAT_GRID);
    const um = [];
    rows.forEach((r) =>
        r.cells.forEach((c, j) => {
            if (c.state === 'unmeasured')
                um.push({
                    row: r.label,
                    col: cols[j].label,
                    pooled: !!cols[j].pooled,
                    none: cols[j].none,
                    ...c,
                });
        })
    );
    return flat.concat(um).slice(0, FLAT_LIST);
}

function binsOf(rows, cols, total) {
    const present = new Set();
    const note = (c) => c && c.bin && present.add(c.bin);
    rows.forEach((r) => {
        note(r.marg);
        r.cells.forEach(note);
    });
    cols.forEach((c) => note(c.marg));
    note(total);
    return [...present];
}

/**
 * heatModel(rows, opts) — axis (pillar, sub-domain…) × unit (site,
 * department…) from a cube of summed levels. Pure.
 *   rows   [{ part: 'cell'|'unit'|'axis'|'total', unitKey, unitName, key, label,
 *             sumActual, sumRequired, measured, n }]
 *   opts.kind       'attain' | 'deficit'
 *   opts.unitLabel  (unitKey, unitName) → label (null for 'none')
 *   opts.maxRows    keep the N worst measured rows, count the rest
 *   opts.hrefOf     (unitKey, axisKey) → an aggregate page | null
 */
function heatModel(rows, opts = {}) {
    const kind = opts.kind === 'deficit' ? 'deficit' : 'attain';
    const cell = new Map();
    const unitTot = new Map();
    const axisTot = new Map();
    const unitNames = new Map();
    const axisLabels = new Map();
    let total = null;
    for (const r of rows || []) {
        if (r.part === 'cell') {
            cell.set(String(r.unitKey) + '|' + String(r.key), r);
            if (!axisLabels.has(String(r.key))) axisLabels.set(String(r.key), r.label);
            if (!unitNames.has(String(r.unitKey))) unitNames.set(String(r.unitKey), r.unitName);
        } else if (r.part === 'unit') unitTot.set(String(r.unitKey), r);
        else if (r.part === 'axis') axisTot.set(String(r.key), r);
        else if (r.part === 'total') total = r;
    }
    const keys = [...axisLabels.keys()];
    const units = [...unitTot.keys()];
    if (!keys.length || !units.length)
        return { kind, cols: [], rows: [], flat: [], layout: 'list', empty: true };
    const labelOf = (u) =>
        opts.unitLabel ? opts.unitLabel(u, unitNames.get(u) || null) : unitNames.get(u) || null;
    // pooled: fewer than 5 measured people, or no measured cell with n >= 5
    const pooled = units.filter((u) => {
        const t = unitTot.get(u);
        if (!t || (t.n || 0) < HEAT_MIN_N) return true;
        return !keys.some((k) => {
            const c = cell.get(u + '|' + k);
            return c && c.measured && (c.n || 0) >= HEAT_MIN_N;
        });
    });
    const shown = units.filter((u) => !pooled.includes(u));
    const cols = shown.map((u) => ({
        key: u,
        label: labelOf(u),
        none: u === 'none',
        pooled: null,
        n: (unitTot.get(u) || {}).n || 0,
        src: [u],
    }));
    if (pooled.length)
        cols.push({
            key: 'pooled',
            label: null,
            none: false,
            pooled: pooled.map((u) => labelOf(u)),
            n: pooled.reduce((s, u) => s + ((unitTot.get(u) || {}).n || 0), 0),
            src: pooled,
        });
    const matrix = keys.map((k) =>
        cols.map((c) => {
            let acc = null;
            for (const u of c.src) acc = heatAdd(acc, cell.get(u + '|' + k) || null);
            return heatCellOf(kind, acc);
        })
    );
    heatComplement(matrix);
    for (const c of cols) {
        let acc = null;
        for (const u of c.src) acc = heatAdd(acc, unitTot.get(u) || null);
        c.marg = heatCellOf(kind, acc);
    }
    let outRows = keys.map((k, i) => ({
        key: k,
        label: axisLabels.get(k),
        marg: heatCellOf(kind, axisTot.get(k) || null),
        cells: matrix[i],
    }));
    outRows.sort(heatWorstFirst(kind));
    let restRows = 0;
    if (opts.maxRows && outRows.length > opts.maxRows) {
        const measured = outRows.filter((r) => r.marg.state === 'ok');
        restRows = outRows.length - Math.min(measured.length, opts.maxRows);
        outRows = measured.slice(0, opts.maxRows);
    }
    // columns worst first, the pooled column last
    const order = cols
        .map((c, j) => ({ ...c, j }))
        .sort((a, b) => (a.pooled || b.pooled ? (a.pooled ? 1 : -1) : heatWorstFirst(kind)(a, b)));
    const colsOut = order.map(({ src: _src, j: _j, ...c }) => c);
    outRows = outRows.map((r) => ({
        ...r,
        cells: order.map((c) => {
            const x = r.cells[c.j];
            if (x.state === 'ok' && opts.hrefOf && !c.pooled && c.key !== 'none') {
                const href = opts.hrefOf(c.key, r.key);
                if (href) return { ...x, href };
            }
            return x;
        }),
    }));
    const flat = [];
    outRows.forEach((r) =>
        r.cells.forEach((c, j) => {
            if (c.state === 'ok')
                flat.push({
                    row: r.label,
                    col: colsOut[j].label,
                    pooled: !!colsOut[j].pooled,
                    none: colsOut[j].none,
                    ...c,
                });
        })
    );
    flat.sort((a, b) => (kind === 'deficit' ? b.value - a.value : a.value - b.value));
    const totalCell = heatCellOf(kind, total);
    const layout = colsOut.length >= 3 ? 'grid' : 'list';
    return {
        kind,
        cols: colsOut,
        rows: outRows,
        total: totalCell,
        flat: heatFlat(flat, outRows, colsOut, layout),
        restRows,
        binsPresent: binsOf(outRows, colsOut, totalCell),
        hasMasked: outRows.some((r) => r.cells.some((c) => c.state === 'masked')),
        hasUnmeasured: outRows.some((r) => r.cells.some((c) => c.state === 'unmeasured')),
        hasBelow: outRows.some((r) => r.cells.some((c) => c.below)),
        layout,
    };
}

/**
 * coverageHeatModel(cov, opts) — the critical-skill × site coverage of
 * KpiService.criticalSkillCoverage in the same contract, kind 'coverage':
 * value = at level ÷ ASSESSED (an unassessed holder is never counted as a
 * gap), printed as counts « a of r ». Counts may be shown at any n (no %
 * printed in the cell, the data table's % follows the small-n rule).
 *   opts.hrefOf (site, row) → an aggregate page | null
 *   opts.layout 'grid' | 'list' (default: grid from 3 columns)
 */
function coverageHeatModel(cov, opts = {}) {
    if (!cov || cov.emptyScope) return cov || null;
    const hrefOf = opts.hrefOf || null;
    const sites = cov.sites || [];
    const mk = (req, mea, ava) => {
        if (!req) return { state: 'na' };
        if (!mea) return { state: 'unmeasured', required: req };
        const value = ava / mea;
        return {
            state: 'ok',
            value,
            available: ava,
            measured: mea,
            required: req,
            n: mea,
            // the cell prints counts, so the exact count ratio is what is shown
            bin: HB.binOf('coverage', value),
            below: HB.belowMark('coverage', value),
        };
    };
    const colAcc = sites.map(() => ({ r: 0, m: 0, a: 0 }));
    const tot = { r: 0, m: 0, a: 0 };
    let rows = (cov.rows || []).map((row) => {
        const acc = { r: 0, m: 0, a: 0 };
        const cells = (row.cells || []).map((c, j) => {
            if (!c) return { state: 'na' };
            for (const o of [acc, colAcc[j], tot]) {
                o.r += c.required;
                o.m += c.measured;
                o.a += c.available;
            }
            const x = mk(c.required, c.measured, c.available);
            if (x.state === 'ok' && hrefOf) {
                const href = hrefOf(sites[j], row);
                if (href) x.href = href;
            }
            return x;
        });
        return {
            key: String(row.skillId),
            label: row.skillName || '#' + row.skillId,
            marg: mk(acc.r, acc.m, acc.a),
            cells,
        };
    });
    let cols = sites.map((st, j) => ({
        key: st.siteKey,
        label: st.noSite ? null : st.siteName,
        none: !!st.noSite,
        pooled: null,
        marg: mk(colAcc[j].r, colAcc[j].m, colAcc[j].a),
    }));
    // fully unmeasured rows are counted, not drawn
    const unmeasuredRows = rows.filter((r) => r.marg.state !== 'ok').length;
    rows = rows.filter((r) => r.marg.state === 'ok');
    rows.sort(heatWorstFirst('coverage'));
    const order = cols.map((c, j) => ({ ...c, j })).sort(heatWorstFirst('coverage'));
    cols = order.map(({ j: _j, ...c }) => c);
    rows = rows.map((r) => ({ ...r, cells: order.map((c) => r.cells[c.j]) }));
    const totalCell = mk(tot.r, tot.m, tot.a);
    const flat = [];
    rows.forEach((r) =>
        r.cells.forEach((c, j) => {
            if (c.state === 'ok')
                flat.push({ row: r.label, col: cols[j].label, none: cols[j].none, ...c });
        })
    );
    flat.sort((a, b) => a.value - b.value);
    const layout = opts.layout || (cols.length >= 3 ? 'grid' : 'list');
    return {
        kind: 'coverage',
        cols,
        rows,
        total: totalCell,
        flat: heatFlat(flat, rows, cols, layout),
        topRows: HEAT_COVERAGE_ROWS,
        restRows: 0,
        unmeasuredRows,
        binsPresent: binsOf(rows, cols, totalCell),
        hasMasked: false,
        hasUnmeasured: rows.some((r) => r.cells.some((c) => c.state === 'unmeasured')),
        hasBelow: rows.some((r) => r.cells.some((c) => c.below)),
        layout,
    };
}

module.exports = {
    HEAT_MIN_N,
    heatCellOf,
    heatAdd,
    heatComplement,
    heatWorstFirst,
    heatFlat,
    heatModel,
    coverageHeatModel,
};
