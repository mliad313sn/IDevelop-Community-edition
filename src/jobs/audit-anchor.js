'use strict';

/**
 * audit-anchor — nightly export of the audit hash-chain HEAD (3.23.18, S-06).
 *
 * system_logs is hash-chained (row_hash = sha256(prev_hash || payload), migration
 * 30). A chain only proves integrity against a reference that lives OUTSIDE the
 * database: someone with enough DB rights could rewrite the tail and recompute
 * every hash after it. Once a day this appends the current head — id, row_hash,
 * created_at — to %ProgramData%\IDevelop\audit-anchors\chain-head.log, one JSON
 * line per day. To verify later: the row with that id must still carry that
 * row_hash; if it does not, the chain was rewritten after the anchor was taken.
 *
 *   - append-only file, never truncated or rotated by the app;
 *   - folder ACL restricted to SYSTEM + Administrators (+ OWNER RIGHTS, so the
 *     service account that created it can keep appending) — the installer
 *     re-applies the same rule on every run;
 *   - idempotent per day (the day's line is written once);
 *   - an EMPTY chain writes nothing (absence of a head is not a head);
 *   - AUDIT_ANCHOR_DIR overrides the folder; AUDIT_ANCHOR_HOUR (default 1) gates
 *     the hour, like db-backup.
 *
 * Registered in src/jobs/index.js TICKS (hourly, self-gated to once a day).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const FILE_NAME = 'chain-head.log';
const _hour = Number(String(process.env.AUDIT_ANCHOR_HOUR ?? '').trim() || NaN);
const ENV_HOUR = Number.isInteger(_hour) && _hour >= 0 && _hour <= 23 ? _hour : 1;

/** Folder for the anchor log (created on demand). */
function anchorDir(env = process.env) {
    if (env.AUDIT_ANCHOR_DIR) return env.AUDIT_ANCHOR_DIR;
    if (env.ProgramData) return path.join(env.ProgramData, 'IDevelop', 'audit-anchors');
    return path.join(process.cwd(), 'data', 'audit-anchors');
}

/** Best-effort ACL restriction of a freshly created folder. Never throws. */
function restrictDirAcl(dir, platform = process.platform) {
    if (platform !== 'win32') {
        try {
            fs.chmodSync(dir, 0o700);
        } catch (_) {
            /* best effort */
        }
        return Promise.resolve();
    }
    const args = [
        dir,
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F',
        '*S-1-3-4:(OI)(CI)F',
    ];
    return new Promise((resolve) => {
        try {
            execFile('icacls.exe', args, { windowsHide: true, timeout: 60 * 1000 }, () =>
                resolve()
            );
        } catch (_) {
            resolve();
        }
    });
}

/** The day ('YYYY-MM-DD', local) of the last line in the log, or null. */
function lastAnchorDay(file) {
    let txt;
    try {
        txt = fs.readFileSync(file, 'utf8');
    } catch (_) {
        return null;
    }
    const lines = txt.split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const o = JSON.parse(lines[i]);
            if (o && typeof o.day === 'string') return o.day;
        } catch (_) {
            /* a hand-edited line: keep looking */
        }
    }
    return null;
}

function localDay(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * @param {{force?:boolean, now?:Date, env?:object, db?:object}} [opts]
 * @returns {Promise<{done:boolean, skipped?:string, file?:string, head?:object}>}
 */
async function tick({ force = false, now = new Date(), env = process.env, db = null } = {}) {
    const database = db || require('../config/database');
    if (!force && now.getHours() < ENV_HOUR) return { done: false, skipped: 'before_hour' };
    const dir = anchorDir(env);
    const file = path.join(dir, FILE_NAME);
    const day = localDay(now);
    if (!force && lastAnchorDay(file) === day) return { done: false, skipped: 'already_today' };

    const head = await database.get(
        'SELECT id, row_hash, created_at FROM system_logs WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1'
    );
    if (!head || head.id == null) return { done: false, skipped: 'empty_chain' };

    const existed = fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    if (!existed) await restrictDirAcl(dir);

    const createdAt =
        head.createdAt instanceof Date
            ? head.createdAt.toISOString()
            : head.createdAt != null
              ? String(head.createdAt)
              : null;
    const line = {
        day,
        anchoredAt: now.toISOString(),
        table: 'system_logs',
        id: Number(head.id),
        rowHash: head.rowHash,
        createdAt,
    };
    fs.appendFileSync(file, JSON.stringify(line) + '\n', { encoding: 'utf8' });
    return { done: true, file, head: line };
}

module.exports = { tick, anchorDir, lastAnchorDay, FILE_NAME };
