'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../config/database');

/**
 *   EvidenceService: receives uploaded evidence, scans it through the
 *   scanner chain (MalwareScanService: clamd, then Microsoft Defender),
 *   persists metadata in assessment_evidence, quarantines infected files.
 *
 *   Contract:
 *     accept(file, selfAssessmentId, uploaderId) ->
 *         { id, avStatus: 'clean' | 'quarantined' | 'not_scanned' | 'scan_error' }
 *
 *   The route layer must enforce: max 3 evidences per (self_assessment,
 *   skill) — that's tracked at the controller level (cheap COUNT query).
 */
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve('uploads');

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

class EvidenceService {
    static async accept({ file, selfAssessmentId, uploaderId }) {
        ensureDir(UPLOADS_DIR);

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

        // The scanner CHAIN: clamd -> Microsoft Defender -> 'not_scanned' (or
        // 'scan_error', held and re-queued, when scanning is required). The old
        // hard-wired Unix socket failed on every Windows host and left every
        // file stuck in scan_error. Never throws.
        const { avStatus } = await require('./MalwareScanService').scanAndRecord(
            'assessment_evidence',
            lastID,
            dest
        );
        return { id: lastID, avStatus };
    }
}

module.exports = EvidenceService;
