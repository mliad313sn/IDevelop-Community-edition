'use strict';

/**
 * PrivacyService: transparency and data-subject rights for the people whose
 * data the platform holds (migration 165; GDPR and equivalent national laws).
 *
 *   1. PRIVACY NOTICE (GDPR art. 13/14). A controller-editable FR/EN text. Every
 *      edit is a NEW version; a person acknowledges each version once (who /
 *      when / which version), at first sign-in and again whenever the version
 *      changes. The notice is live only once a SuperAdmin has PUBLISHED a
 *      version: the template offered in the editor carries [[...]] placeholders
 *      (controller identity, DPO contact) and cannot be published until they are
 *      filled in. Before that, nobody is held.
 *
 *   2. "MY DATA" DOWNLOAD (art. 15 and 20). A JSON download on the existing
 *      "What is recorded about me" page, built on DSRService.export(): the SAME
 *      definition of "the subject's data" as erasure and the register. The
 *      confidential talent categories the page already lists without a count
 *      (ComplianceRegisterService.DATA_CATEGORIES, `confidential: true`) are
 *      withheld and NAMED in the file; their content is answered through a
 *      formal access request. Each download is recorded (audit + a per-person
 *      hourly ceiling, counted in the database so it holds across instances).
 *
 *   3. OBJECTION TO PROFILING (art. 21). An employee may object, with an
 *      optional reason, and withdraw later. While the objection stands:
 *        - the retention-risk recompute skips them and their stored automated
 *          verdict is replaced by "not computed: objection" (never a low score);
 *        - key-person risk and the copilot's named rankings never name them;
 *        - the automatic 9-box development triggers (red: PIP task, blue: draft
 *          IDP) are held for HR review instead of running.
 *      SuperAdmins are told, review each objection and decide each held
 *      trigger (proceed / dismiss, with a reason) from the register page.
 *
 * Fail-closed rule for the objection lookup: an absent table (migration 165 not
 * applied, SQLSTATE 42P01) means nobody has ever been able to object, so "no
 * objection" is the TRUE answer; any other error is thrown so the caller never
 * profiles a person whose objection it could not read.
 */

const db = require('../config/database');

const PLACEHOLDER_RE = /\[\[[^\]]{1,200}\]\]/;
const MAX_TITLE = 200;
const MAX_BODY = 60000;
const MAX_REASON = 1000;
const CACHE_MS = 30_000;
const DEFAULT_EXPORTS_PER_HOUR = 5;

/** Undefined table / column: the privacy schema is not there (yet). */
function isSchemaAbsent(e) {
    return !!e && (e.code === '42P01' || e.code === '42703');
}

/** Run a read that must not poison an enclosing transaction. */
function inSavepoint(fn) {
    return typeof db.runInSavepoint === 'function' ? db.runInSavepoint(fn) : fn();
}

function httpError(status, code) {
    const e = new Error(code);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}

function clean(v, max) {
    const s = String(v == null ? '' : v)
        .replace(/\r\n?/g, '\n')
        .trim();
    return s.length > max ? s.slice(0, max) : s;
}

/**
 * The template offered in the editor (never published by itself). Plain text:
 * "## " starts a heading, "- " a bullet, a blank line a new paragraph.
 */
