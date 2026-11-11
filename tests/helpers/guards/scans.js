'use strict';
/**
 * Guard tests — the static scans behind the c334-GUARD-* suites
 * (deterministic, repo-relative). Each function returns plain data; the
 * suites decide what is a failure.
 */
const path = require('path');
const R = require('./repo');
const { rewriteIdentifiers } = require(path.join(R.REPO, 'src', 'database', 'PostgresDatabase.js'));

const _cache = {};
function texts(kind) {
    if (_cache[kind]) return _cache[kind];
    const files = kind === 'src' ? R.srcFiles() : kind === 'views' ? R.viewFiles() : R.pubFiles();
    return (_cache[kind] = files.map((f) => ({ f, rel: R.rel(f), text: R.read(f) })));
}

/** the SQL-looking literals of every src/ file, after the compat rewrite (parsed once) */
let _sqlCache = null;
function srcSql() {
    if (_sqlCache) return _sqlCache;
    _sqlCache = texts('src').map((x) => ({
        ...x,
        sql: R.sqlLiterals(x.text).map((lit) => {
            let sql;
            try {
                sql = rewriteIdentifiers(lit.sql);
            } catch {
                sql = lit.sql;
            }
            return { ...lit, rewritten: sql };
        }),
    }));
    return _sqlCache;
}

/** identifier token → number of occurrences in a text (a word count without one regex per word) */
function tokenCounts(text) {
    const m = new Map();
    for (const t of text.match(/[A-Za-z_$][\w$]*/g) || []) m.set(t, (m.get(t) || 0) + 1);
    return m;
}

