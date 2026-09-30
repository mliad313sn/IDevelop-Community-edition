'use strict';

/**
 * CsvConnector — an HRIS export dropped as a CSV / TSV file.
 *
 * Two sources:
 *   - a server FOLDER (config.folder_path) the operator's own transfer (SFTP,
 *     a file share, a scheduled export) drops files into: the newest
 *     .csv / .tsv / .txt file is read. When HRIS_DROP_ROOT is set, the folder
 *     must sit inside it;
 *   - a file UPLOADED on /admin/integrations/hris (opts.text).
 *
 * Columns: the default headers below, or any header named in config.columns
 * ({ firstName: 'Prénom', … }). Headers are matched case-, accent- and
 * separator-insensitively. The delimiter is detected (tab, ';' or ',') unless
 * config.delimiter says otherwise.
 *
 * config.mode 'delta' means the file only carries CHANGES: a person absent
 * from it is not a leaver (only an end date or an inactive status is).
 */
const fs = require('fs');
const path = require('path');
const HrisConnector = require('./HrisConnector');

const DEFAULT_COLUMNS = {
    externalId: 'external_id',
    employeeNumber: 'employee_number',
    firstName: 'first_name',
    lastName: 'last_name',
    email: 'email',
    jobTitle: 'job_title',
    department: 'department',
    site: 'site',
    service: 'service',
    managerExternalId: 'manager_external_id',
    startDate: 'start_date',
    endDate: 'end_date',
    status: 'status',
};

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 100000;
const FILE_RE = /\.(csv|tsv|txt)$/i;

function headerKey(h) {
    return String(h == null ? '' : h)
        .replace(/^\ufeff/, '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function detectDelimiter(text, configured) {
    const c = String(configured || '').toLowerCase();
    if (c === 'tab' || c === '\\t' || c === '\t') return '\t';
    if (c === ';' || c === ',' || c === '|') return c;
    const first = String(text).split(/\r?\n/, 1)[0] || '';
    const count = (ch) => first.split(ch).length - 1;
    const tabs = count('\t');
    const semis = count(';');
    const commas = count(',');
    if (tabs > 0 && tabs >= semis && tabs >= commas) return '\t';
    return semis > commas ? ';' : ',';
}

/** RFC 4180 parser (quoted fields, doubled quotes, CRLF or LF, embedded newlines). */
function parseDelimited(text, sep) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const t = String(text);
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (inQuotes) {
            if (ch === '"') {
                if (t[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else inQuotes = false;
            } else cell += ch;
            continue;
        }
        if (ch === '"' && cell === '') inQuotes = true;
        else if (ch === sep) {
            row.push(cell);
            cell = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && t[i + 1] === '\n') i++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else cell += ch;
    }
    if (cell !== '' || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

class CsvConnector extends HrisConnector {
    get provider() {
        return 'csv';
    }

    get columns() {
        return { ...DEFAULT_COLUMNS, ...(this.config.columns || {}) };
    }

    /** Where the folder may live (HRIS_DROP_ROOT), then the newest export in it. */
    newestFile() {
        const dir = String(this.config.folder_path || '').trim();
        if (!dir) {
            const e = new Error('No drop folder is configured');
            e.code = 'hris_csv_no_folder';
            throw e;
        }
        const abs = path.resolve(dir);
        const root = process.env.HRIS_DROP_ROOT ? path.resolve(process.env.HRIS_DROP_ROOT) : null;
        if (root && abs !== root && !abs.startsWith(root + path.sep)) {
            const e = new Error('The drop folder is outside HRIS_DROP_ROOT');
            e.code = 'hris_csv_folder_outside_root';
            throw e;
        }
        let names;
        try {
            names = fs.readdirSync(abs);
        } catch {
            const e = new Error('The drop folder cannot be read');
            e.code = 'hris_csv_folder_unreadable';
            throw e;
        }
        const files = names
            .filter((n) => FILE_RE.test(n))
            .map((n) => {
                const full = path.join(abs, n);
                let st = null;
                try {
                    st = fs.statSync(full);
                } catch {
                    st = null;
                }
                return st && st.isFile()
                    ? { name: n, full, mtime: st.mtimeMs, size: st.size }
                    : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);
        if (!files.length) {
            const e = new Error('The drop folder holds no .csv / .tsv file');
            e.code = 'hris_csv_no_file';
            throw e;
        }
        return files[0];
    }

    readText() {
        if (this.opts.text != null) {
            this.sourceLabel = this.opts.fileName || 'upload';
            return String(this.opts.text);
        }
        const f = this.newestFile();
        if (f.size > MAX_BYTES) {
            const e = new Error('The export file is too large');
            e.code = 'hris_csv_too_large';
            throw e;
        }
        this.sourceLabel = f.name;
        return fs.readFileSync(f.full, 'utf8');
    }

    /** Parse the text into normalised people. Throws with a stable `.code`. */
    parse(text) {
        const raw = String(text == null ? '' : text).replace(/^\ufeff/, '');
        if (Buffer.byteLength(raw) > MAX_BYTES) {
            const e = new Error('The export file is too large');
            e.code = 'hris_csv_too_large';
            throw e;
        }
        const sep = detectDelimiter(raw, this.config.delimiter);
        const grid = parseDelimited(raw, sep);
        if (grid.length < 1) {
            const e = new Error('The export file is empty');
            e.code = 'hris_csv_empty';
            throw e;
        }
        const head = grid[0].map(headerKey);
        const idx = {};
        for (const [field, header] of Object.entries(this.columns)) {
            const i = head.indexOf(headerKey(header));
            if (i >= 0) idx[field] = i;
        }
        if (idx.externalId == null && idx.employeeNumber == null) {
            const e = new Error(
                `No identifier column: expected "${this.columns.externalId}" or "${this.columns.employeeNumber}"`
            );
            e.code = 'hris_csv_no_id_column';
            throw e;
        }
        const body = grid.slice(1);
        if (body.length > MAX_ROWS) {
            const e = new Error(`More than ${MAX_ROWS} rows`);
            e.code = 'hris_csv_too_many_rows';
            throw e;
        }
        const now = this.now();
        return body.map((r, n) => {
            const get = (f) => (idx[f] == null ? null : r[idx[f]]);
            const p = {};
            for (const f of HrisConnector.FIELDS) p[f] = get(f);
            if (!HrisConnector.str(p.externalId)) p.externalId = p.employeeNumber;
            const out = HrisConnector.normalise(p, now);
            out.row = n + 2; // spreadsheet line, header = 1
            return out;
        });
    }

    async listPeople() {
        return this.parse(this.readText());
    }

    async testConnection() {
        try {
            const people = await this.listPeople();
            return { ok: true, sample: people.length, source: this.sourceLabel || null };
        } catch (e) {
            return { ok: false, error: e.message, code: e.code || null };
        }
    }
}

CsvConnector.DEFAULT_COLUMNS = DEFAULT_COLUMNS;
CsvConnector.parseDelimited = parseDelimited;
CsvConnector.detectDelimiter = detectDelimiter;
CsvConnector.headerKey = headerKey;

module.exports = CsvConnector;
