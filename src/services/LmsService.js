'use strict';

/**
 * LmsService — LMS Integration Hub orchestration (Phase 3).
 *
 *   - Integration config (per provider) with secret masking.
 *   - Catalog sync + course<->skill mapping.
 *   - Outbound assignment (records lms_enrollments, links to a source action).
 *   - Inbound completion ingestion (idempotent) → the CLOSED LOOP:
 *       completion → raise mapped skill (source = lms_completion, fully audited)
 *                 → never override a more recent supervisor review
 *                 → re-evaluate any successor's readiness band for that skill.
 *   - Enrollment lifecycle: assigned → in_progress (launch) → completed
 *     (completion evidence), with the outbound push outcome recorded.
 */
const db = require('../config/database');
const { getConnector } = require('../integrations/lms');
const secretBox = require('../utils/secretBox');

class LmsService {
    /**
     * `assessment_history.source` values that mean "a human supervisor decided
     * this level". An automated completion must NEVER reverse one of them.
     *
     * Both spellings are listed because the value is derived from the notes text
     * by fn_classify_assessment_source: before migration 74 the primary
     * approval path ('Set from supervisor-validated rating') fell through to
     * 'manual', so the guard below never fired for it — an e-learning completion
     * silently restored a level the supervisor had deliberately downgraded.
     */
    static get SUPERVISOR_LOCKED_SOURCES() {
        return ['supervisor_review', 'supervisor_validated'];
    }

    /**
     * True when this history row is a supervisor's official decision.
     *
     * The notes check is not belt-and-braces decoration: assessment_history is
     * append-only, so rows written BEFORE migration 74 keep their misclassified
     * source = 'manual' forever. Recognising them by the wording their writer
     * used is the only way to protect decisions already on file.
     */
    static _isSupervisorDecision(row) {
        if (!row) return false;
        if (this.SUPERVISOR_LOCKED_SOURCES.includes(row.source)) return true;
        const n = String(row.notes || '').toLowerCase();
        return (
            n.includes('supervisor review') ||
            n.includes('supervisor-validated') ||
            n.includes('supervisor validated')
        );
    }

    /**
     * Parse a provider-supplied timestamp, or null when it cannot be parsed.
     * Providers emit '0000-00-00', 'N/A' and empty strings; feeding those to a
     * timestamptz column threw, aborted the ingest transaction, aborted the
     * whole provider loop and left the sync cursor un-advanced — so the same bad
     * record was re-fetched forever and the provider never synced again.
     */
    static _toTimestamp(v) {
        if (v == null || v === '') return null;
        const d = v instanceof Date ? v : new Date(String(v));
        if (Number.isNaN(d.getTime())) return null;
        const y = d.getUTCFullYear();
        if (y < 1970 || y > 2999) return null; // out of any plausible LMS range
        return d.toISOString();
    }

    static async _systemAdminId() {
        const a = await db.get("SELECT id FROM admins WHERE username = 'admin'");
        return a ? a.id : null;
    }

    // ---- Integration config -----------------------------------------------
    static _mask(row) {
        if (!row) return row;
        const { webhookSecret, authConfig, ...rest } = row;
        return {
            ...rest,
            hasWebhookSecret: Boolean(webhookSecret),
            hasAuth: Boolean(authConfig && Object.keys(authConfig).length),
        };
    }

    static async listIntegrations() {
        const rows = await db.all('SELECT * FROM lms_integrations ORDER BY provider');
        return rows.map((r) => this._mask(r));
    }

    // SSRF guard for the LMS base URL. Unlike outbound webhooks (external SaaS), an
    // on-prem LMS legitimately lives on the LAN, so we do NOT block private ranges —
    // but we DO block the dangerous SSRF targets: non-http(s) schemes, loopback, and
    // the cloud-metadata endpoint (169.254.169.254), so a crafted base_url can't be
    // used to reach the server's own localhost services or a cloud IMDS.
    /**
     * Loopback / unspecified / link-local (cloud metadata) IP literal, in ANY
     * notation. SECURITY (audit 2026-09-29, SA-05): the prefix tests missed the
     * IPv4-mapped IPv6 form — http://[::ffff:169.254.169.254]/ serialises to
     * [::ffff:a9fe:a9fe] — and 0.0.0.0/8. net.BlockList judges a mapped IPv6
     * address against the IPv4 rules, so one list covers every spelling.
     */
    static _isLoopbackOrLinkLocalIp(host) {
        const fam = require('net').isIP(host);
        if (!fam) return false;
        const bl = new (require('net').BlockList)();
        bl.addSubnet('0.0.0.0', 8, 'ipv4');
        bl.addSubnet('127.0.0.0', 8, 'ipv4');
        bl.addSubnet('169.254.0.0', 16, 'ipv4');
        bl.addSubnet('::', 96, 'ipv6'); // ::, ::1 and the IPv4-compatible block
        bl.addSubnet('fe80::', 10, 'ipv6');
        return bl.check(host, fam === 4 ? 'ipv4' : 'ipv6');
    }

    static _assertSafeLmsBaseUrl(raw) {
        if (!raw) return; // empty = no integration endpoint yet
        let u;
        try {
            u = new URL(String(raw));
        } catch {
            throw new Error('Invalid LMS base URL');
        }
        if (!['http:', 'https:'].includes(u.protocol))
            throw new Error('LMS base URL must be http(s)');
        const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        const blocked =
            host === 'localhost' ||
            host.endsWith('.localhost') ||
            LmsService._isLoopbackOrLinkLocalIp(host);
        if (blocked)
            throw new Error('LMS base URL cannot target loopback or link-local/metadata addresses');
    }

