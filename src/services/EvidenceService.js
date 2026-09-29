'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../config/database');

/**
 *   EvidenceService — receives uploaded evidence, scans with ClamAV
 *   (via `clamscan` package over the local socket), persists metadata
 *   in assessment_evidence, quarantines infected files.
 *
 *   Phase-3 contract:
 *     accept(file, selfAssessmentId, uploaderId) ->
 *         { id, avStatus: 'clean' | 'quarantined' }
 *
 *   The route layer must enforce: max 3 evidences per (self_assessment,
 *   skill) — that's tracked at the controller level (cheap COUNT query).
 */
const QUARANTINE_DIR = process.env.QUARANTINE_DIR || path.resolve('uploads', '_quarantine');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve('uploads');
const CLAMD_SOCKET = process.env.CLAMD_SOCKET || '/var/run/clamav/clamd.sock';

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

class EvidenceService {
    static async accept({ file, selfAssessmentId, uploaderId }) {
        ensureDir(UPLOADS_DIR);
        ensureDir(QUARANTINE_DIR);

        // multer leaves the file at file.path (random name in tmp/). Move
        // into uploads/, named <selfAssessmentId>-<timestamp>-<ext>.
        const ext = path.extname(file.originalname || '').slice(0, 10);
        const dest = path.join(
            UPLOADS_DIR,
            `${selfAssessmentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
        );
        fs.renameSync(file.path, dest);

        // Insert pending row
        const { lastID } = await db.run(
            `INSERT INTO assessment_evidence
                (self_assessment_id, file_uri, original_name, mime, size_bytes,
                 av_status, uploaded_by)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
            [selfAssessmentId, dest, file.originalname, file.mimetype, file.size, uploaderId]
        );

        // Scan
        let avStatus = 'clean';
        let avSignature = null;
        try {
            const ClamScan = require('clamscan');
            const scanner = await new ClamScan().init({ clamdscan: { socket: CLAMD_SOCKET } });
            const { isInfected, viruses } = await scanner.scanFile(dest);
            if (isInfected) {
                avStatus = 'quarantined';
                avSignature = (viruses || []).join(',');
                const qPath = path.join(QUARANTINE_DIR, path.basename(dest));
                fs.renameSync(dest, qPath);
                await db.run(
                    `UPDATE assessment_evidence
                     SET av_status='quarantined', av_signature=?, quarantine_uri=?,
                         scanned_at=now(), submit_locked_at=now()
                     WHERE id = ?`,
                    [avSignature, qPath, lastID]
                );
            } else {
                await db.run(
                    `UPDATE assessment_evidence SET av_status='clean', scanned_at=now() WHERE id = ?`,
                    [lastID]
                );
            }
        } catch (e) {
            avStatus = 'scan_error';
            await db.run(
                `UPDATE assessment_evidence SET av_status='scan_error', scanned_at=now() WHERE id = ?`,
                [lastID]
            );
            // Fail-closed: until the operator decides, the file is treated as untrusted.
            console.error('[evidence] clamav scan failed:', e.message);
        }

        return { id: lastID, avStatus };
    }
}

module.exports = EvidenceService;
