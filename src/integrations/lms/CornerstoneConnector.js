'use strict';

const LmsConnector = require('./LmsConnector');

// Module-level token cache keyed by tenant+client. The connector is
// re-instantiated per request, so an instance-only cache would never hit.
const TOKEN_CACHE = new Map();

/**
 * CornerstoneConnector — Cornerstone OnDemand (CSOD) adapter.
 *
 * Auth: OAuth2 client_credentials (Edge "Manage API Credentials"). Token cached
 * until expiry, keyed per tenant+client. Client auth defaults to client_secret_post
 * (credentials in the form body); set auth_config.token_auth = 'basic' for
 * client_secret_basic (HTTP Basic header).
 *
 * Endpoints + params are tenant/API-version specific, so all are configurable via
 * auth_config with CSOD-sensible defaults:
 *   token_path      (default /services/api/oauth2/token)
 *   token_auth      ('body' | 'basic', default 'body')
 *   scope           (OAuth2 scopes granted to the credential)
 *   catalog_path    (default /services/api/x/odata/api/views/vw_rpt_training_object)
 *   transcript_path (default /services/api/x/odata/api/views/vw_rpt_transcript)
 *   assign_path     (default /services/api/x/training/v1/transcripts)
 *   launch_path     (default /ui/lms-learner-home/details)
 *   since_param     (default 'modifiedAfter'), status_param (default 'status')
 *   extra_headers   (object merged into every API request)
 *   max_pages       (pagination safety cap, default 100)
 *
 * Pagination: CSOD OData responses carry "@odata.nextLink"; REST responses carry
 * "nextPage"/"next". _fetchAllPages follows them so the FULL catalogue / transcript
 * set is returned, not just the first page. Field readers cover PascalCase (REST),
 * camelCase, AND the snake_case columns of CSOD reporting OData views.
 */
class CornerstoneConnector extends LmsConnector {
    get provider() {
        return 'cornerstone';
    }

    // ---- OAuth2 -----------------------------------------------------------
    async _accessToken() {
        const now = Date.now();
        const a = this.authConfig;
        if (!a.client_id || !a.client_secret)
            throw new Error('cornerstone: client_id/client_secret not configured');
        const cacheKey = `${this.base()}|${a.client_id}`;
        const cached = TOKEN_CACHE.get(cacheKey);
        if (cached && cached.exp > now + 30000) return cached.value;

        const tokenUrl =
            a.token_url || this.base() + (a.token_path || '/services/api/oauth2/token');
        const opts = { method: 'POST', headers: {} };
        if (String(a.token_auth).toLowerCase() === 'basic') {
            // client_secret_basic: credentials in the Authorization header.
            opts.headers.Authorization =
                'Basic ' + Buffer.from(`${a.client_id}:${a.client_secret}`).toString('base64');
            opts.form = { grant_type: 'client_credentials', scope: a.scope || '' };
        } else {
            // client_secret_post (CSOD default): credentials in the body.
            opts.form = {
                grant_type: 'client_credentials',
                client_id: a.client_id,
                client_secret: a.client_secret,
                scope: a.scope || '',
            };
        }
        const json = await this.httpJson(tokenUrl, opts);
        const ttl = (json && json.expires_in ? Number(json.expires_in) : 3600) * 1000;
        const entry = { value: json && (json.access_token || json.accessToken), exp: now + ttl };
        if (!entry.value) throw new Error('cornerstone: token endpoint returned no access_token');
        TOKEN_CACHE.set(cacheKey, entry);
        return entry.value;
    }

    async _authedHeaders() {
        return {
            Authorization: 'Bearer ' + (await this._accessToken()),
            ...(this.authConfig.extra_headers || {}),
        };
    }