/** tables named by FROM/JOIN/UPDATE/INTO in one SQL string (after the compat rewrite) */
function sqlTables(sql, T) {
    return [
        ...new Set(
            [...sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?([a-z_]\w*)"?/gi)]
                .map((m) => m[1].toLowerCase())
                .filter((t) => T[t])
        ),
    ];
}

/**
 * G1 — every `col = 'x' | col IN ('a','b') | col <> 'x'` and INSERT … VALUES literal in
 * src/ SQL whose column is enum/CHECK-constrained in one of the statement's tables, and
 * whose literal belongs to no candidate table's set.
 *   → [{ file, line, col, literal, tables, allowed }]
 */
function enumLiteralMismatches(schema) {
    const sets = schema.valueSets();
    const T = schema.tables;
    const out = [];
    for (const { rel, text } of texts('src')) {
        for (const lit of R.sqlLiterals(text)) {
            let sql;
            try {
                sql = rewriteIdentifiers(lit.sql);
            } catch {
                sql = lit.sql;
            }
            const tables = sqlTables(sql, T);
            for (const m of sql.matchAll(
                /(?:^|[\s(,.])"?([a-z_]\w*)"?(?:::text)?\s*(?:=|<>|!=|IN|NOT\s+IN)\s*\(?\s*('(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*)/gi
            )) {
                const col = m[1].toLowerCase();
                const vals = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]);
                const cands = tables.filter((t) => sets[t] && sets[t][col]);
                if (!cands.length) continue;
                for (const v of vals) {
                    if (cands.some((t) => sets[t][col].has(v))) continue;
                    out.push({
                        file: rel,
                        line: lit.line,
                        col,
                        literal: v,
                        tables: cands,
                        allowed: [...new Set(cands.flatMap((t) => [...sets[t][col]]))],
                    });
                }
            }
            for (const m of sql.matchAll(
                /INSERT\s+INTO\s+"?([a-z_]\w*)"?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/gi
            )) {
                const tn = m[1].toLowerCase();
                if (!sets[tn]) continue;
                const cols = m[2].split(',').map((s) => s.replace(/["\s]/g, '').toLowerCase());
                const vals = m[3].split(',').map((s) => s.trim());
                cols.forEach((cn, i) => {
                    const v = vals[i];
                    if (!v || !sets[tn][cn]) return;
                    const lm = v.match(/^'((?:[^']|'')*)'(?:::\w+)?$/);
                    if (!lm || sets[tn][cn].has(lm[1])) return;
                    out.push({
                        file: rel,
                        line: lit.line,
                        col: cn,
                        literal: lm[1],
                        tables: [tn],
                        allowed: [...sets[tn][cn]],
                    });
                });
            }
        }
    }
    return out;
}

const ENUMISH =
    /(^|_)(status|state|kind|category|type|tone|severity|decision|channel|outcome|method|mode|source|visibility|result|scope_type|entity_type|change_type|action|stage|band|box|placement|trigger|reason_code|priority|frequency|audience|role)$/i;

/**
 * G5 — text columns that look like an enum (ENUMISH name) with NO enum type and NO
 * single-column CHECK IN-list, and the distinct literals the code WRITES to them
 * (SQL INSERT … VALUES / UPDATE … SET with table context, and JS `col: 'x'` object keys
 * inside a file that names the table). → [{ table, col, literals:[…] }]
 */
function unconstrainedEnumColumns(schema) {
    const sets = schema.valueSets();
    const T = schema.tables;
    const out = [];
    const src = srcSql().map((x) => ({
        ...x,
        sql: x.sql.map((lit) => ({ ...lit, tables: sqlTables(lit.rewritten, T) })),
    }));
    for (const [tn, t] of Object.entries(T)) {
        for (const [cn, c] of Object.entries(t.columns)) {
            if (!ENUMISH.test(cn) || !/^(text|character varying)$/.test(c.type)) continue;
            if (sets[tn] && sets[tn][cn]) continue;
            const literals = new Set();
            const camel = R.snakeToCamel(cn);
            const keyRe = new RegExp(`(?<![\\w$])(?:${cn}|${camel})\\s*:\\s*'([^'\\n]*)'`, 'g');
            for (const { text, sql: lits } of src) {
                let mentions = false;
                for (const lit of lits) {
                    const sql = lit.rewritten;
                    if (!lit.tables.includes(tn)) continue;
                    mentions = true;
                    for (const m of sql.matchAll(
                        /INSERT\s+INTO\s+"?([a-z_]\w*)"?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/gi
                    )) {
                        if (m[1].toLowerCase() !== tn) continue;
                        const cols = m[2]
                            .split(',')
                            .map((s) => s.replace(/["\s]/g, '').toLowerCase());
                        const vals = m[3].split(',').map((s) => s.trim());
                        const i = cols.indexOf(cn);
                        const lm =
                            i >= 0 && vals[i] && vals[i].match(/^'((?:[^']|'')*)'(?:::\w+)?$/);
                        if (lm) literals.add(lm[1]);
                    }
                    for (const m of sql.matchAll(
                        new RegExp(`(?:SET|,)\\s*"?${cn}"?\\s*=\\s*'((?:[^']|'')*)'`, 'gi')
                    ))
                        literals.add(m[1]);
                }
                if (!mentions && !new RegExp(`(?<![\\w$])${tn}(?![\\w$])`).test(text)) continue;
                for (const m of text.matchAll(keyRe))
                    if (m[1] && !/[\s${}]/.test(m[1])) literals.add(m[1]);
            }
            // a literal equal to the column's own name is a column list ('kind', 'box'), not a value
            literals.delete(cn);
            literals.delete(camel);
            out.push({ table: tn, col: cn, literals: [...literals].sort() });
        }
    }
    return out;
}

/**
 * G4 — `.<dateCol>.toISOString()` / `new Date(x.<dateCol>).toISOString()` in src, views,
 * public, for every DATE column of the schema (snake and camel spelling).
 *   → [{ file, line, col }]
 */
function dateIsoSites(schema) {
    const cols = new Set();
    for (const { col } of schema.dateColumns()) {
        cols.add(col);
        cols.add(R.snakeToCamel(col));
    }
    const out = [];
    for (const { rel, text } of [...texts('src'), ...texts('views'), ...texts('pub')]) {
        for (const m of text.matchAll(/\.([A-Za-z_$][\w$]*)\s*\)?\s*\.toISOString\(\)/g))
            if (cols.has(m[1])) out.push({ file: rel, line: R.lineOf(text, m.index), col: m[1] });
        for (const m of text.matchAll(
            /new Date\(\s*[\w.]*\.([A-Za-z_$][\w$]*)\s*\)\s*\.toISOString\(\)/g
        ))
            if (cols.has(m[1]))
                out.push({ file: rel, line: R.lineOf(text, m.index), col: m[1], via: 'new Date' });
    }
    // de-duplicate (both regexes can hit the same site)
    const seen = new Set();
    return out.filter(
        (x) =>
            !seen.has(x.file + ':' + x.line + ':' + x.col) &&
            seen.add(x.file + ':' + x.line + ':' + x.col)
    );
}

/** G7 — Express routes (method + pattern, mount prefixes resolved) and the UI targets of views + public/js. */
function routeCoverage() {
    const src = texts('src');
    const ROUTES = [];
    const MOUNTS = {};
    for (const { f, text } of src) {
        const reqs = {};
        for (const m of text.matchAll(
            /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g
        ))
            reqs[m[1]] = m[2];
        for (const m of text.matchAll(
            /\b(?:app|router|[A-Za-z_$][\w$]*[Rr]outer)\.use\(\s*['"]([^'"]+)['"]\s*,\s*(?:[\w$.]+(?:\([^()]*\))?\s*,\s*)*(?:require\(\s*['"]([^'"]+)['"]\s*\)(?:\.\w+)?|([A-Za-z_$][\w$]*)(?:\.\w+)?)\s*,?\s*\)/g
        )) {
            const target = m[2] || reqs[m[3]];
            if (!target) continue;
            let abs;
            try {
                abs = require.resolve(path.resolve(path.dirname(f), target));
            } catch {
                continue;
            }
            (MOUNTS[abs] = MOUNTS[abs] || []).push({ prefix: m[1], from: f });
        }
    }
    const prefixesOf = (f, depth = 0) => {
        const ms = MOUNTS[f];
        if (!ms || depth > 4) return [''];
        const out = [];
        for (const m of ms)
            for (const p of prefixesOf(m.from, depth + 1))
                out.push((p + m.prefix).replace(/\/+$/, '').replace(/\/\/+/g, '/'));
        return out.length ? out : [''];
    };
    for (const { f, rel, text } of src) {
        for (const m of text.matchAll(
            /\b(?:app|[A-Za-z_$][\w$]*[Rr]outer|router|r|api|v1)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2/g
        ))
            for (const p of prefixesOf(f))
                ROUTES.push({
                    method: m[1].toUpperCase(),
                    pattern: (p + m[3]).replace(/\/\/+/g, '/') || '/',
                    where: `${rel}:${R.lineOf(text, m.index)}`,
                });
        for (const m of text.matchAll(
            /\.route\(\s*(['"`])([^'"`]+)\1\s*\)((?:\s*\.(?:get|post|put|patch|delete)\()+)/g
        ))
            for (const mm of m[3].matchAll(/\.(get|post|put|patch|delete)\(/g))
                for (const p of prefixesOf(f))
                    ROUTES.push({
                        method: mm[1].toUpperCase(),
                        pattern: (p + m[2]).replace(/\/\/+/g, '/'),
                        where: `${rel}:${R.lineOf(text, m.index)}`,
                    });
    }
    const toRegex = (pattern) => {
        let p = pattern.replace(/\/+$/, '') || '/';
        p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\\\(([^)]*)\\\)\?/g, '(?:$1)?');
        p = p
            .replace(/:[A-Za-z_]+\\\?/g, '[^/]*')
            .replace(/:[A-Za-z_]+\??/g, '[^/]+')
            .replace(/\*/g, '.*');
        return new RegExp('^' + p + '/?$');
    };
    const RX = ROUTES.map((r) => ({ ...r, rx: toRegex(r.pattern) }));
    const match = (method, url) =>
        RX.some((r) => (r.method === method || r.method === 'ALL') && r.rx.test(url));
    // a concatenated URL ('/x/' + id + '/y') is matched by its static prefix against the route patterns
    const prefixMatch = (method, url) => {
        const stem = url.split('/:x')[0].replace(/\/+$/, '');
        return RX.some(
            (r) =>
                (r.method === method || r.method === 'ALL') &&
                (r.pattern === stem || r.pattern.startsWith(stem + '/'))
        );
    };

    const targets = [];
    const norm = (u) =>
        u
            .split('?')[0]
            .split('#')[0]
            .replace(/<%[=-]?[\s\S]*?%>/g, ':x')
            .replace(/\$\{[^}]*\}/g, ':x')
            .replace(/'\s*\+\s*[^+]*\+\s*'/g, ':x')
            .replace(/'\s*\+\s*[\w.()]+$/, '/:x')
            .trim();
    for (const { rel, text } of texts('views')) {
        for (const m of text.matchAll(/<form\b([^>]*)>/g)) {
            const attrs = m[1];
            const a = (attrs.match(/\baction\s*=\s*"([^"]*)"/) ||
                attrs.match(/\baction\s*=\s*'([^']*)'/) ||
                [])[1];
            const method = (
                (attrs.match(/\bmethod\s*=\s*"([^"]*)"/) || [])[1] || 'GET'
            ).toUpperCase();
            if (!a || !a.startsWith('/')) continue;
            const u = norm(a);
            if (!u.startsWith('/')) continue;
            const ov = text
                .slice(m.index, m.index + 1200)
                .match(/name="_method"\s+value="([A-Za-z]+)"/);
            targets.push({
                method: ov ? ov[1].toUpperCase() : method,
                url: u,
                where: `${rel}:${R.lineOf(text, m.index)}`,
                kind: 'form',
            });
        }
        for (const m of text.matchAll(
            /data-(?:action|post|url|endpoint|href-post|fetch)\s*=\s*"(\/[^"]*)"/g
        ))
            targets.push({
                method: 'POST?',
                url: norm(m[1]),
                where: `${rel}:${R.lineOf(text, m.index)}`,
                kind: 'data-attr',
            });
    }
    for (const { rel, text } of [...texts('pub'), ...texts('views')]) {
        for (const m of text.matchAll(/fetch\(\s*(['"`])(\/[^'"`]*)\1\s*(?:,\s*\{([^}]*)\})?/g)) {
            const meth = ((m[3] || '').match(/method\s*:\s*['"`]([A-Za-z]+)['"`]/) || [])[1];
            targets.push({
                method: (meth || 'GET').toUpperCase(),
                url: norm(m[2]),
                where: `${rel}:${R.lineOf(text, m.index)}`,
                kind: 'fetch',
            });
        }
        for (const m of text.matchAll(/fetch\(\s*(['"`])(\/[^'"`]*)\1\s*\+/g))
            targets.push({
                method: 'GET?',
                url: norm(m[2]) + '/:x',
                where: `${rel}:${R.lineOf(text, m.index)}`,
                kind: 'fetch+',
            });
    }
    const missing = [];
    let ok = 0;
    for (const t of targets) {
        if (!t.url.startsWith('/')) continue;
        const meths = t.method.endsWith('?') ? ['POST', 'GET'] : [t.method];
        // fetch('/x/' + id) is captured twice: once as a plain fetch whose URL ends with '/' (the
        // static stem of a concatenation), once as 'fetch+' — both are prefix-matched
        const concatenated =
            t.kind === 'fetch+' ||
            /\/:x(\/|$)/.test(t.url) ||
            /\/\//.test(t.url) ||
            /\/$/.test(t.url);
        const hit =
            meths.some((mm) => match(mm, t.url)) ||
            (concatenated && meths.concat('GET').some((mm) => prefixMatch(mm, t.url)));
        if (hit) ok++;
        else missing.push(t);
    }
    return { routes: ROUTES.length, targets: targets.length, ok, missing };
}

/**
 * G8 — columns written by src (INSERT list / UPDATE SET) and read nowhere (src, views,
 * public), plus columns never referenced at all. Short or generic column names
 * (NOISE, no underscore, fewer than 5 characters) are skipped: a word count
 * cannot tell them apart from ordinary identifiers.
 *   → { deadWritten:[{table,col,writes}], neverReferenced:[{table,col}] }
 */
function deadColumns(schema) {
    const T = schema.tables;
    const src = texts('src');
    const srcJoined = src.map((x) => x.text).join('\n');
    const viewText = [...texts('views'), ...texts('pub')].map((x) => x.text).join('\n');
    const writes = {};
    for (const { rel, sql: lits } of srcSql()) {
        for (const lit of lits) {
            let sql = lit.rewritten;
            sql = sql.replace(/\$\{[^}]*\}/g, ' __X__ ');
            const where = `${rel}:${lit.line}`;
            for (const m of sql.matchAll(/INSERT\s+INTO\s+"?([a-z_]\w*)"?\s*\(([^)]*)\)/gi)) {
                const tn = m[1].toLowerCase();
                if (!T[tn]) continue;
                for (const raw of m[2].split(',')) {
                    const col = raw.replace(/["\s]/g, '');
                    if (!col || /__x__/i.test(col)) continue;
                    const c = col.toLowerCase(),
                        cs = R.camelToSnake(col);
                    const real = T[tn].columns[c] ? c : T[tn].columns[cs] ? cs : null;
                    if (real)
                        ((writes[tn] = writes[tn] || {})[real] = writes[tn][real] || []).push(
                            where
                        );
                }
            }
            for (const m of sql.matchAll(
                /UPDATE\s+"?([a-z_]\w*)"?(?:\s+(?:AS\s+)?\w+)?\s+SET\s+([\s\S]*?)(?:\sWHERE\s|\sRETURNING\s|$)/gi
            )) {
                const tn = m[1].toLowerCase();
                if (!T[tn]) continue;
                for (const am of m[2].matchAll(/(?:^|,)\s*"?([a-z_]\w*)"?\s*=/gi)) {
                    const col = am[1],
                        c = col.toLowerCase(),
                        cs = R.camelToSnake(col);
                    const real = T[tn].columns[c] ? c : T[tn].columns[cs] ? cs : null;
                    if (real)
                        ((writes[tn] = writes[tn] || {})[real] = writes[tn][real] || []).push(
                            where
                        );
                }
            }
        }
    }
    const NOISE = new Set(
        'id created_at updated_at name status state kind type note notes reason code value key title email label level score rating source version description actor payload data category date slug role site_id department_id employee_id admin_id role_id skill_id cycle_id actor_id created_by updated_by decided_by decided_at approved_by approved_at metadata reviewer_id comment comments period window target threshold severity channel subject body user_id'.split(
            ' '
        )
    );
    const srcTokens = tokenCounts(srcJoined);
    const viewTokens = tokenCounts(viewText);
    const wordCount = (counts, w) => counts.get(w) || 0;
    const deadWritten = [],
        neverReferenced = [];
    for (const [tn, t] of Object.entries(T)) {
        for (const cn of Object.keys(t.columns)) {
            if (NOISE.has(cn)) continue;
            const generic = cn.length < 5 || !/_/.test(cn);
            if (generic) continue;
            const camel = R.snakeToCamel(cn);
            const w = writes[tn] && writes[tn][cn] ? writes[tn][cn].length : 0;
            const srcReads =
                wordCount(srcTokens, cn) + (camel !== cn ? wordCount(srcTokens, camel) : 0) - w;
            const uiReads =
                wordCount(viewTokens, cn) + (camel !== cn ? wordCount(viewTokens, camel) : 0);
            if (w > 0 && srcReads <= 0 && uiReads === 0)
                deadWritten.push({ table: tn, col: cn, writes: writes[tn][cn].slice(0, 3) });
            if (w === 0 && srcReads <= 0 && uiReads === 0)
                neverReferenced.push({ table: tn, col: cn });
        }
    }
    return { deadWritten, neverReferenced };
}

/**
 * G2 (static part) — every static `__('ns:key')` / `t('ns:key')` / `req.t('ns:key')` in
 * views, src, public (template literals without `${}` included; `'ns:key'` literals passed
 * as data included when `ns` is a locale namespace). → Map key → [where]
 */
function staticLocaleKeys(FR) {
    const files = [...texts('views'), ...texts('src'), ...texts('pub')];
    const use = new Map();
    const add = (k, w) => (use.get(k) || use.set(k, []).get(k)).push(w);
    const CALL =
        /(?<![\w$.])(?:__|t|req\.t|res\.locals\.__|i18n\.t|tr)\(\s*(?:(['"])([a-zA-Z][\w-]*:[^'"]*?)\1|`([a-zA-Z][\w-]*:[^`]*?)`)\s*([,)+])/g;
    for (const { rel, text } of files) {
        for (const m of text.matchAll(CALL)) {
            const where = `${rel}:${R.lineOf(text, m.index)}`;
            if (m[3] !== undefined) {
                if (m[3].includes('${')) continue;
                add(m[3], where);
            } else if (m[4] !== '+') add(m[2], where);
        }
    }
    const NS = new Set([...FR.keys()].map((k) => k.split(':')[0]));
    for (const { rel, text } of files) {
        for (const m of text.matchAll(/['"]([a-z]+):([a-z][\w.]*)['"]/g)) {
            if (!NS.has(m[1])) continue;
            const key = m[1] + ':' + m[2];
            if (!use.has(key)) add(key, `${rel}:${R.lineOf(text, m.index)} (literal)`);
        }
    }
    for (const k of [...use.keys()]) if (/[_.]$/.test(k)) use.delete(k); // a prefix passed as data = dynamic
    return use;
}

/** G3 — every `res.render('pages/…', { layout: false …` site in src (view → [where]). */
function standaloneRenderSites() {
    const out = {};
    for (const { rel, text } of texts('src')) {
        for (const m of text.matchAll(
            /\.render\(\s*(['"`])((?:pages|partials)\/[^'"`]+)\1\s*,\s*\{[^}]{0,400}?\blayout\s*:\s*false/g
        ))
            (out[m[2]] = out[m[2]] || []).push(`${rel}:${R.lineOf(text, m.index)}`);
    }
    return out;
}

/** GLOBALS = res.locals.X / app.locals.X assigned anywhere in src + server.js */
function resLocalsGlobals() {
    const g = new Set();
    for (const { text } of texts('src')) {
        for (const m of text.matchAll(/(?:res|app)\.locals\.([A-Za-z_$][\w$]*)\s*=/g)) g.add(m[1]);
        for (const m of text.matchAll(/(?:res|app)\.locals\s*,\s*\{([^}]*)\}/g))
            for (const k of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*[:,}]|\b([A-Za-z_$][\w$]*)\s*$/g))
                g.add(k[1] || k[2]);
    }
    return g;
}

module.exports = {
    ENUMISH,
    enumLiteralMismatches,
    unconstrainedEnumColumns,
    dateIsoSites,
    routeCoverage,
    deadColumns,
    staticLocaleKeys,
    standaloneRenderSites,
    resLocalsGlobals,
};
