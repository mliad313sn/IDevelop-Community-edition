'use strict';

const LmsConnector = require('./LmsConnector');

/**
 * MyPathConnector — MyPath LMS adapter (Phase 4). REST + bearer/API-key auth.
 * Configurable paths via auth_config:
 *   catalog_path     (default /api/v1/catalog)
 *   completions_path (default /api/v1/completions)
 *   assign_path      (default /api/v1/assignments)
 *   launch_path      (default /learn)
 */
class MyPathConnector extends LmsConnector {
    get provider() {
        return 'mypath';
    }

    _headers() {
        const a = this.authConfig;
        const h = {};
        if (a.token || a.api_key) h.Authorization = 'Bearer ' + (a.token || a.api_key);
        if (a.api_key_header && a.api_key) h[a.api_key_header] = a.api_key;
        return h;
    }

    async testConnection() {
        if (!this.base()) return { ok: false, error: 'base_url not set' };
        try {
            await this.httpJson(this.base() + (this.authConfig.health_path || '/api/v1/ping'), {
                headers: this._headers(),
            });
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    _normalizeCourse(c) {
        const ext = c.pathId || c.id || c.courseId || c.itemId;
        const title = c.title || c.name;
        if (!ext || !title) return null;
        return {
            externalId: LmsConnector.str(ext),
            title: LmsConnector.str(title),
            url: c.url || c.link || null,
            type: c.type || 'path',
            durationMinutes: LmsConnector.num(c.durationMinutes || c.minutes),
            competencyTags: c.skills || c.tags || [],
        };
    }

    async fetchCatalog() {
        const url = this.base() + (this.authConfig.catalog_path || '/api/v1/catalog');
        const json = await this.httpJson(url, { headers: this._headers() });
        const items = json && (json.items || json.data || (Array.isArray(json) ? json : []));
        return (items || []).map((c) => this._normalizeCourse(c)).filter(Boolean);
    }

    async fetchCompletions(since) {
        const url = new URL(
            this.base() + (this.authConfig.completions_path || '/api/v1/completions')
        );
        if (since) url.searchParams.set('since', new Date(since).toISOString());
        const json = await this.httpJson(url.toString(), { headers: this._headers() });
        const items = json && (json.items || json.data || (Array.isArray(json) ? json : []));
        return (items || []).map((p) => this.normalizeWebhook(p)).filter(Boolean);
    }

    async assignCourse(employee, courseRef) {
        if (!employee || !employee.email)
            return { supported: true, error: 'employee email required' };
        try {
            const url = this.base() + (this.authConfig.assign_path || '/api/v1/assignments');
            const json = await this.httpJson(url, {
                method: 'POST',
                headers: this._headers(),
                body: { learnerEmail: employee.email, pathId: courseRef },
            });
            return {
                supported: true,
                externalRef: LmsConnector.str(json && (json.assignmentId || json.id)),
            };
        } catch (e) {
            return { supported: true, error: e.message };
        }
    }

    getLaunchUrl(employee, courseRef) {
        if (!this.base()) return null;
        return (
            this.base() +
            (this.authConfig.launch_path || '/learn') +
            '/' +
            encodeURIComponent(courseRef)
        );
    }

    normalizeWebhook(p) {
        if (!p) return null;
        const email = p.learnerEmail || p.email || p.userEmail || null;
        const courseId = p.pathId || p.courseId || p.itemId || null;
        if (!email || !courseId) return null;
        const status = String(p.status || p.state || 'completed').toLowerCase();
        if (!status.includes('complet') && !status.includes('pass')) return null;
        return {
            externalRef: LmsConnector.str(p.completionId || p.id || `${email}|${courseId}`),
            employeeEmail: email,
            externalCourseId: LmsConnector.str(courseId),
            completedAt: p.completedAt || p.completedOn || null,
            score: LmsConnector.num(p.score),
            certId: LmsConnector.str(p.certificateId),
            raw: p,
        };
    }
}

module.exports = MyPathConnector;