const DEFAULT_TEMPLATE = Object.freeze({
    fr: {
        title: 'Notice d’information sur la protection des données personnelles',
        body: [
            'Cette notice explique quelles données personnelles la plateforme de développement des compétences traite à votre sujet, pourquoi, qui peut les consulter, combien de temps elles sont conservées et comment exercer vos droits.',
            '',
            '## Responsable du traitement',
            '[[Raison sociale et adresse du responsable du traitement]]',
            'Délégué à la protection des données (ou contact) : [[Nom, adresse e-mail et téléphone]]',
            '',
            '## Finalités du traitement',
            '- Évaluation des compétences (auto-évaluation, revue par le responsable, arbitrage des désaccords).',
            '- Plans de développement individuels, entretiens individuels, retours 360°, coaching et formation.',
            '- Revue des talents et positionnement dans la grille 9-box.',
            '- Plans de succession et de continuité des postes clés.',
            '- Certifications et habilitations exigées par le poste.',
            '',
            '## Base légale',
            'Exécution du contrat de travail, respect des obligations légales et intérêt légitime de l’employeur à gérer et développer les compétences. [[Compléter ou ajuster selon votre analyse juridique]]',
            '',
            '## Destinataires',
            'Votre responsable hiérarchique et votre superviseur, les équipes RH et les administrateurs habilités dans leur périmètre. [[Préciser les sous-traitants éventuels]]',
            '',
            '## Durée de conservation',
            'Les données sont conservées pendant la relation de travail, puis pseudonymisées à l’expiration du délai de conservation applicable après votre départ, sauf obligation légale de conservation plus longue. [[Préciser les durées retenues]]',
            '',
            '## Profilage',
            'La plateforme calcule automatiquement un indicateur de risque de départ, signale les compétences portées par une seule personne et propose des actions de développement à partir de la grille 9-box. Aucune décision produisant des effets juridiques n’est prise sans intervention humaine. Vous pouvez vous opposer à ce profilage depuis la page « Ce qui est enregistré sur moi » : le calcul est alors suspendu et les propositions automatiques sont soumises à un examen humain.',
            '',
            '## Vos droits',
            'Vous disposez d’un droit d’accès, de rectification, d’effacement, de limitation, d’opposition et de portabilité de vos données. Vous pouvez consulter et télécharger vos données depuis la page « Ce qui est enregistré sur moi ». Pour toute autre demande, adressez-vous au contact indiqué ci-dessus. Vous pouvez aussi saisir l’autorité de protection des données compétente : [[Autorité compétente]]',
        ].join('\n'),
    },
    en: {
        title: 'Personal data protection notice',
        body: [
            'This notice explains which personal data the skills-development platform processes about you, why, who can see it, how long it is kept and how to exercise your rights.',
            '',
            '## Data controller',
            '[[Company name and address of the data controller]]',
            'Data protection officer (or contact): [[Name, e-mail address and phone number]]',
            '',
            '## Purposes',
            '- Competency assessment (self-assessment, manager review, dispute arbitration).',
            '- Individual development plans, one-to-ones, 360° feedback, coaching and training.',
            '- Talent review and 9-box placement.',
            '- Succession and continuity planning for key positions.',
            '- Certifications and clearances a role requires.',
            '',
            '## Legal basis',
            'Performance of the employment contract, compliance with legal obligations and the employer’s legitimate interest in managing and developing skills. [[Complete or adjust according to your legal analysis]]',
            '',
            '## Recipients',
            'Your line manager and supervisor, HR and authorised administrators within their scope. [[List any processors]]',
            '',
            '## Retention',
            'Data is kept for the duration of employment, then pseudonymised when the applicable retention period after departure expires, unless the law requires longer retention. [[State the retention periods you apply]]',
            '',
            '## Profiling',
            'The platform automatically computes a retention-risk indicator, flags skills held by a single person and proposes development actions from the 9-box grid. No decision with legal effect is taken without human involvement. You can object to this profiling from the “What is recorded about me” page: the computation is then suspended and automatic proposals are reviewed by a person.',
            '',
            '## Your rights',
            'You have the right to access, rectify, erase, restrict and object to the processing of your data, and to data portability. You can view and download your data from the “What is recorded about me” page. For any other request, contact the person named above. You may also lodge a complaint with the competent data-protection authority: [[Competent authority]]',
        ].join('\n'),
    },
});

class PrivacyService {
    constructor() {
        this._cache = { at: 0, value: undefined };
    }

    get DEFAULT_TEMPLATE() {
        return DEFAULT_TEMPLATE;
    }
    get PLACEHOLDER_RE() {
        return PLACEHOLDER_RE;
    }

    /** The identity an acknowledgement / export is keyed on. */
    identityOf(user) {
        if (!user || user.id == null) return null;
        const id = Number(user.id);
        if (!Number.isInteger(id) || id <= 0) return null;
        if (user.userType === 'admin') return { type: 'admin', id };
        if (user.userType === 'employee' || user.userType === 'manager')
            return { type: 'employee', id };
        return null;
    }

    /** The reviewers of objections and held triggers: SuperAdmins. */
    isReviewer(user) {
        return require('./RBACService').isSuperAdmin(user);
    }

    // ======================================================================
    // 1. Privacy notice
    // ======================================================================

    clearCache() {
        this._cache = { at: 0, value: undefined };
    }

