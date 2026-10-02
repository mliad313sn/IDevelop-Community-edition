'use strict';
/**
 * The small security views that part A and part B left to a later pass, each
 * rendered in French and English with every key present in both catalogues and
 * with no inline handler, no `javascript:` URL and no inline upper-casing:
 *
 *   - the SMTP plaintext-relay warning and its SuperAdmin form (settings page,
 *     dashboard warning only);
 *   - the copilot egress gate: blocked reason, the private-host allow-list, the
 *     recorded transfer basis and the SuperAdmin form;
 *   - the "locked" badge on security-class settings for a local admin, and the
 *     notice above the table;
 *   - the MFA grace banner (layout), never twice with the same warning flash;
 *   - the API-key query-string toggle and its deprecation notice;
 *   - the antivirus card on the health page and the status on the compliance page.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const V = (p) => path.join(ROOT, 'views', p);
const NS = ['admin', 'auth', 'compliance', 'common', 'chrome', 'enums', 'dash', 'talentx'];
const CAT = {};
for (const lang of ['fr', 'en']) {
    CAT[lang] = {};
    for (const ns of NS) {
        const f = path.join(ROOT, 'locales', lang, `${ns}.json`);
        if (fs.existsSync(f)) CAT[lang][ns] = JSON.parse(fs.readFileSync(f, 'utf8'));
    }
}

function translator(lang, missing) {
    return (k, o = {}) => {
        const [ns, key] = String(k).includes(':') ? String(k).split(':') : ['common', k];
        let s = CAT[lang][ns] ? CAT[lang][ns][key] : undefined;
        if (s === undefined && key && CAT[lang][ns]) {
            const plural = CAT[lang][ns][`${key}_${o.count === 1 ? 'one' : 'other'}`];
            if (plural !== undefined) s = plural;
        }
        if (s === undefined || s === '') {
            if (o.defaultValue !== undefined) return o.defaultValue;
            missing.push(k);
            return k;
        }
        return String(s).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n) => (o[n] == null ? '' : o[n]));
    };
}

const common = (lang, missing) => ({
    __: translator(lang, missing),
    csrfToken: 'tok-123',
    cspNonce: 'n0nce',
    assetVersion: '1',
    colon: lang === 'fr' ? ' :' : ':',
    fmtDateTime: (d) => (d ? `DT(${new Date(d).toISOString().slice(0, 10)})` : '—'),
    fmtDate: (d) => (d ? `D(${new Date(d).toISOString().slice(0, 10)})` : '—'),
    enumLabel: (t, v) => `${t}.${v}`,
});

function render(file, locals) {
    return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

function clean(html) {
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/text-transform\s*:\s*uppercase/i);
}

describe.each(['fr', 'en'])('%s', (lang) => {
    let missing;
    beforeEach(() => {
        missing = [];
    });
    afterEach(() => {
        expect(missing).toEqual([]);
    });

    describe('SMTP plaintext relay', () => {
        const relay = {
            active: true,
            host: 'relay.lan',
            reason: 'Legacy relay on the plant network',
            setBy: { id: 1, username: 'root', at: '2026-09-30T10:00:00Z' },
        };
        test('active: warning names the host, the reason and who allowed it; SuperAdmin form', () => {
            const html = render(V('partials/smtp-plaintext-relay.ejs'), {
                ...common(lang, missing),
                smtpRelay: relay,
                showForm: true,
                isSuperAdmin: true,
            });
            clean(html);
            expect(html).toMatch(/id="smtp-plaintext-warning"/);
            expect(html).toMatch(/relay\.lan/);
            expect(html).toMatch(/Legacy relay on the plant network/);
            expect(html).toMatch(/root · DT\(2026-09-30\)/);
            expect(html).toMatch(/action="\/app-settings\/smtp\/plaintext-relay"/);
            expect(html).toMatch(/name="_csrf" value="tok-123"/);
            expect(html).toMatch(/name="reason"[^>]*required/);
            expect(html).toMatch(/value="relay\.lan"/);
        });
        test('a local admin sees the warning, never the form', () => {
            const html = render(V('partials/smtp-plaintext-relay.ejs'), {
                ...common(lang, missing),
                smtpRelay: relay,
                showForm: true,
                isSuperAdmin: false,
            });
            expect(html).toMatch(/smtp-plaintext-warning/);
            expect(html).not.toMatch(/<form/);
        });
        test('none: no warning; the form says TLS is required everywhere', () => {
            const html = render(V('partials/smtp-plaintext-relay.ejs'), {
                ...common(lang, missing),
                smtpRelay: { active: false },
                showForm: true,
                isSuperAdmin: true,
            });
            expect(html).not.toMatch(/smtp-plaintext-warning/);
            expect(html).toContain(CAT[lang].admin.smtp_relay_none);
        });
    });

    describe('copilot egress gate', () => {
        const base = {
            provider: 'ollama',
            host: '10.0.0.5:11434',
            configured: true,
            allowed: false,
            external: false,
            blockedCode: 'private_host',
            needsTransferBasis: false,
            record: null,
            bases: ['adequacy', 'sccs', 'consent', 'authorization', 'other'],
            allowedPrivateHosts: [],
            trustedHosts: [],
        };
        test('private host refused: the reason and an empty allow-list', () => {
            const html = render(V('partials/copilot-egress-gate.ejs'), {
                ...common(lang, missing),
                copilotPolicy: base,
                isSuperAdmin: true,
            });
            clean(html);
            expect(html).toMatch(/data-copilot-blocked="private_host"/);
            expect(html).toContain(CAT[lang].admin.cpg_reason_private_host);
            expect(html).toContain(CAT[lang].admin.cpg_private_hosts_none);
        });
        test('allowed private hosts are listed', () => {
            const html = render(V('partials/copilot-egress-gate.ejs'), {
                ...common(lang, missing),
                copilotPolicy: {
                    ...base,
                    allowed: true,
                    blockedCode: null,
                    allowedPrivateHosts: ['localhost:11434'],
                    trustedHosts: ['llm.lan'],
                },
                isSuperAdmin: false,
            });
            expect(html).toMatch(/<code class="hz-sec-chip">localhost:11434<\/code>/);
            expect(html).toMatch(/<code class="hz-sec-chip">llm\.lan<\/code>/);
            expect(html).toContain(CAT[lang].admin.cpg_enabled_local);
        });
        test('external provider without a basis: the SuperAdmin form, nobody else', () => {
            const policy = {
                ...base,
                provider: 'mistral',
                host: 'api.mistral.ai',
                external: true,
                blockedCode: 'transfer_basis_missing',
                needsTransferBasis: true,
            };
            const sa = render(V('partials/copilot-egress-gate.ejs'), {
                ...common(lang, missing),
                copilotPolicy: policy,
                isSuperAdmin: true,
            });
            clean(sa);
            expect(sa).toMatch(/action="\/app-settings\/copilot\/transfer-basis"/);
            expect(sa).toMatch(/name="dpaAcknowledged"[^>]*required/);
            expect(sa).toMatch(/<option value="sccs">/);
            expect(sa).toContain(CAT[lang].admin.cpg_no_record);
            const local = render(V('partials/copilot-egress-gate.ejs'), {
                ...common(lang, missing),
                copilotPolicy: policy,
                isSuperAdmin: false,
            });
            expect(local).not.toMatch(/<form/);
        });
        test('a recorded basis is shown with who recorded it, and can be withdrawn', () => {
            const html = render(V('partials/copilot-egress-gate.ejs'), {
                ...common(lang, missing),
                copilotPolicy: {
                    ...base,
                    provider: 'mistral',
                    host: 'api.mistral.ai',
                    allowed: true,
                    external: true,
                    blockedCode: null,
                    record: {
                        provider: 'mistral',
                        host: 'api.mistral.ai',
                        basis: 'adequacy',
                        basisText: 'EU processor, DPA signed 2026-01',
                        region: 'EU (France)',
                        recordedBy: { username: 'root' },
                        recordedAt: '2026-09-01T08:00:00Z',
                    },
                },
                isSuperAdmin: true,
            });
            expect(html).toContain(CAT[lang].admin.cpg_basis_adequacy);
            expect(html).toMatch(/EU processor, DPA signed 2026-01/);
            expect(html).toMatch(/root · DT\(2026-09-01\)/);
            expect(html).toMatch(/action="\/app-settings\/copilot\/transfer-basis\/revoke"/);
        });
        test('no provider configured: nothing', () => {
            const html = render(V('partials/copilot-egress-gate.ejs'), {
                ...common(lang, missing),
                copilotPolicy: { ...base, configured: false },
                isSuperAdmin: true,
            });
            expect(html.trim()).toBe('');
        });
    });

    describe('API keys page', () => {
        const keys = [
            {
                id: 3,
                label: 'Power BI legacy',
                scope: 'powerbi.read',
                createdAt: '2026-01-01',
                lastUsedAt: null,
                expiresAt: null,
                revokedAt: null,
                allowQueryKey: true,
                expired: false,
            },
            {
                id: 4,
                label: 'SCIM',
                scope: 'scim.write',
                createdAt: '2026-01-01',
                lastUsedAt: null,
                expiresAt: null,
                revokedAt: null,
                allowQueryKey: false,
                expired: false,
            },
        ];
        test('a key still accepted in the URL: deprecation notice, badge and toggle', () => {
            const html = render(V('pages/admin/api-keys.ejs'), {
                ...common(lang, missing),
                keys,
                admins: [],
            });
            clean(html);
            expect(html).toMatch(/data-apikey-query-deprecation/);
            expect(html).toMatch(/data-on-click="AK\.setQuery" data-args="\[3,false\]"/);
            expect(html).toMatch(/data-on-click="AK\.setQuery" data-args="\[4,true\]"/);
            expect(html).toContain(CAT[lang].admin.apik_query_block_btn);
            expect(html).toContain(CAT[lang].admin.apik_query_allow_btn);
            expect(html).toMatch(/\/api\/v1\/admin\/api-keys\/'\+Number\(id\)\+'\/query-string/);
            expect(html).toMatch(/X-API-Key/);
        });
        test('header-only keys: no deprecation notice', () => {
            const html = render(V('pages/admin/api-keys.ejs'), {
                ...common(lang, missing),
                keys: [keys[1]],
                admins: [],
            });
            expect(html).not.toMatch(/data-apikey-query-deprecation/);
        });
    });

    describe('compliance page antivirus status', () => {
        const src = fs.readFileSync(V('pages/compliance/index.ejs'), 'utf8');
        test('the status card and the native form carry what they need', () => {
            expect(src).toMatch(/data-compliance-av=/);
            expect(src).toMatch(/compliance:av_no_scanner_alert/);
            expect(src).toMatch(/compliance:av_engine_on/);
            expect(src).toMatch(
                /action="\/compliance\/certifications\?_csrf=<%= encodeURIComponent\(csrfToken\) %>"/
            );
            expect(CAT[lang].compliance.av_engine_on).toMatch(/\{\{engine\}\}/);
        });
    });
});

describe('views wired to their controllers', () => {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    test('app-settings: locked badge, notice, relay and egress partials', () => {
        const s = read('views/pages/app-settings/index.ejs');
        expect(s).toMatch(/<% if \(setting\.locked\) \{ %>[\s\S]*?data-setting-locked/);
        expect(s).toMatch(/admin:set_security_locked_hint/);
        expect(s).toMatch(/data-settings-locked-notice/);
        expect(s).toMatch(/include\('\.\.\/\.\.\/partials\/smtp-plaintext-relay'/);
        expect(s).toMatch(/include\('\.\.\/\.\.\/partials\/copilot-egress-gate'/);
    });
    test('dashboard: the relay warning only', () => {
        expect(read('views/pages/dashboard.ejs')).toMatch(
            /include\('\.\.\/partials\/smtp-plaintext-relay', \{ smtpRelay: smtpRelay, showForm: false/
        );
    });
    test('health: the antivirus tile and section read malwareScan', () => {
        const s = read('views/pages/admin/health.ejs');
        expect(s).toMatch(/data-health-av/);
        expect(s).toMatch(/id="malware-scan"/);
        expect(s).toMatch(/admin:health_av_st_not_scanned/);
    });
    test('layout: the MFA grace banner is skipped when the same warning flash shows', () => {
        const s = read('views/layouts/main.ejs');
        expect(s).toMatch(/mfaGrace\.daysLeft/);
        expect(s).toMatch(/warnings\.indexOf\(_mgText\) !== -1/);
        expect(s).toMatch(/href="\/v2\/uam\/mfa\/setup"/);
    });
    test('the compliance controller passes the scan status to uploaders only', () => {
        const s = read('src/controllers/ComplianceController.js');
        expect(s).toMatch(
            /if \(canRecord \|\| canConfigure\) \{[\s\S]*?MalwareScanService'\)\.status\(\)/
        );
        expect(s).toMatch(/malwareScan,/);
    });
    test('policyStatus exposes the private-host allow-list', () => {
        expect(read('src/services/CopilotService.js')).toMatch(
            /allowedPrivateHosts,\s*trustedHosts,/
        );
    });
});

describe('the MFA grace banner renders in the layout', () => {
    // Render only the banner block of the layout, with the layout's own source.
    const src = fs.readFileSync(V('layouts/main.ejs'), 'utf8');
    const start = src.indexOf('<%# Two-factor grace countdown');
    const end = src.indexOf('<% if (typeof entitlement');
    const block = src.slice(start, end);
    test.each(['fr', 'en'])('%s: once, with the date, the count and the set-up link', (lang) => {
        const missing = [];
        const t = translator(lang, missing);
        const mfaGrace = { daysLeft: 3, date: '12/10/2026' };
        const html = ejs.render(block, { __: t, mfaGrace });
        clean(html);
        expect(html).toMatch(/id="mfa-grace-banner"/);
        expect(html).toMatch(/12\/10\/2026/);
        expect(html).toMatch(/\b3\b/);
        const flashed = t('auth:mfa_grace_notice', { count: 3, date: '12/10/2026' });
        expect(ejs.render(block, { __: t, mfaGrace, warnings: [flashed] })).not.toMatch(
            /mfa-grace-banner/
        );
        expect(ejs.render(block, { __: t, mfaGrace: null })).not.toMatch(/mfa-grace-banner/);
        expect(missing).toEqual([]);
    });
});