    async testConnection() {
        try {
            await this._accessToken();
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    // ---- Pagination -------------------------------------------------------
    /** Follow @odata.nextLink / nextPage / next across pages and flatten items. */
    async _fetchAllPages(firstUrl, { headers } = {}) {
        const out = [];
        const cap = Number(this.authConfig.max_pages) || 100;
        let url = firstUrl;
        let pages = 0;
        while (url && pages < cap) {
            const json = await this.httpJson(url, { headers });
            const items =
                (json &&
                    (json.value ||
                        json.data ||
                        json.Data ||
                        json.LearningObjects ||
                        (Array.isArray(json) ? json : []))) ||
                [];
            for (const it of items) out.push(it);
            pages++;
            let next =
                json &&
                (json['@odata.nextLink'] ||
                    json.nextLink ||
                    json.nextPage ||
                    json.next ||
                    (json.Pagination && json.Pagination.nextPage));
            if (next) {
                next = String(next);
                url = /^https?:/i.test(next)
                    ? next
                    : this.base() + (next.startsWith('/') ? next : '/' + next);
            } else {
                url = null;
            }
        }
        return out;
    }

    // ---- Catalog ----------------------------------------------------------
    _normalizeCourse(c) {
        // Cover REST PascalCase, camelCase, and CSOD reporting-view snake_case.
        const ext = c.ObjectId || c.LOID || c.loId || c.lo_object_id || c.object_id || c.id || c.Id;
        const title = c.Title || c.title || c.Name || c.LOName || c.lo_title;
        if (!ext || !title) return null;
        return {
            externalId: LmsConnector.str(ext),
            title: LmsConnector.str(title),
            url: c.DeepLink || c.Url || c.url || c.lo_deeplink_url || null,
            type: c.Type || c.LOType || c.lo_type || 'course',
            durationMinutes: LmsConnector.num(c.DurationMinutes || c.Duration || c.lo_duration_min),
            competencyTags: c.Subjects || c.Competencies || c.tags || c.lo_subjects || [],
        };
    }

    async fetchCatalog() {
        const a = this.authConfig;
        const url =
            this.base() +
            (a.catalog_path || '/services/api/x/odata/api/views/vw_rpt_training_object');
        const items = await this._fetchAllPages(url, { headers: await this._authedHeaders() });
        return items.map((c) => this._normalizeCourse(c)).filter(Boolean);
    }

    // ---- Completions (polling) -------------------------------------------
    _normalizeTranscript(t) {
        const email = t.UserEmail || t.userEmail || t.Email || t.user_email || t.user_email_address;
        const courseId =
            t.ObjectId || t.LOID || t.loId || t.lo_object_id || t.object_id || t.transc_object_id;
        const status = String(
            t.Status || t.TranscriptStatus || t.transc_status || ''
        ).toLowerCase();
        if (!email || !courseId || (!status.includes('complet') && !status.includes('pass')))
            return null;
        const completedAt =
            t.CompletionDate || t.CompletedDate || t.transc_comp_dt || t.completion_date || null;
        return {
            externalRef: LmsConnector.str(
                t.TranscriptId ||
                    t.Id ||
                    t.transc_id ||
                    t.transcript_id ||
                    `${email}|${courseId}|${completedAt || ''}`
            ),
            employeeEmail: email,
            externalCourseId: LmsConnector.str(courseId),
            completedAt,
            score: LmsConnector.num(t.Score != null ? t.Score : t.transc_score),
            certId: LmsConnector.str(t.CertificateId || t.certificate_id),
            raw: t,
        };
    }

    async fetchCompletions(since) {
        const a = this.authConfig;
        const url = new URL(
            this.base() + (a.transcript_path || '/services/api/x/odata/api/views/vw_rpt_transcript')
        );
        url.searchParams.set(a.status_param || 'status', a.status_value || 'Completed');
        if (since)
            url.searchParams.set(a.since_param || 'modifiedAfter', new Date(since).toISOString());
        const items = await this._fetchAllPages(url.toString(), {
            headers: await this._authedHeaders(),
        });
        return items.map((t) => this._normalizeTranscript(t)).filter(Boolean);
    }

    // ---- Outbound assignment ---------------------------------------------
    async assignCourse(employee, courseRef) {
        const a = this.authConfig;
        if (!employee || !employee.email)
            return { supported: true, error: 'employee email required' };
        try {
            const url =
                this.base() +
                (a.assign_path || a.transcript_path || '/services/api/x/training/v1/transcripts');
            const json = await this.httpJson(url, {
                method: 'POST',
                headers: await this._authedHeaders(),
                body: { UserEmail: employee.email, LOID: courseRef, Status: 'Registered' },
            });
            return {
                supported: true,
                externalRef: LmsConnector.str(
                    json && (json.TranscriptId || json.Id || (json.data && json.data.TranscriptId))
                ),
            };
        } catch (e) {
            return { supported: true, error: e.message };
        }
    }

    getLaunchUrl(employee, courseRef) {
        if (!this.base()) return null;
        const a = this.authConfig;
        return (
            this.base() +
            (a.launch_path || '/ui/lms-learner-home/details') +
            '/' +
            encodeURIComponent(courseRef)
        );
    }

    // Inbound webhook — covers REST PascalCase/camelCase + snake_case payloads.
    normalizeWebhook(p) {
        if (!p) return null;
        const email =
            p.userEmail ||
            p.email ||
            p.user_email ||
            p.UserEmail ||
            (p.user && p.user.email) ||
            null;
        const courseId =
            p.objectId ||
            p.loId ||
            p.courseId ||
            p.trainingId ||
            p.lo_object_id ||
            p.ObjectId ||
            null;
        if (!email || !courseId) return null;
        const status = String(
            p.status || p.transcriptStatus || p.transc_status || 'Completed'
        ).toLowerCase();
        if (!status.includes('complet') && !status.includes('pass')) return null;
        const completedAt = p.completionDate || p.completedAt || p.transc_comp_dt || null;
        return {
            externalRef: LmsConnector.str(
                p.transcriptId || p.id || p.transc_id || `${email}|${courseId}|${completedAt || ''}`
            ),
            employeeEmail: email,
            externalCourseId: LmsConnector.str(courseId),
            completedAt,
            score: LmsConnector.num(p.score),
            certId: LmsConnector.str(p.certificateId || p.certificateNumber),
            raw: p,
        };
    }
}

module.exports = CornerstoneConnector;