    /**
     * The published version in force, or null when none was ever published (or
     * the schema is absent). Any other error is THROWN: the gate then holds the
     * person on the notice page (fail closed).
     */
    async currentVersion({ fresh = false } = {}) {
        const now = Date.now();
        if (!fresh && this._cache.value !== undefined && now - this._cache.at < CACHE_MS)
            return this._cache.value;
        let row = null;
        try {
            row = await db.get(
                `SELECT id, version, title_fr, title_en, body_fr, body_en, change_note, published_by, published_at
                   FROM privacy_notice_versions ORDER BY version DESC LIMIT 1`
            );
        } catch (e) {
            if (!isSchemaAbsent(e)) throw e;
            row = null;
        }
        const value = row || null;
        this._cache = { at: now, value };
        return value;
    }

    async listVersions() {
        try {
            return await db.all(
                `SELECT version, title_fr, title_en, change_note, published_by, published_at
                   FROM privacy_notice_versions ORDER BY version DESC LIMIT 100`
            );
        } catch (e) {
            if (isSchemaAbsent(e)) return [];
            throw e;
        }
    }

    /** Validate an edit; returns the cleaned fields or throws 400 with a code. */
    validateNotice(input = {}) {
        const f = {
            titleFr: clean(input.titleFr, MAX_TITLE + 1),
            titleEn: clean(input.titleEn, MAX_TITLE + 1),
            bodyFr: clean(input.bodyFr, MAX_BODY + 1),
            bodyEn: clean(input.bodyEn, MAX_BODY + 1),
            changeNote: clean(input.changeNote, 500) || null,
        };
        if (!f.titleFr || !f.titleEn || !f.bodyFr || !f.bodyEn)
            throw httpError(400, 'notice_incomplete');
        if (f.titleFr.length > MAX_TITLE || f.titleEn.length > MAX_TITLE)
            throw httpError(400, 'notice_too_long');
        if (f.bodyFr.length > MAX_BODY || f.bodyEn.length > MAX_BODY)
            throw httpError(400, 'notice_too_long');
        if ([f.titleFr, f.titleEn, f.bodyFr, f.bodyEn].some((s) => PLACEHOLDER_RE.test(s)))
            throw httpError(400, 'notice_placeholders');
        return f;
    }

    /** Publish a NEW version (never an in-place edit). SuperAdmin only (route). */
    async publish(input, actorRef = null) {
        const f = this.validateNotice(input);
        let row = null;
        for (let attempt = 0; attempt < 3 && !row; attempt++) {
            try {
                row = await inSavepoint(() =>
                    db.get(
                        `INSERT INTO privacy_notice_versions
                            (version, title_fr, title_en, body_fr, body_en, change_note, published_by)
                         SELECT COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?, ?
                           FROM privacy_notice_versions
                         RETURNING version, published_at`,
                        [f.titleFr, f.titleEn, f.bodyFr, f.bodyEn, f.changeNote, actorRef]
                    )
                );
            } catch (e) {
                if (e && e.code === '23505') continue; // two publishers raced: take the next number
                throw e;
            }
        }
        if (!row) throw httpError(409, 'notice_publish_conflict');
        this.clearCache();
        await this._audit({
            action: 'PRIVACY_NOTICE_PUBLISHED',
            entityType: 'system',
            entityId: null,
            details: `Privacy notice version ${row.version} published${f.changeNote ? `: ${f.changeNote}` : ''}`,
            actorRef,
            severity: 'warning',
        });
        return { version: Number(row.version), publishedAt: row.publishedAt };
    }

    /** Acknowledgements of one version, per account type; null = not measured. */
    async ackStats(version) {
        try {
            const rows = await db.all(
                `SELECT subject_type, COUNT(*)::int AS n FROM privacy_notice_acks
                  WHERE version = ? GROUP BY subject_type`,
                [Number(version)]
            );
            const out = { admin: 0, employee: 0 };
            for (const r of rows || []) out[r.subjectType ?? r.subject_type] = Number(r.n);
            return out;
        } catch (_) {
            return null;
        }
    }

    async hasAcknowledged(identity, version) {
        if (!identity) return false;
        const r = await db.get(
            `SELECT id FROM privacy_notice_acks
              WHERE subject_type = ? AND subject_id = ? AND version = ? LIMIT 1`,
            [identity.type, identity.id, Number(version)]
        );
        return !!r;
    }

