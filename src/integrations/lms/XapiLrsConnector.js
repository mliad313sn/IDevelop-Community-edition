'use strict';

const LmsConnector = require('./LmsConnector');

/**
 * XapiLrsConnector — standards-first adapter. Any conformant LMS/LRS that emits
 * xAPI statements can connect with zero vendor code: completions arrive as xAPI
 * "completed/passed" statements (via webhook or by polling the LRS statements
 * endpoint). This is what delivers "full compatibility" for any LMS of the market.
 */
class XapiLrsConnector extends LmsConnector {
    get provider() {
        return 'xapi';
    }

    _authHeader() {
        const a = this.config.auth_config || this.config.authConfig || {};
        if (a.basic) return 'Basic ' + Buffer.from(a.basic).toString('base64');
        if (a.username && a.password)
            return 'Basic ' + Buffer.from(`${a.username}:${a.password}`).toString('base64');
        if (a.token) return 'Bearer ' + a.token;
        return null;
    }

    async testConnection() {
        if (!this.config.base_url) return { ok: false, error: 'base_url not set' };
        try {
            const res = await this.fetchImpl(this.config.base_url.replace(/\/$/, '') + '/about', {
                headers: { 'X-Experience-API-Version': '1.0.3' },
            });
            return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    async fetchCompletions(since) {
        if (!this.config.base_url) return [];
        const url = new URL(this.config.base_url.replace(/\/$/, '') + '/statements');
        url.searchParams.set('verb', 'http://adlnet.gov/expapi/verbs/completed');
        if (since) url.searchParams.set('since', new Date(since).toISOString());
        const headers = { 'X-Experience-API-Version': '1.0.3' };
        const auth = this._authHeader();
        if (auth) headers.Authorization = auth;
        try {
            const res = await this.fetchImpl(url, { headers });
            if (!res.ok) return [];
            const body = await res.json();
            const statements = Array.isArray(body) ? body : body.statements || [];
            return statements.map((s) => this.normalizeWebhook(s)).filter(Boolean);
        } catch (_) {
            return [];
        }
    }

    /** Parse an xAPI statement into a normalized completion (or null). */
    normalizeWebhook(stmt) {
        if (!stmt || !stmt.verb || !stmt.object) return null;
        const verbId = String(stmt.verb.id || '').toLowerCase();
        const completed =
            verbId.includes('completed') ||
            verbId.includes('passed') ||
            (stmt.result && stmt.result.completion === true);
        if (!completed) return null;

        const actor = stmt.actor || {};
        const email =
            (actor.mbox ? String(actor.mbox).replace(/^mailto:/, '') : null) ||
            (actor.account && actor.account.name) ||
            null;
        const obj = stmt.object || {};
        const externalCourseId =
            obj.id ||
            (obj.definition && obj.definition.name && Object.values(obj.definition.name)[0]) ||
            null;

        let score = null;
        if (stmt.result && stmt.result.score) {
            score =
                stmt.result.score.scaled != null
                    ? Math.round(stmt.result.score.scaled * 100)
                    : stmt.result.score.raw != null
                      ? stmt.result.score.raw
                      : null;
        }
        return {
            externalRef:
                LmsConnector.str(stmt.id) || `${email}|${externalCourseId}|${stmt.timestamp || ''}`,
            employeeEmail: email,
            externalCourseId: LmsConnector.str(externalCourseId),
            completedAt: stmt.timestamp || null,
            score,
            certId: null,
            raw: stmt,
        };
    }
}

module.exports = XapiLrsConnector;
