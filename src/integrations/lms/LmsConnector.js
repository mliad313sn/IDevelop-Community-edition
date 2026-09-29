'use strict';

/**
 * LmsConnector — abstract base every LMS adapter implements. Keeps the rest of
 * the platform vendor-agnostic: the LmsService only ever talks to this contract,
 * so a new LMS = a new subclass, and the whole layer lifts out cleanly to the
 * 360 learning-integration microservice later.
 *
 * Normalized shapes the platform expects:
 *   Course     : { externalId, title, url, type, durationMinutes, competencyTags[] }
 *   Completion : { externalRef, employeeEmail, externalCourseId, completedAt, score, certId, raw }
 */
class LmsConnector {
    constructor(config = {}) {
        this.config = config || {};
    }

    /** Stable provider key — overridden by each adapter. */
    get provider() {
        return 'base';
    }

    /** @returns {Promise<{ok:boolean,error?:string}>} */
    async testConnection() {
        return { ok: false, error: 'not implemented' };
    }

    /** @returns {Promise<Array>} normalized courses */
    async fetchCatalog() {
        return [];
    }

    /** @param {Date|string|null} since @returns {Promise<Array>} normalized completions */
    async fetchCompletions(/* since */) {
        return [];
    }

    /** Outbound assignment. @returns {Promise<{supported:boolean,externalRef?:string,error?:string}>} */
    async assignCourse(/* employee, courseRef */) {
        return { supported: false };
    }

    /** Deep-link / LTI launch URL carrying identity, or null if unsupported. */
    getLaunchUrl(/* employee, courseRef */) {
        return null;
    }

    /** Normalize an inbound webhook/statement to ONE completion shape, or null. */
    normalizeWebhook(/* payload */) {
        return null;
    }

    // --- small shared helpers -------------------------------------------------
    static str(v) {
        return v == null ? null : String(v);
    }
    static num(v) {
        return v == null || v === '' ? null : Number(v);
    }

    /** fetch implementation — overridable via config._fetch for testing. */
    get fetchImpl() {
        return this.config._fetch || globalThis.fetch;
    }

    get authConfig() {
        return this.config.auth_config || this.config.authConfig || {};
    }

    /** JSON HTTP helper with form/bearer support and status-aware errors. */
    async httpJson(url, { method = 'GET', headers = {}, body, form } = {}) {
        // redirect:'manual' — the base URL is SSRF-checked at save time, but a 3xx could
        // still bounce the request to an internal/loopback host at call time. Refuse to
        // auto-follow; a legitimate LMS shouldn't redirect its API calls.
        const opts = {
            method,
            redirect: 'manual',
            headers: { Accept: 'application/json', ...headers },
        };
        if (form) {
            opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            opts.body = new URLSearchParams(form).toString();
        } else if (body != null) {
            opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
            opts.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        // Bound the call so a hung LMS endpoint can't stall the sync worker.
        const timeoutMs = Number(this.config.timeout_ms) || 15000;
        let timer = null;
        if (typeof AbortController === 'function' && !opts.signal) {
            const ctrl = new AbortController();
            opts.signal = ctrl.signal;
            timer = setTimeout(() => ctrl.abort(), timeoutMs);
        }
        let res;
        try {
            res = await this.fetchImpl(url, opts);
        } finally {
            if (timer) clearTimeout(timer);
        }
        const text = res.text ? await res.text() : '';
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        if (!res.ok) {
            const err = new Error(
                `HTTP ${res.status}${json && json.message ? ': ' + json.message : ''}`
            );
            err.status = res.status;
            err.body = json || text;
            throw err;
        }
        return json;
    }

    base() {
        return String(this.config.base_url || '').replace(/\/$/, '');
    }
}

module.exports = LmsConnector;
