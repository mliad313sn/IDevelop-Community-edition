/**
 * status-badge.js — the client half of views/partials/status-badge.ejs.
 *
 *   window.StatusBadge.html(tone, label, n, opts)  → HTML string (every value escaped)
 *   window.StatusBadge.el(tone, label, n, opts)    → HTMLElement
 *   window.StatusBadge.tone(state)                 → tone for a workflow state
 *   window.StatusBadge.TONES                       → ['ok','warn','risk','info','neutral','unmeasured','accent']
 *
 * An icon AND a text, never colour alone; the colours are IDevelop's status
 * tokens (style.css `.badge--<tone>`). `opts.text` renders the sentence-case
 * variant, `opts.icon` overrides the Font Awesome class, `opts.title` adds a
 * tooltip, `opts.className` adds classes (escaped like every other value).
 * Workflow states map to tones: draft|pending|not_started → neutral ·
 * submitted|under_review|active|in_progress → info · changes_requested|at_risk|
 * expiring → warn · approved|completed|valid → ok · rejected|cancelled|expired →
 * risk · arbitration|escalated → accent · unmeasured|not_assessed|no_data →
 * unmeasured (the absence of a measurement is never red or green).
 */
(function () {
    'use strict';
    var TONES = ['ok', 'warn', 'risk', 'info', 'neutral', 'unmeasured', 'accent'];
    var ALIAS = new Map([
        ['good', 'ok'],
        ['success', 'ok'],
        ['danger', 'risk'],
        ['error', 'risk'],
        ['warning', 'warn'],
        ['primary', 'accent'],
        ['muted', 'neutral'],
    ]);
    var ICON = {
        ok: 'fa-circle-check',
        warn: 'fa-triangle-exclamation',
        risk: 'fa-circle-xmark',
        info: 'fa-circle-info',
        neutral: 'fa-minus',
        unmeasured: 'fa-circle-question',
        accent: 'fa-diamond',
    };
    var STATE = new Map([
        ['draft', 'neutral'],
        ['pending', 'neutral'],
        ['not_started', 'neutral'],
        ['inactive', 'neutral'],
        ['submitted', 'info'],
        ['under_review', 'info'],
        ['active', 'info'],
        ['in_progress', 'info'],
        ['open', 'info'],
        ['changes_requested', 'warn'],
        ['at_risk', 'warn'],
        ['expiring', 'warn'],
        ['overdue', 'warn'],
        ['partial', 'warn'],
        ['approved', 'ok'],
        ['completed', 'ok'],
        ['closed_success', 'ok'],
        ['valid', 'ok'],
        ['done', 'ok'],
        ['ready', 'ok'],
        ['rejected', 'risk'],
        ['cancelled', 'risk'],
        ['closed_failure', 'risk'],
        ['expired', 'risk'],
        ['failed', 'risk'],
        ['not_ready', 'risk'],
        ['arbitration', 'accent'],
        ['escalated', 'accent'],
        ['unmeasured', 'unmeasured'],
        ['not_assessed', 'unmeasured'],
        ['no_data', 'unmeasured'],
        ['unknown', 'unmeasured'],
    ]);
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function norm(tone) {
        var t = String(tone || '').toLowerCase();
        if (ALIAS.has(t)) t = ALIAS.get(t);
        if (TONES.indexOf(t) < 0) t = STATE.get(t) || 'neutral';
        return t;
    }
    function html(tone, label, n, opts) {
        opts = opts || {};
        var t = norm(tone);
        var icon = opts.icon && /^fa-[a-z0-9-]+$/.test(String(opts.icon)) ? opts.icon : ICON[t];
        var cls =
            'badge badge--' +
            t +
            (opts.text ? ' badge--text' : '') +
            (opts.className ? ' ' + esc(opts.className) : '');
        return (
            '<span class="' +
            cls +
            '" data-tone="' +
            t +
            '"' +
            (opts.title ? ' title="' + esc(opts.title) + '"' : '') +
            '>' +
            '<i class="fas ' +
            esc(icon) +
            ' badge-ic" aria-hidden="true"></i>' +
            '<span class="badge-label">' +
            esc(label) +
            '</span>' +
            (n != null && n !== '' ? '<span class="badge-n">' + esc(n) + '</span>' : '') +
            '</span>'
        );
    }
    function el(tone, label, n, opts) {
        var d = document.createElement('div');
        d.innerHTML = html(tone, label, n, opts);
        return d.firstChild;
    }
    var api = { TONES: TONES, ICON: ICON, tone: norm, html: html, el: el };
    if (typeof window !== 'undefined') window.StatusBadge = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