    async lastAcknowledgement(identity) {
        if (!identity) return null;
        try {
            return await db.get(
                `SELECT version, acknowledged_at FROM privacy_notice_acks
                  WHERE subject_type = ? AND subject_id = ?
                  ORDER BY version DESC LIMIT 1`,
                [identity.type, identity.id]
            );
        } catch (e) {
            if (isSchemaAbsent(e)) return null;
            throw e;
        }
    }

    /**
     * Record that the signed-in person read `version`. Only the version IN FORCE
     * can be acknowledged: a page left open over a republication must show the
     * new text first (409 stale_version).
     */
    async acknowledge(user, version, locale = null) {
        const identity = this.identityOf(user);
        if (!identity) throw httpError(403, 'no_identity');
        const current = await this.currentVersion({ fresh: true });
        if (!current) throw httpError(404, 'no_notice');
        if (Number(version) !== Number(current.version)) throw httpError(409, 'stale_version');
        await db.run(
            `INSERT INTO privacy_notice_acks (subject_type, subject_id, version, locale)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (subject_type, subject_id, version) DO NOTHING`,
            [identity.type, identity.id, Number(current.version), locale === 'en' ? 'en' : 'fr']
        );
        await this._audit({
            action: 'PRIVACY_NOTICE_ACKNOWLEDGED',
            entityType: identity.type === 'admin' ? 'admin' : 'employee',
            entityId: identity.id,
            details: `Privacy notice version ${current.version} acknowledged`,
            actorRef: `${identity.type}:${identity.id}`,
            severity: 'info',
        });
        return { identity, version: Number(current.version) };
    }

    /**
     * Plain text -> blocks the view escapes. No HTML ever reaches the page from
     * the stored text: "## " heading, "- " bullet, blank line = paragraph break.
     */
    toBlocks(text) {
        const blocks = [];
        let para = [];
        let list = null;
        const flushPara = () => {
            if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
            para = [];
        };
        const flushList = () => {
            if (list && list.length) blocks.push({ type: 'ul', items: list });
            list = null;
        };
        for (const raw of String(text || '').split('\n')) {
            const line = raw.trim();
            if (!line) {
                flushPara();
                flushList();
                continue;
            }
            if (line.startsWith('## ')) {
                flushPara();
                flushList();
                blocks.push({ type: 'h', text: line.slice(3).trim() });
            } else if (line.startsWith('- ')) {
                flushPara();
                if (!list) list = [];
                list.push(line.slice(2).trim());
            } else {
                flushList();
                para.push(line);
            }
        }
        flushPara();
        flushList();
        return blocks;
    }

    /** The notice in the reader's language (the other one when a side is empty). */
    present(versionRow, lang) {
        if (!versionRow) return null;
        const en = lang === 'en';
        const title = (en ? versionRow.titleEn : versionRow.titleFr) || versionRow.titleFr;
        const body = (en ? versionRow.bodyEn : versionRow.bodyFr) || versionRow.bodyFr;
        return {
            version: Number(versionRow.version),
            publishedAt: versionRow.publishedAt,
            title,
            blocks: this.toBlocks(body),
        };
    }

    // ======================================================================
    // 2. My data (download)
    // ======================================================================

    /** The employee record a session's "my data" is about (employee sessions only). */
    subjectEmployeeId(user) {
        const id = this.identityOf(user);
        return id && id.type === 'employee' ? id.id : null;
    }

    /** Category keys the self-service page and download withhold (confidential). */
    withheldKeys() {
        return require('./ComplianceRegisterService')
            .DATA_CATEGORIES.filter((c) => c.confidential)
            .map((c) => c.key);
    }

    /**
     * The self-service view of DSRService.export(): every category, minus the
     * confidential talent categories, which are named in `withheld`.
     */
    selfServiceView(full) {
        const data = { ...(full || {}) };
        const withheld = [];
        for (const k of this.withheldKeys()) {
            if (Object.prototype.hasOwnProperty.call(data, k)) delete data[k];
            withheld.push(k);
        }
        return { data, withheld };
    }