    static async upsertIntegration(
        provider,
        { name, baseUrl, authConfig, syncSchedule, webhookSecret, enabled } = {}
    ) {
        this._assertSafeLmsBaseUrl(baseUrl);
        // Base upsert WITHOUT auth_config so editing other fields never wipes
        // stored credentials. New rows start with '{}' (the column default).
        await db.run(
            `INSERT INTO lms_integrations (provider, name, base_url, sync_schedule, webhook_secret, enabled)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (provider) DO UPDATE SET
               name = EXCLUDED.name, base_url = EXCLUDED.base_url,
               sync_schedule = EXCLUDED.sync_schedule,
               webhook_secret = COALESCE(EXCLUDED.webhook_secret, lms_integrations.webhook_secret),
               enabled = EXCLUDED.enabled, updated_at = now()`,
            [
                provider,
                name || null,
                baseUrl || null,
                syncSchedule || null,
                // Encrypted at rest like auth_config (S-10). secretBox.encrypt is
                // a pass-through when no APP_KEY/SESSION_SECRET is set (dev), and
                // verifyWebhookSecret still reads legacy clear values.
                webhookSecret ? secretBox.encrypt(String(webhookSecret)) : null,
                enabled === true || enabled === 'true',
            ]
        );
        // Only overwrite auth_config when the caller explicitly supplies one.
        // Encrypted at rest (AES-256-GCM) when APP_KEY/SESSION_SECRET is set.
        if (authConfig != null && authConfig !== '') {
            const obj = typeof authConfig === 'string' ? JSON.parse(authConfig) : authConfig;
            const stored = secretBox.isEnabled()
                ? JSON.stringify({ _enc: secretBox.encrypt(JSON.stringify(obj)) })
                : JSON.stringify(obj);
            await db.run(
                'UPDATE lms_integrations SET auth_config = ?, updated_at = now() WHERE provider = ?',
                [stored, provider]
            );
        }
        return this._mask(
            await db.get('SELECT * FROM lms_integrations WHERE provider = ?', [provider])
        );
    }

    /** Decrypt the stored auth_config back to a plain object for connector use. */
    static _decryptAuth(authConfig) {
        if (!authConfig) return {};
        if (authConfig._enc) {
            try {
                return JSON.parse(secretBox.decrypt(authConfig._enc));
            } catch (e) {
                // Likely a rotated APP_KEY or a corrupt blob — surface it loudly
                // rather than silently behaving as "no credentials configured".
                console.error(
                    '[lms] auth_config decryption failed (check APP_KEY/SESSION_SECRET):',
                    e.message
                );
                return {};
            }
        }
        return authConfig;
    }

    static async _getConnectorFor(provider) {
        const cfg = await db.get('SELECT * FROM lms_integrations WHERE provider = ?', [provider]);
        if (!cfg) throw new Error(`No integration configured for provider ${provider}`);
        // Hand the connector a decrypted auth_config under both key spellings.
        const auth = this._decryptAuth(cfg.authConfig);
        return {
            connector: getConnector(provider, { ...cfg, auth_config: auth, authConfig: auth }),
            cfg,
        };
    }

    static async verifyWebhookSecret(provider, providedSecret) {
        const cfg = await db.get(
            'SELECT enabled, webhook_secret FROM lms_integrations WHERE provider = ?',
            [provider]
        );
        if (!cfg || !cfg.enabled) return false;
        if (!cfg.webhookSecret) return false; // a secret MUST be configured — never an open POST
        // Stored encrypted (enc:v1:…) since 3.23.17; a legacy clear value is
        // returned unchanged by decrypt. A blob that cannot be decrypted
        // (rotated key, corruption) fails CLOSED.
        let expected;
        try {
            expected = secretBox.decrypt(cfg.webhookSecret);
        } catch (e) {
            console.error(
                '[lms] webhook_secret decryption failed (check APP_KEY/SESSION_SECRET):',
                e.message
            );
            return false;
        }
        if (!expected) return false;
        // HMAC both sides to a fixed length before comparing, so the comparison
        // leaks neither the secret's contents nor its length via timing.
        const crypto = require('crypto');
        const h = (v) =>
            crypto
                .createHmac('sha256', 'lms-webhook-cmp')
                .update(String(v == null ? '' : v))
                .digest();
        return crypto.timingSafeEqual(h(expected), h(providedSecret));
    }

    // ---- Catalog + mapping -------------------------------------------------
    /**
     * Sync a provider's catalogue. ONE malformed record must never cost the
     * whole catalogue: each course is written independently and a failure is
     * skipped + logged, never propagated.
     */
    static async syncCatalog(provider) {
        const { connector } = await this._getConnectorFor(provider);
        const courses = await connector.fetchCatalog();
        let upserted = 0;
        const skipped = [];
        for (const c of courses) {
            if (!c || !c.externalId || !c.title) {
                skipped.push({
                    externalId: (c && c.externalId) || null,
                    reason: 'missing externalId/title',
                });
                continue;
            }
            try {
                const duration = Number(c.durationMinutes);
                await db.run(
                    `INSERT INTO lms_courses (provider, external_id, title, url, type, duration_minutes, competency_tags, synced_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, now())
                     ON CONFLICT (provider, external_id) DO UPDATE SET
                       title = EXCLUDED.title, url = EXCLUDED.url, type = EXCLUDED.type,
                       duration_minutes = EXCLUDED.duration_minutes, competency_tags = EXCLUDED.competency_tags,
                       synced_at = now()`,
                    [
                        provider,
                        c.externalId,
                        c.title,
                        c.url || null,
                        c.type || null,
                        Number.isFinite(duration) ? Math.trunc(duration) : null,
                        JSON.stringify(c.competencyTags || []),
                    ]
                );
                upserted++;
            } catch (e) {
                skipped.push({ externalId: String(c.externalId), reason: e.message });
                console.warn(`[lms] ${provider}: skipped course ${c.externalId} — ${e.message}`);
            }
        }
        return { upserted, skipped: skipped.length, skippedDetail: skipped.slice(0, 20) };
    }

