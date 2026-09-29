'use strict';

/**
 *  SQL translation helpers used by PostgresDatabase to accept V1 SQLite
 *  style query strings with minimal model changes.
 *
 *  Two transformations:
 *    1. `?`-positional placeholders → `$1, $2, …` (Postgres-native form).
 *    2. (optional) identifier rename — model code passes in a per-call
 *        map of `{ from: 'camelCase', to: 'snake_case' }` for the columns
 *        it touches; this is applied with whole-word regex replacement.
 *
 *  Quoted strings are honoured — placeholders or identifiers inside
 *  '…' or "…" strings are left untouched.
 */

function translatePlaceholders(sql) {
    let out = '';
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    let i = 0;
    let n = 1;
    while (i < sql.length) {
        const c = sql[i];
        if (inLineComment) {
            out += c;
            if (c === '\n' || c === '\r') inLineComment = false;
            i++;
            continue;
        }
        if (inBlockComment) {
            out += c;
            if (c === '*' && sql[i + 1] === '/') {
                out += '/';
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (!inSingle && !inDouble && c === '-' && sql[i + 1] === '-') {
            out += '--';
            inLineComment = true;
            i += 2;
            continue;
        }
        if (!inSingle && !inDouble && c === '/' && sql[i + 1] === '*') {
            out += '/*';
            inBlockComment = true;
            i += 2;
            continue;
        }
        if (c === "'" && !inDouble) {
            inSingle = !inSingle || sql[i - 1] === '\\';
            out += c;
            i++;
            continue;
        }
        if (c === '"' && !inSingle) {
            inDouble = !inDouble;
            out += c;
            i++;
            continue;
        }
        if (c === '?' && !inSingle && !inDouble) {
            // A `?` is a positional placeholder ONLY when it stands for a value.
            // PostgreSQL also spells three jsonb operators with it: `?` (key
            // exists), `?|` and `?&` (any/all keys). Measured: the lifecycle
            // register's `payload ? 'skipped'` was rewritten to `payload $1
            // 'skipped'` and every ?state=done|skipped request answered a
            // 42601 page. A placeholder is never immediately followed by `|`
            // or `&`, and never by a string literal (two adjacent values is
            // not SQL) — those shapes are the operator, so they pass through.
            const next = sql[i + 1];
            let j = i + 1;
            while (
                j < sql.length &&
                (sql[j] === ' ' || sql[j] === '\t' || sql[j] === '\n' || sql[j] === '\r')
            )
                j++;
            const isJsonbOperator = next === '|' || next === '&' || sql[j] === "'";
            if (isJsonbOperator) {
                out += c;
                i++;
                continue;
            }
            out += '$' + n++;
            i++;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 *  Replace whole-word identifiers using the given map.
 *  Skips occurrences inside single- or double-quoted strings.
 */
function renameIdentifiers(sql, map) {
    if (!map || Object.keys(map).length === 0) return sql;
    const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
    let out = '';
    let inSingle = false;
    let inDouble = false;
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (c === "'" && !inDouble) inSingle = !inSingle || sql[i - 1] === '\\';
        else if (c === '"' && !inSingle) inDouble = !inDouble;
        if (inSingle || inDouble) {
            out += c;
            i++;
            continue;
        }
        let matched = false;
        for (const [from, to] of entries) {
            if (sql.startsWith(from, i)) {
                const before = i === 0 ? '' : sql[i - 1];
                const after = sql[i + from.length] || '';
                const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);
                if (!isWordChar(before) && !isWordChar(after)) {
                    out += to;
                    i += from.length;
                    matched = true;
                    break;
                }
            }
        }
        if (!matched) {
            out += c;
            i++;
        }
    }
    return out;
}

/**
 *  Wrap any camelCase alias `... AS fooBar` in double quotes so PostgreSQL
 *  preserves the case (otherwise PG returns the column as `foobar`, which
 *  the V2 dashboard / report client JS doesn't understand).
 *
 *  Conservative: only triggers when (a) the keyword is exactly `AS` or
 *  `as` and (b) the alias contains at least one uppercase letter. Already-
 *  quoted aliases are skipped. Tokens inside string literals are skipped.
 */
function quoteCamelAliases(sql) {
    // Pass 1: quote `AS camelCase` (case-preserving alias).
    sql = _passQuoteAfterKeyword(sql, /\bAS\b/i, /[A-Za-z0-9_]/, true);
    // Pass 2: quote camelCase identifiers in ORDER BY / GROUP BY clauses.
    sql = _quoteInOrderGroupBy(sql);
    return sql;
}

function _passQuoteAfterKeyword(sql, keywordRe, identCharRe, requireUppercase) {
    let out = '';
    let inSingle = false,
        inDouble = false;
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        // -- line comment
        if (!inSingle && !inDouble && c === '-' && sql[i + 1] === '-') {
            const eol = sql.indexOf('\n', i);
            const stop = eol === -1 ? sql.length : eol;
            out += sql.slice(i, stop);
            i = stop;
            continue;
        }
        // /* block comment */
        if (!inSingle && !inDouble && c === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            const stop = end === -1 ? sql.length : end + 2;
            out += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (c === "'" && !inDouble) {
            inSingle = !inSingle || sql[i - 1] === '\\';
            out += c;
            i++;
            continue;
        }
        if (c === '"' && !inSingle) {
            inDouble = !inDouble;
            out += c;
            i++;
            continue;
        }
        if (!inSingle && !inDouble) {
            // try keyword match starting at i
            const rest = sql.slice(i, i + 8); // enough for AS/ORDER BY/GROUP BY etc.
            const m = rest.match(/^(AS|as|As|aS)\s/);
            if (m && (i === 0 || /\s/.test(sql[i - 1]))) {
                let j = i + m[0].length;
                while (j < sql.length && /\s/.test(sql[j])) j++;
                const startIdent = j;
                while (j < sql.length && identCharRe.test(sql[j])) j++;
                const ident = sql.slice(startIdent, j);
                if (
                    ident &&
                    (!requireUppercase || /[A-Z]/.test(ident)) &&
                    sql[startIdent - 1] !== '"'
                ) {
                    out += sql.slice(i, startIdent) + '"' + ident + '"';
                    i = j;
                    continue;
                }
            }
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * Quote camelCase identifiers in an ORDER BY / GROUP BY body, but ONLY where
 * they are bare.
 *
 * This used to be a single blanket .replace, which double-quoted anything the
 * author had already quoted: `ORDER BY "completionPct"` came out as
 * `ORDER BY ""completionPct""` and PostgreSQL raised 42601 "zero-length
 * delimited identifier". Writing the alias explicitly — the correct, obvious
 * thing to do, and what the SQL standard asks for — was therefore a syntax
 * error, while only the bare form worked. That trap cost two endpoints
 * (`team-progression` and `campaign-burndown`) when exactly that edit was made.
 *
 * Single-quoted string literals are skipped for the same reason: a camelCase
 * word inside one is data, not an identifier.
 */
function _quoteIdentsOutsideLiterals(s) {
    const CAMEL = /\b([a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*)\b(?!\s*\()/g;
    let out = '';
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        // Already-quoted identifier, or a string literal: copy through verbatim.
        if (ch === '"' || ch === "'") {
            const end = s.indexOf(ch, i + 1);
            if (end === -1) {
                out += s.slice(i);
                break;
            } // unterminated — leave as-is
            out += s.slice(i, end + 1);
            i = end + 1;
            continue;
        }
        let j = i;
        while (j < s.length && s[j] !== '"' && s[j] !== "'") j++;
        out += s.slice(i, j).replace(CAMEL, (full, ident) => `"${ident}"`);
        i = j;
    }
    return out;
}

function _quoteInOrderGroupBy(sql) {
    // Find ORDER BY ... and GROUP BY ... regions, quote camelCase identifiers
    // until the clause terminator (next clause keyword or end of statement).
    const clauseRe = /\b(ORDER\s+BY|GROUP\s+BY)\b/gi;
    const terminators =
        /\b(FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT)\b/i;
    let out = '';
    let last = 0;
    let m;
    while ((m = clauseRe.exec(sql)) !== null) {
        out += sql.slice(last, m.index + m[0].length);
        // Find end of clause
        const rest = sql.slice(m.index + m[0].length);
        // Track parens depth so we don't split inside a sub-expression
        let depth = 0,
            k = 0,
            inS = false,
            inD = false;
        for (; k < rest.length; k++) {
            const ch = rest[k];
            if (ch === "'" && !inD) inS = !inS || rest[k - 1] === '\\';
            else if (ch === '"' && !inS) inD = !inD;
            if (inS || inD) continue;
            if (ch === '(') depth++;
            else if (ch === ')') {
                if (depth === 0) break;
                depth--;
            } else if (depth === 0 && terminators.test(rest.slice(k))) {
                // check that the match is at exactly k
                const t = rest
                    .slice(k)
                    .match(
                        /^\b(FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT)\b/i
                    );
                if (t) break;
            } else if (ch === ';') break;
        }
        const clauseBody = rest.slice(0, k);
        out += _quoteIdentsOutsideLiterals(clauseBody);
        last = m.index + m[0].length + k;
        clauseRe.lastIndex = last;
    }
    out += sql.slice(last);
    return out;
}

module.exports = { translatePlaceholders, renameIdentifiers, quoteCamelAliases };