    /**
     * The whole download for the signed-in employee, or null for an admin
     * session (no employee record).
     */
    async myDataExport(user) {
        const empId = this.subjectEmployeeId(user);
        if (!empId) return null;
        const full = await require('./DSRService').export(empId);
        const { data, withheld } = this.selfServiceView(full);
        const identity = this.identityOf(user);
        const objection = await this.objectionOf(empId);
        return {
            format: 'personal-data-export/1',
            generatedAt: new Date().toISOString(),
            employeeId: empId,
            data,
            withheld,
            withheldNote:
                'These confidential talent categories are answered through a formal access request to HR.',
            privacy: {
                lastNoticeAcknowledged: await this.lastAcknowledgement(identity),
                profilingObjection: objection
                    ? { since: objection.createdAt, reviewedAt: objection.hrReviewedAt || null }
                    : null,
            },
        };
    }

    async exportLimit() {
        try {
            const v = Number(
                await require('../models/AppSettingsModel').getValue(
                    'privacySelfExportPerHour',
                    DEFAULT_EXPORTS_PER_HOUR
                )
            );
            return Number.isInteger(v) && v >= 1 && v <= 100 ? v : DEFAULT_EXPORTS_PER_HOUR;
        } catch (_) {
            return DEFAULT_EXPORTS_PER_HOUR;
        }
    }

    /**
     * Claim one download slot (audit + rate limit in ONE statement: the row is
     * written only while fewer than `limit` exist in the last hour). Fails
     * CLOSED: no ledger, no download.
     */
    async claimExport(user, format, meta = {}) {
        const identity = this.identityOf(user);
        if (!identity) throw httpError(403, 'no_identity');
        const fmt = format === 'html' ? 'html' : 'json';
        const limit = await this.exportLimit();
        const row = await db.get(
            `INSERT INTO privacy_self_exports (subject_type, subject_id, format)
             SELECT ?, ?, ?
              WHERE (SELECT COUNT(*) FROM privacy_self_exports
                      WHERE subject_type = ? AND subject_id = ?
                        AND created_at > now() - interval '1 hour') < ?
             RETURNING id`,
            [identity.type, identity.id, fmt, identity.type, identity.id, limit]
        );
        if (!row) {
            await this._audit({
                action: 'PRIVACY_SELF_EXPORT_RATE_LIMITED',
                entityType: 'employee',
                entityId: identity.id,
                details: `Self-service data download refused: ${limit} per hour reached`,
                actorRef: `${identity.type}:${identity.id}`,
                severity: 'warning',
                ipAddress: meta.ip,
            });
            const e = httpError(429, 'rate_limited');
            e.limit = limit;
            throw e;
        }
        await this._audit({
            action: 'PRIVACY_SELF_EXPORT',
            entityType: 'employee',
            entityId: identity.id,
            details: `Self-service personal-data download (${fmt})`,
            actorRef: `${identity.type}:${identity.id}`,
            severity: 'info',
            ipAddress: meta.ip,
        });
        return { id: Number(row.id), format: fmt };
    }

    // ======================================================================
    // 3. Objection to profiling
    // ======================================================================

    /** The open objection row, or null. Schema absent -> null (nobody could object). */
    async objectionOf(employeeId) {
        try {
            return await inSavepoint(() =>
                db.get(
                    `SELECT id, employee_id, reason, created_at, hr_reviewed_at, hr_reviewed_by, hr_note
                       FROM profiling_objections
                      WHERE employee_id = ? AND withdrawn_at IS NULL LIMIT 1`,
                    [Number(employeeId)]
                )
            );
        } catch (e) {
            if (isSchemaAbsent(e)) return null;
            throw e; // fail closed: the caller must not profile blindly
        }
    }

    async isObjecting(employeeId) {
        return !!(await this.objectionOf(employeeId));
    }

    /** Every person with an open objection (for sweeps and rankings). Throws on error. */
    async activeObjectorIds() {
        let rows;
        try {
            rows = await inSavepoint(() =>
                db.all('SELECT employee_id FROM profiling_objections WHERE withdrawn_at IS NULL')
            );
        } catch (e) {
            if (isSchemaAbsent(e)) return new Set();
            throw e;
        }
        return new Set((rows || []).map((r) => Number(r.employeeId ?? r.employee_id)));
    }