    static async listCourses(provider = null) {
        return provider
            ? db.all('SELECT * FROM lms_courses WHERE provider = ? ORDER BY title', [provider])
            : db.all('SELECT * FROM lms_courses ORDER BY provider, title');
    }

    static async upsertCourse(provider, course) {
        return db.get(
            `INSERT INTO lms_courses (provider, external_id, title, url, type, duration_minutes, competency_tags)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (provider, external_id) DO UPDATE SET title = EXCLUDED.title, synced_at = now()
             RETURNING *`,
            [
                provider,
                course.externalId,
                course.title,
                course.url || null,
                course.type || null,
                course.durationMinutes || null,
                JSON.stringify(course.competencyTags || []),
            ]
        );
    }

    static async mapCourseSkill(courseId, skillId, levelDelta, adminId = null) {
        return db.get(
            `INSERT INTO course_skill_map (course_id, skill_id, level_delta, created_by)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (course_id, skill_id) DO UPDATE SET level_delta = EXCLUDED.level_delta
             RETURNING *`,
            [courseId, skillId, Math.max(0, Math.min(4, Number(levelDelta) || 1)), adminId]
        );
    }

    static async listMappings(courseId) {
        return db.all(
            `SELECT m.*, s.name AS skill_name FROM course_skill_map m
             JOIN skills s ON s.id = m.skill_id WHERE m.course_id = ? ORDER BY s.name`,
            [courseId]
        );
    }

    // ---- Outbound assignment ----------------------------------------------
    /**
     * Assign a course. The vendor push is best-effort — but its OUTCOME is
     * recorded (push_state / push_error) instead of being swallowed by a bare
     * catch, so "assigned here but never actually pushed to the LMS" is visible
     * to the assigner and to the learner rather than being an invisible dead end.
     */
    static async assignCourse(
        employeeId,
        courseId,
        { assignedBy = null, sourceActionId = null, dueAt = null } = {}
    ) {
        const course = await db.get('SELECT * FROM lms_courses WHERE id = ?', [courseId]);
        if (!course) throw new Error('Course not found');
        const emp = await db.get('SELECT id, email FROM employees WHERE id = ?', [employeeId]);
        if (!emp) throw new Error('Employee not found');

        let externalRef = null;
        let pushState = 'pending';
        let pushError = null;
        try {
            const { connector } = await this._getConnectorFor(course.provider);
            const out = await connector.assignCourse(
                { id: emp.id, email: emp.email },
                course.externalId
            );
            if (!out || out.supported === false) {
                pushState = 'unsupported'; // connector has no assignment API — not a failure
            } else if (out.error) {
                pushState = 'failed';
                pushError = String(out.error).slice(0, 500);
            } else {
                pushState = 'pushed';
                if (out.externalRef) externalRef = out.externalRef;
            }
        } catch (e) {
            pushState = 'failed';
            pushError = String((e && e.message) || e).slice(0, 500);
        }
        if (pushState === 'failed') {
            console.warn(
                `[lms] ${course.provider}: assignment push failed for employee ${employeeId} / course ${course.externalId} — ${pushError}`
            );
        }

        const due = this._toTimestamp(dueAt);
        const enrollment = await db.get(
            `INSERT INTO lms_enrollments (employee_id, course_id, status, assigned_by, source_action_id, external_ref,
                                          due_at, push_state, push_error, push_attempted_at)
             VALUES (?, ?, 'assigned', ?, ?, ?, ?, ?, ?, now())
             ON CONFLICT (employee_id, course_id) DO UPDATE SET
               assigned_by = EXCLUDED.assigned_by,
               source_action_id = COALESCE(EXCLUDED.source_action_id, lms_enrollments.source_action_id),
               external_ref = COALESCE(EXCLUDED.external_ref, lms_enrollments.external_ref),
               due_at = COALESCE(EXCLUDED.due_at, lms_enrollments.due_at),
               push_state = EXCLUDED.push_state, push_error = EXCLUDED.push_error,
               push_attempted_at = now(),
               -- Re-assigning an ACTIVE enrolment must not wipe the learner's
               -- progress back to 'assigned' (autoAssignForSkills re-runs on every
               -- gap push). Only a finished/terminal enrolment restarts — that is a
               -- genuine re-assignment, e.g. a recertification.
               status = CASE WHEN lms_enrollments.status IN ('assigned', 'in_progress')
                             THEN lms_enrollments.status ELSE 'assigned'::lms_enroll_status END,
               started_at = CASE WHEN lms_enrollments.status IN ('assigned', 'in_progress')
                                 THEN lms_enrollments.started_at ELSE NULL END,
               completed_at = CASE WHEN lms_enrollments.status IN ('assigned', 'in_progress')
                                   THEN lms_enrollments.completed_at ELSE NULL END,
               updated_at = now()
             RETURNING *`,
            [
                employeeId,
                courseId,
                assignedBy,
                sourceActionId,
                externalRef,
                due,
                pushState,
                pushError,
            ]
        );
        // Tell the learner a course was assigned (auto-assignment was invisible →
        // zero completion accountability). Digest-tier, in-app, and pointing at
        // the learner page — /v2/lms is the admin console and 403s for them.
        //
        // AWAITED, not fire-and-forget: assignCourse runs inside a transaction on
        // several paths (autoAssignForSkills from the development triggers), and a
        // detached query on the same ALS-bound client interleaves with the caller's
        // — pg warns "client.query when the client is already executing a query"
        // and the enclosing transaction can end up aborted. The try/catch keeps the
        // original promise: a notification failure never blocks the assignment.
        try {
            await require('./NotificationService').notify({
                userType: 'employee',
                userId: Number(employeeId),
                kind: 'lms.assigned',
                category: 'talent',
                payload: { link: '/employee/my-learning', courseTitle: course.title },
            });
        } catch (_) {
            /* never block assignment */
        }
        return { ...enrollment, pushState, pushError };
    }

    // ---- Enrollment lifecycle ---------------------------------------------
    /** Forward-only ranking: an enrolment never regresses on its own. */
    static get _STATUS_RANK() {
        return { assigned: 0, in_progress: 1, completed: 2 };
    }

    /**
     * Advance one enrolment to `next` when the evidence justifies it. Returns
     * the updated row, or null when there is nothing to advance (no enrolment,
     * already at/past that state, or terminal 'failed'/'cancelled' which only a
     * human may change).
     */
    static async advanceEnrollment(employeeId, courseId, next, { at = null } = {}) {
        const rank = this._STATUS_RANK;
        if (!(next in rank)) throw new Error(`Unknown enrollment status: ${next}`);
        const row = await db.get(
            'SELECT id, status FROM lms_enrollments WHERE employee_id = ? AND course_id = ?',
            [employeeId, courseId]
        );
        if (!row) return null;
        const cur = String(row.status);
        if (!(cur in rank)) return null; // failed / cancelled — leave alone
        if (rank[cur] >= rank[next]) return null; // never move backwards
        const ts = this._toTimestamp(at) || new Date().toISOString();
        return db.get(
            `UPDATE lms_enrollments
                SET status = ?,
                    started_at   = COALESCE(started_at, ?),
                    completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
                    updated_at = now()
              WHERE id = ? RETURNING *`,
            [next, ts, next, ts, row.id]
        );
    }

    /**
     * The learner opened the course — real evidence they started it. Creates
     * nothing: only an existing assignment advances.
     */
    static async recordLaunch(employeeId, courseId) {
        return this.advanceEnrollment(employeeId, courseId, 'in_progress');
    }

    // ---- Inbound completion ingestion (the closed loop) -------------------
    static async ingestWebhook(provider, payload) {
        const { connector } = await this._getConnectorFor(provider);
        const norm = connector.normalizeWebhook(payload);
        if (!norm) return { ignored: true, reason: 'not a completion / unparseable' };
        return this.ingestCompletion(provider, norm);
    }

    static async _resolveEmployeeId(norm) {
        if (norm.employeeId) return Number(norm.employeeId);
        if (norm.employeeEmail) {
            // One address may belong to several accounts (migration 107): a
            // completion is credited only to an UNAMBIGUOUS match, never guessed.
            const { row: e } = await require('./EmailAccountsService').uniqueEmployeeByEmail(
                norm.employeeEmail
            );
            if (e) return e.id;
        }
        return null;
    }