    async setObjection(user, reason) {
        const empId = this.subjectEmployeeId(user);
        if (!empId) throw httpError(403, 'employees_only');
        const why = clean(reason, MAX_REASON) || null;
        const row = await db.get(
            `INSERT INTO profiling_objections (employee_id, reason)
             VALUES (?, ?)
             ON CONFLICT (employee_id) WHERE withdrawn_at IS NULL DO NOTHING
             RETURNING id`,
            [empId, why]
        );
        if (!row) return { created: false };
        // Stop showing the automated verdict right away, not at the next sweep.
        try {
            await require('./RetentionRiskService').suppressForObjection(empId);
        } catch (e) {
            console.error('[privacy] retention suppression failed:', e && e.message);
        }
        await this._audit({
            action: 'PRIVACY_OBJECTION_SET',
            entityType: 'employee',
            entityId: empId,
            details: 'Objection to automated profiling recorded (GDPR art. 21)',
            actorRef: `employee:${empId}`,
            severity: 'warning',
        });
        await this._notifyReviewers('privacy.objection');
        return { created: true, id: Number(row.id) };
    }

    async withdrawObjection(user, reason) {
        const empId = this.subjectEmployeeId(user);
        if (!empId) throw httpError(403, 'employees_only');
        const why = clean(reason, MAX_REASON) || null;
        const r = await db.run(
            `UPDATE profiling_objections SET withdrawn_at = now(), withdrawn_reason = ?
              WHERE employee_id = ? AND withdrawn_at IS NULL`,
            [why, empId]
        );
        const changed = !!(r && r.changes);
        if (changed)
            await this._audit({
                action: 'PRIVACY_OBJECTION_WITHDRAWN',
                entityType: 'employee',
                entityId: empId,
                details: 'Objection to automated profiling withdrawn by the person',
                actorRef: `employee:${empId}`,
                severity: 'info',
            });
        return { withdrawn: changed };
    }

    /**
     * Hold an automatic 9-box trigger for HR review (called by
     * DevelopmentTriggerService inside the approve transaction; every write is
     * in a savepoint so a failure here never rolls the approval back).
     */
    async pauseTrigger({ employeeId, zone, performance, potential, originEvaluationId = null }) {
        const row = await inSavepoint(() =>
            db.get(
                `INSERT INTO privacy_paused_triggers
                    (employee_id, zone, performance, potential, origin_evaluation_id)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (employee_id, zone) WHERE resolved_at IS NULL DO NOTHING
                 RETURNING id`,
                [
                    Number(employeeId),
                    zone,
                    performance || null,
                    potential || null,
                    originEvaluationId || null,
                ]
            )
        );
        if (row) {
            await this._audit({
                action: 'PRIVACY_TRIGGER_PAUSED',
                entityType: 'employee',
                entityId: Number(employeeId),
                details: `Automatic ${zone} development trigger held for HR review (objection to profiling)`,
                actorRef: 'system:privacy',
                severity: 'info',
            });
            await this._notifyReviewers('privacy.trigger_paused');
            return { id: Number(row.id), created: true };
        }
        const open = await inSavepoint(() =>
            db.get(
                'SELECT id FROM privacy_paused_triggers WHERE employee_id = ? AND zone = ? AND resolved_at IS NULL',
                [Number(employeeId), zone]
            )
        );
        return { id: open ? Number(open.id) : null, created: false };
    }

    /** Reviewer console: open objections + held triggers. Never names "none" on failure. */
    async reviewOverview(user) {
        if (!this.isReviewer(user)) throw httpError(403, 'forbidden');
        try {
            const objections = await db.all(
                `SELECT po.id, po.employee_id, po.reason, po.created_at, po.hr_reviewed_at, po.hr_reviewed_by, po.hr_note,
                        e.first_name, e.last_name, e.employee_number
                   FROM profiling_objections po JOIN employees e ON e.id = po.employee_id
                  WHERE po.withdrawn_at IS NULL
                  ORDER BY po.hr_reviewed_at NULLS FIRST, po.created_at`
            );
            const triggers = await db.all(
                `SELECT pt.id, pt.employee_id, pt.zone, pt.created_at,
                        e.first_name, e.last_name, e.employee_number,
                        EXISTS (SELECT 1 FROM profiling_objections po2
                                 WHERE po2.employee_id = pt.employee_id AND po2.withdrawn_at IS NULL) AS still_objecting
                   FROM privacy_paused_triggers pt JOIN employees e ON e.id = pt.employee_id
                  WHERE pt.resolved_at IS NULL
                  ORDER BY pt.created_at`
            );
            return { objections, triggers };
        } catch (e) {
            if (!isSchemaAbsent(e)) throw e;
            return { objections: null, triggers: null }; // not measured, never "none"
        }
    }