    static async ingestCompletion(provider, norm) {
        const employeeId = await this._resolveEmployeeId(norm);
        const course = norm.externalCourseId
            ? await db.get('SELECT id FROM lms_courses WHERE provider = ? AND external_id = ?', [
                  provider,
                  norm.externalCourseId,
              ])
            : null;
        const courseId = course ? course.id : null;

        // Idempotent insert (unique provider + external_ref). If it already
        // exists, return the prior outcome without re-applying.
        const existing = await db.get(
            'SELECT id, applied FROM lms_completions WHERE provider = ? AND external_ref = ?',
            [provider, norm.externalRef]
        );
        if (existing)
            return { duplicate: true, completionId: existing.id, applied: existing.applied };

        // A malformed provider date must not cost the completion. Keep the record
        // with a null completed_at and preserve the raw value for investigation,
        // rather than throwing and stalling the whole provider sync.
        const completedAt = this._toTimestamp(norm.completedAt);
        const raw = { ...(norm.raw || {}) };
        if (norm.completedAt && !completedAt) {
            raw._invalidCompletedAt = String(norm.completedAt);
            console.warn(
                `[lms] ${provider}: unparseable completedAt '${norm.completedAt}' on ${norm.externalRef} — stored as null`
            );
        }
        const score =
            norm.score != null && Number.isFinite(Number(norm.score)) ? Number(norm.score) : null;

        // Insert + skill-apply atomically: a mid-apply failure rolls the
        // completion back too, so a retry reprocesses cleanly (no orphaned
        // completion stuck at applied=false with no reason).
        return db.runTransaction(async () => {
            const row = await db.get(
                `INSERT INTO lms_completions (provider, external_ref, employee_id, course_id, completed_at, score, cert_id, raw)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                [
                    provider,
                    norm.externalRef,
                    employeeId,
                    courseId,
                    completedAt,
                    score,
                    norm.certId || null,
                    JSON.stringify(raw),
                ]
            );
            // The learner's loop closes here: the enrolment finally leaves
            // 'assigned' (it used to stay there forever, so the reminder job kept
            // nagging about a course that was already done).
            const enrollment = await this._closeEnrollment(employeeId, courseId, completedAt);
            const applied = await this._proposeSkillUplifts(row.id, employeeId, courseId);
            return {
                completionId: row.id,
                employeeId,
                courseId,
                enrollmentStatus: enrollment,
                ...applied,
            };
        });
    }

    /**
     * Mark the matching enrolment completed. When the learner took the course
     * without a platform assignment (self-enrolled in the LMS), record the
     * enrolment as completed so their learning history is not lost — assigned_by
     * stays NULL, so it is never mistaken for an assignment somebody made.
     */
    static async _closeEnrollment(employeeId, courseId, completedAt) {
        if (!employeeId || !courseId) return null;
        const moved = await this.advanceEnrollment(employeeId, courseId, 'completed', {
            at: completedAt,
        });
        if (moved) return 'completed';
        const existing = await db.get(
            'SELECT status FROM lms_enrollments WHERE employee_id = ? AND course_id = ?',
            [employeeId, courseId]
        );
        if (existing) return String(existing.status);
        const ts = this._toTimestamp(completedAt) || new Date().toISOString();
        await db.run(
            `INSERT INTO lms_enrollments (employee_id, course_id, status, started_at, completed_at, push_state)
             VALUES (?, ?, 'completed', ?, ?, 'unsupported')
             ON CONFLICT (employee_id, course_id) DO NOTHING`,
            [employeeId, courseId, ts, ts]
        );
        return 'completed';
    }

    /**
     * A finished course PROPOSES a level; it never sets one.
     *
     * HR policy §10: "Une formation terminée est une preuve, pas une élévation
     * automatique du niveau officiel."
     *
     * This used to write `skill_assessments.current_level = level_delta`
     * directly, attributed to the system 'admin' account, with the note
     * "LMS completion: auto skill uplift". Measured on a rolled-back probe:
     * employee 138 / skill 331 went from level 1 to level 3 — official
     * readiness 55.9 % to 61.8 %, one more skill "met", succession benches
     * recomputed — with no human involved and nobody's name against it. A
     * course mapped to 4 could declare somebody an expert.
     *
     * Its only guard read the LAST row of assessment_history and skipped when
     * that row was a supervisor decision. A later 'manual' row masked the
     * supervisor's, so employee 152 / skill 300 went 2 to 4 straight through
     * a review that existed. A guard that a subsequent write can hide is not
     * a guard.
     *
     * So the write is gone. The completion is recorded as evidence awaiting a
     * named decision: the row stays `applied = false` with
     * `review_reason = 'awaiting_supervisor'`, and the people who may decide
     * are told. `decideUplift` is the only path that reaches
     * skill_assessments, and it records who decided.
     */
    static async _proposeSkillUplifts(completionId, employeeId, courseId) {
        const close = async (reason) => {
            await db.run(
                'UPDATE lms_completions SET applied = false, review_reason = ? WHERE id = ?',
                [reason, completionId]
            );
            return { applied: false, raisedSkills: [], proposedSkills: [], reason };
        };
        if (!employeeId || !courseId)
            return close(!employeeId ? 'unknown_employee' : 'unknown_course');

        const maps = await db.all(
            'SELECT skill_id, level_delta FROM course_skill_map WHERE course_id = ?',
            [courseId]
        );
        if (!maps.length) return close('no_mapping');

        const proposed = [];
        for (const m of maps) {
            const target = Number(m.levelDelta);
            if (!Number.isInteger(target) || target < 0 || target > 4) continue;
            const cur = await db.get(
                'SELECT current_level FROM skill_assessments WHERE employee_id = ? AND skill_id = ?',
                [employeeId, m.skillId]
            );
            const curLevel = cur ? Number(cur.currentLevel) : 0;
            if (curLevel >= target) continue; // already at or above — nothing to propose
            proposed.push({ skillId: Number(m.skillId), from: curLevel, to: target });
        }
        if (!proposed.length) return close('already_met');

        await db.run(
            "UPDATE lms_completions SET applied = false, review_reason = 'awaiting_supervisor' WHERE id = ?",
            [completionId]
        );
        await this._notifyUpliftProposed(employeeId, completionId, proposed);
        // `applied` stays FALSE: nothing has been applied. `raisedSkills` stays
        // EMPTY for the same reason — a caller that reads it must not be told a
        // level moved when none did.
        return {
            applied: false,
            raisedSkills: [],
            proposedSkills: proposed,
            reason: 'awaiting_supervisor',
        };
    }

    /**
     * Tell whoever may decide that a completion is waiting on them: the
     * employee's supervisor, and their manager when that manager is a person.
     */
    static async _notifyUpliftProposed(employeeId, completionId, proposed) {
        try {
            const row = await db.get(
                `SELECT supervisor_id AS sid,
                        CASE WHEN manager_type = 'employee' THEN manager_id END AS mid
                   FROM employees WHERE id = ?`,
                [employeeId]
            );
            const targets = [
                ...new Set([row && row.sid, row && row.mid].map(Number).filter(Boolean)),
            ];
            if (!targets.length) return;
            const NotificationService = require('./NotificationService');
            for (const userId of targets) {
                await NotificationService.notify({
                    userType: 'employee',
                    userId,
                    kind: 'lms.uplift_proposed',
                    category: 'talent',
                    payload: {
                        link: '/v2/lms/uplifts',
                        employeeId,
                        completionId,
                        skills: proposed.length,
                    },
                }).catch(() => {});
            }
        } catch (_) {
            /* never block ingestion on a notification */
        }
    }

    // ---- Supervisor decision on a proposed uplift ---------------------------

    /**
     * The uplifts waiting on this reader, scoped to the people they govern.
     * An admin who may approve assessments sees every pending one.
     */
    static async pendingUplifts(user) {
        const RBACService = require('./RBACService');
        const rows = await db.all(
            `SELECT c.id            AS completion_id,
                    c.employee_id   AS employee_id,
                    c.completed_at  AS completed_at,
                    e.first_name, e.last_name, e.employee_number,
                    co.title        AS course_title
               FROM lms_completions c
               JOIN employees e   ON e.id = c.employee_id
               LEFT JOIN lms_courses co ON co.id = c.course_id
              WHERE c.applied = false AND c.review_reason = 'awaiting_supervisor'
              ORDER BY c.completed_at DESC NULLS LAST, c.id DESC`
        );
        const allowed = [];
        for (const r of rows) {
            if (await this._mayDecide(user, Number(r.employeeId))) allowed.push(r);
        }
        // Attach what is actually being proposed, recomputed now: a level the
        // employee has since reached on another path must not still be offered.
        const out = [];
        for (const r of allowed) {
            const skills = await this._proposalFor(Number(r.completionId));
            if (skills.length) out.push({ ...r, skills });
        }
        void RBACService; // required above for the scope helpers it exposes
        return out;
    }

    /** The still-valid proposals of one completion (target above current). */
    static async _proposalFor(completionId) {
        const c = await db.get('SELECT employee_id, course_id FROM lms_completions WHERE id = ?', [
            completionId,
        ]);
        if (!c || !c.employeeId || !c.courseId) return [];
        const maps = await db.all(
            `SELECT m.skill_id, m.level_delta, s.name AS skill_name
               FROM course_skill_map m JOIN skills s ON s.id = m.skill_id
              WHERE m.course_id = ?`,
            [c.courseId]
        );
        const out = [];
        for (const m of maps) {
            const target = Number(m.levelDelta);
            if (!Number.isInteger(target) || target < 0 || target > 4) continue;
            const cur = await db.get(
                'SELECT current_level FROM skill_assessments WHERE employee_id = ? AND skill_id = ?',
                [c.employeeId, m.skillId]
            );
            const from = cur ? Number(cur.currentLevel) : 0;
            if (from >= target) continue;
            out.push({ skillId: Number(m.skillId), skillName: m.skillName, from, to: target });
        }
        return out;
    }

    /**
     * May this person decide an uplift for that employee? The supervisor or
     * manager who governs them, or an admin holding approve_assessments.
     * Deliberately NOT "any admin": the rule asks for the named person who
     * can judge the work, not for whoever happens to be privileged.
     */
    static async _mayDecide(user, employeeId) {
        if (!user || !employeeId) return false;
        const RBACService = require('./RBACService');
        // NEVER one's own uplift — whichever account is used: an admin account
        // linked to the employee is that same person (3.23.17, B-2).
        const { personIdOf } = require('../utils/personIdentity');
        const self = await personIdOf(user);
        if (self != null && self === Number(employeeId)) return false;
        if (RBACService.isSuperAdmin(user)) return true;
        if (user.userType === 'admin') {
            if (RBACService.isViewer(user)) return false;
            // The permission says WHAT an admin may do, the scope says ON WHOM:
            // approve_assessments alone let a site-bounded admin validate
            // uplifts for every site. Clearance, or the reporting line of the
            // person behind the account (same union the review console uses).
            if (!RBACService.hasPermission(user, 'approve_assessments')) return false;
            if (await RBACService.canAccessEmployee(user, Number(employeeId))) return true;
            const line = await require('./GovernanceService').lineAuthorityEmployeeIds(user);
            return line.some((id) => Number(id) === Number(employeeId));
        }
        const GovernanceService = require('./GovernanceService');
        const EmployeeModel = require('../models/EmployeeModel');
        const personId = await GovernanceService.actingPersonId(user);
        if (!personId) return false;
        return EmployeeModel.governs(personId, Number(employeeId));
    }

    /**
     * Accept or decline a proposed uplift.
     *
     * ACCEPT is the ONLY path in this service that writes skill_assessments,
     * and it happens because a named person said so.
     *
     * Attribution: `skill_assessments.assessed_by` is a NOT NULL foreign key
     * to admins(id), so a supervisor who is an EMPLOYEE cannot be written
     * there — the same constraint SelfAssessmentWorkflowService lives with.
     * The transaction therefore carries the real actor through
     * `db.withActor`, which the history trigger records as actor_type /
     * actor_ref, and the note names the provenance. The deciding human is on
     * the record even where the FK cannot hold them.
     */
    static async decideUplift(user, completionId, decision) {
        const id = Number(completionId);
        const accept = decision === 'accept';
        if (!accept && decision !== 'decline') {
            const e = new Error("decision must be 'accept' or 'decline'");
            e.status = 400;
            throw e;
        }
        const c = await db.get(
            'SELECT id, employee_id, course_id, applied, review_reason FROM lms_completions WHERE id = ?',
            [id]
        );
        if (!c) {
            const e = new Error('Completion not found');
            e.status = 404;
            throw e;
        }
        if (c.applied === true || c.reviewReason !== 'awaiting_supervisor') {
            const e = new Error('This completion is not awaiting a decision');
            e.status = 409;
            throw e;
        }
        if (!(await this._mayDecide(user, Number(c.employeeId)))) {
            const e = new Error('Not authorized: supervisor/manager of this employee only');
            e.status = 403;
            throw e;
        }

        if (!accept) {
            await db.run(
                "UPDATE lms_completions SET applied = false, review_reason = 'declined_by_supervisor' WHERE id = ?",
                [id]
            );
            return { completionId: id, decision: 'decline', raisedSkills: [] };
        }

        const proposals = await this._proposalFor(id);
        const adminId = await this._decidingAdminId(user);
        const raised = [];
        await db.withActor(user, async () => {
            for (const p of proposals) {
                await db.run(
                    `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
                     VALUES (?, ?, ?, ?, 'Set from a supervisor-validated training completion')
                     ON CONFLICT (employee_id, skill_id) DO UPDATE SET
                       current_level = EXCLUDED.current_level, assessed_by = EXCLUDED.assessed_by,
                       assessed_at = now(), notes = EXCLUDED.notes`,
                    [c.employeeId, p.skillId, p.to, adminId]
                );
                raised.push(p);
            }
            await db.run(
                'UPDATE lms_completions SET applied = ?, review_reason = NULL WHERE id = ?',
                [raised.length > 0, id]
            );
        });
        // Benches move only once a human has accepted the level.
        if (raised.length) await this._reevaluateSuccessors(Number(c.employeeId));
        return { completionId: id, decision: 'accept', raisedSkills: raised };
    }

    /** The admins(id) the FK can hold for this decider. */
    static async _decidingAdminId(user) {
        if (user && user.userType === 'admin' && user.id) return user.id;
        return this._systemAdminId();
    }

    /** Re-evaluate this employee's readiness band wherever they sit on a bench. */
    static async _reevaluateSuccessors(employeeId) {
        try {
            const Cont = require('./ContinuityService');
            const rows = await db.all(
                `SELECT s.id, s.readiness_band AS prev_band, sp.id AS plan_id, sp.position_role_id,
                        sp.owner_admin_id, r.name AS role_name
                 FROM successors s
                 JOIN succession_plans sp ON sp.id = s.plan_id
                 JOIN roles r ON r.id = sp.position_role_id
                 WHERE s.candidate_employee_id = ? AND sp.status <> 'archived' AND s.source <> 'manual'`,
                [employeeId]
            );
            for (const r of rows) {
                const rd = await Cont.readinessForRole(employeeId, r.positionRoleId);
                // readinessForRole now answers pct = null when NOTHING of the role
                // has been assessed for this person (design review: it used to fold
                // every unmeasured requirement in as level 0). A null readiness
                // is not a band: this block used to compute ready_3y from it and
                // persist confidence "0.000" — a candidate struck off the bench
                // on the strength of a measurement that never happened. Leave
                // the existing band untouched and move on.
                if (rd.pct == null) continue;
                const band = Cont.bandFromReadiness(rd.pctExact ?? rd.pct, rd.coveragePct);
                await db.run(
                    'UPDATE successors SET readiness_band = ?, confidence = ?, gap_summary = ?, updated_at = now() WHERE id = ?',
                    [band, (rd.pct / 100).toFixed(3), JSON.stringify(rd.gaps), r.id]
                );
                // Gap-closed: a successor just became Ready-Now → tell the plan owner.
                if (band === 'ready_now' && r.prevBand !== 'ready_now' && r.ownerAdminId) {
                    try {
                        await require('./NotificationService').notify({
                            userType: 'admin',
                            userId: r.ownerAdminId,
                            kind: 'continuity.successor_ready',
                            category: 'talent',
                            payload: { roleName: r.roleName, planId: r.planId, employeeId },
                        });
                    } catch (_) {
                        /* never block on notification */
                    }
                }
            }
        } catch (_) {
            /* continuity optional */
        }
    }

    // ---- Auto-push (gap → mapped course → assignment) ----------------------
    /** Best matching course for a skill, preferring an enabled provider. */
    static async resolveCourseForSkill(skillId) {
        return db.get(
            `SELECT c.* FROM course_skill_map m
             JOIN lms_courses c ON c.id = m.course_id
             LEFT JOIN lms_integrations i ON i.provider = c.provider
             WHERE m.skill_id = ?
             ORDER BY (i.enabled IS TRUE) DESC, m.level_delta DESC, c.id
             LIMIT 1`,
            [skillId]
        );
    }

    /**
     * For each skill gap, if a mapped course exists, auto-enroll the employee.
     * Best-effort and idempotent (assignCourse upserts). Returns the assignments.
     */
    static async autoAssignForSkills(
        employeeId,
        skillIds,
        { assignedBy = null, sourceActionId = null } = {}
    ) {
        // Attribute system-triggered assignments to the system admin so the
        // enrollment audit trail is never null.
        const by = assignedBy != null ? assignedBy : await this._systemAdminId();
        const assigned = [];
        for (const skillId of skillIds || []) {
            try {
                const course = await this.resolveCourseForSkill(skillId);
                if (!course) continue;
                await this.assignCourse(employeeId, course.id, { assignedBy: by, sourceActionId });
                assigned.push({ skillId, courseId: course.id, courseTitle: course.title });
            } catch (_) {
                /* skip this skill */
            }
        }
        return assigned;
    }

    // ---- Curation queue: in-demand skills with NO mapped course ------------
    static async curationQueue(limit = 50) {
        return db.all(
            `WITH demand AS (
                 -- gap_summary deliberately keeps every never-assessed
                 -- requirement, marked with a null current level, so the
                 -- department-designed set is never hidden (ContinuityService
                 -- .scoreRows). Counting those as course demand asks the
                 -- curator to build training for a shortfall nobody has
                 -- observed: on a bench row with 1 measured shortfall and 2
                 -- unassessed requirements this returned 3. A measured
                 -- shortfall is evidence of a training need; an unmeasured
                 -- requirement is a reason to assess, not to buy a course.
                 SELECT (g->>'skillId')::bigint AS skill_id, COUNT(*) AS demand
                 FROM successors s, jsonb_array_elements(s.gap_summary) g
                 WHERE g->>'current' IS NOT NULL
                 GROUP BY 1
                 UNION ALL
                 SELECT o.skill_id, COUNT(*) FROM idp_objectives o
                 WHERE o.skill_id IS NOT NULL GROUP BY o.skill_id
             )
             SELECT d.skill_id, sk.name AS skill_name, SUM(d.demand) AS demand
             FROM demand d JOIN skills sk ON sk.id = d.skill_id
             WHERE NOT EXISTS (SELECT 1 FROM course_skill_map m WHERE m.skill_id = d.skill_id)
             GROUP BY d.skill_id, sk.name
             ORDER BY SUM(d.demand) DESC, sk.name
             LIMIT ?`,
            [limit]
        );
    }

    // ---- Scheduled sync (called by the BullMQ worker) ---------------------
    /**
     * Poll every enabled provider. ONE unusable record (a malformed date, a
     * course that vanished, anything) is skipped and logged — it never aborts
     * the batch. That matters more than it sounds: an aborted batch left
     * last_completion_sync un-advanced, so the same bad record came back on the
     * next tick and the provider never synced again.
     */
    static async runScheduledSync() {
        const integrations = await db.all(
            'SELECT provider, last_completion_sync FROM lms_integrations WHERE enabled = true'
        );
        const summary = [];
        for (const it of integrations) {
            const res = {
                provider: it.provider,
                catalog: 0,
                catalogSkipped: 0,
                completions: 0,
                applied: 0,
                skipped: 0,
                skippedDetail: [],
                error: null,
            };
            try {
                const { connector } = await this._getConnectorFor(it.provider);
                // Catalog
                try {
                    const cat = await this.syncCatalog(it.provider);
                    res.catalog = cat.upserted;
                    res.catalogSkipped = cat.skipped;
                } catch (e) {
                    res.catalogError = e.message;
                }
                // Completions since the last cursor
                const since = it.lastCompletionSync || null;
                const completions = await connector.fetchCompletions(since);
                for (const c of completions) {
                    try {
                        const out = await this._ingestIsolated(it.provider, c);
                        res.completions++;
                        if (out && out.applied) res.applied++;
                    } catch (e) {
                        res.skipped++;
                        const ref = (c && c.externalRef) || '(no ref)';
                        if (res.skippedDetail.length < 20)
                            res.skippedDetail.push({ externalRef: String(ref), error: e.message });
                        console.warn(
                            `[lms] ${it.provider}: skipped completion ${ref} — ${e.message}`
                        );
                    }
                }
                // The cursor advances even when records were skipped: a record we
                // can never ingest must not pin the provider to the same window.
                await db.run(
                    'UPDATE lms_integrations SET last_catalog_sync = now(), last_completion_sync = now() WHERE provider = ?',
                    [it.provider]
                );
            } catch (e) {
                res.error = e.message;
            }
            summary.push(res);
        }
        return summary;
    }

    /**
     * Ingest one record so that its failure costs ONLY that record.
     *
     * At top level ingestCompletion opens its own transaction and a failure
     * rolls back cleanly. But when a caller already holds a transaction, nested
     * runTransaction reuses the client with no savepoint — a failed statement
     * then aborts the OUTER transaction, and "skip and continue" quietly becomes
     * "skip and everything after it fails too". A savepoint restores the
     * per-record guarantee in both cases.
     */
    static async _ingestIsolated(provider, norm) {
        if (!db.inTransaction || !db.inTransaction()) return this.ingestCompletion(provider, norm);
        const sp = `lms_sp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
        await db.run(`SAVEPOINT ${sp}`);
        try {
            const out = await this.ingestCompletion(provider, norm);
            await db.run(`RELEASE SAVEPOINT ${sp}`);
            return out;
        } catch (e) {
            await db.run(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
            await db.run(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
            throw e;
        }
    }

    // ---- Learner surface ---------------------------------------------------
    /**
     * One employee's own learning. Called only with the signed-in person's own
     * id — never with an id taken from the request.
     */
    static async listForEmployee(employeeId) {
        return db.all(
            `SELECT e.id, e.status::text AS status, e.due_at, e.created_at, e.started_at, e.completed_at,
                    e.push_state, e.push_error,
                    c.id AS course_id, c.title AS course_title, c.url AS course_url,
                    c.provider, c.type AS course_type, c.duration_minutes
               FROM lms_enrollments e
               JOIN lms_courses c ON c.id = e.course_id
              WHERE e.employee_id = ?
              ORDER BY (e.status = 'completed'),
                       (e.due_at IS NULL), e.due_at, e.created_at DESC`,
            [employeeId]
        );
    }

    /** One enrolment, but only if it belongs to this employee. */
    static async getOwnEnrollment(employeeId, enrollmentId) {
        return db.get(
            `SELECT e.id, e.employee_id, e.course_id, e.status::text AS status,
                    c.url AS course_url, c.title AS course_title, c.provider
               FROM lms_enrollments e
               JOIN lms_courses c ON c.id = e.course_id
              WHERE e.id = ? AND e.employee_id = ?`,
            [Number(enrollmentId), Number(employeeId)]
        );
    }
}

module.exports = LmsService;