    async markReviewed(user, objectionId, note) {
        if (!this.isReviewer(user)) throw httpError(403, 'forbidden');
        const text = clean(note, MAX_REASON);
        if (!text) throw httpError(400, 'note_required');
        const row = await db.get(
            'SELECT id, employee_id FROM profiling_objections WHERE id = ? AND withdrawn_at IS NULL',
            [Number(objectionId)]
        );
        if (!row) throw httpError(404, 'not_found');
        const actorRef = `admin:${Number(user.id)}`;
        await db.run(
            'UPDATE profiling_objections SET hr_reviewed_at = now(), hr_reviewed_by = ?, hr_note = ? WHERE id = ?',
            [actorRef, text, Number(objectionId)]
        );
        await this._audit({
            action: 'PRIVACY_OBJECTION_REVIEWED',
            entityType: 'employee',
            entityId: Number(row.employeeId),
            details: 'Objection to profiling reviewed by HR',
            actorRef,
            severity: 'info',
        });
        return { ok: true };
    }

    /**
     * A reviewer decides a held trigger. `proceed` runs the automatic trigger as
     * it would have run (the reason is recorded); `dismiss` closes it. A written
     * reason is mandatory either way (DB CHECK too).
     */
    async resolveTrigger(user, triggerId, { resolution, reason } = {}, req = null) {
        if (!this.isReviewer(user)) throw httpError(403, 'forbidden');
        if (resolution !== 'proceed' && resolution !== 'dismiss')
            throw httpError(400, 'bad_resolution');
        const why = clean(reason, MAX_REASON);
        if (!why) throw httpError(400, 'reason_required');
        const t = await db.get(
            `SELECT id, employee_id, zone, performance, potential, origin_evaluation_id
               FROM privacy_paused_triggers WHERE id = ? AND resolved_at IS NULL`,
            [Number(triggerId)]
        );
        if (!t) throw httpError(404, 'not_found');
        const actorRef = `admin:${Number(user.id)}`;
        return db.runTransaction(async () => {
            const claimed = await db.run(
                `UPDATE privacy_paused_triggers
                    SET resolved_at = now(), resolved_by = ?, resolution = ?, resolution_reason = ?
                  WHERE id = ? AND resolved_at IS NULL`,
                [actorRef, resolution, why, Number(triggerId)]
            );
            if (!claimed || claimed.changes !== 1) throw httpError(409, 'already_resolved');
            let outcome = null;
            if (resolution === 'proceed') {
                outcome = await require('./DevelopmentTriggerService').triggerForPlacement(
                    user,
                    {
                        employeeId: Number(t.employeeId),
                        performance: t.performance,
                        potential: t.potential,
                        evaluationId: t.originEvaluationId || null,
                    },
                    req,
                    { bypassObjection: true }
                );
            }
            await this._audit({
                action: 'PRIVACY_TRIGGER_RESOLVED',
                entityType: 'employee',
                entityId: Number(t.employeeId),
                details: `Held ${t.zone} development trigger ${resolution === 'proceed' ? 'released' : 'dismissed'} by HR`,
                actorRef,
                severity: 'warning',
            });
            return { ok: true, resolution, outcome };
        });
    }

    // ======================================================================
    // helpers
    // ======================================================================

    /** SuperAdmins, in-app only (no e-mail, no webhook), count-free, name-free. */
    async _notifyReviewers(kind) {
        try {
            const rows = await inSavepoint(() =>
                db.all("SELECT id FROM admins WHERE is_active = true AND role::text = 'superadmin'")
            );
            const N = require('./NotificationService');
            for (const r of rows || []) {
                try {
                    await inSavepoint(() =>
                        N.enqueue({
                            userType: 'admin',
                            userId: Number(r.id),
                            channel: 'inapp',
                            kind,
                            payload: { link: '/compliance/register' },
                        })
                    );
                } catch (_) {
                    /* one recipient never blocks the others */
                }
            }
            return (rows || []).length;
        } catch (_) {
            return 0;
        }
    }

    async _audit(entry) {
        try {
            await inSavepoint(() => require('./LogService').log(entry));
        } catch (_) {
            /* auditing never breaks the request */
        }
    }
}

module.exports = new PrivacyService();
module.exports.PrivacyService = PrivacyService;
module.exports.isSchemaAbsent = isSchemaAbsent;
