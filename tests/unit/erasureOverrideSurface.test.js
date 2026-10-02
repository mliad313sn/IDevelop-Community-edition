'use strict';
/**
 * Erasure under legal hold (migration 166): the surfaces around the two-person
 * override, without a database.
 *   - the routes are SuperAdmin-only and the decision route takes a numeric id;
 *   - the panel partial is included in the maintenance page, carries no inline
 *     handler, and its script binds everything itself;
 *   - the retention purge treats a person-level hold as a skip, not a failure;
 *   - a hold refusal answered by the controller names who, when and why.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('routes', () => {
    const flat = read('src/routes/index.js').replace(/\s+/g, ' ').replace(/\( /g, '(');
    test.each([
        ['get', '/admin/maintenance/dsr/:id(\\\\d+)/erase-status'],
        ['get', '/admin/maintenance/dsr-erase-overrides'],
        ['post', '/admin/maintenance/dsr-erase-override'],
        ['post', '/admin/maintenance/dsr-erase-override/:rid(\\\\d+)/decide'],
    ])('%s %s is SuperAdmin-only', (m, r) => {
        expect(flat).toContain(`router.${m}('${r}', requireSuperAdmin,`);
    });
});

describe('panel', () => {
    test('included once in the maintenance page', () => {
        const page = read('views/pages/admin/maintenance.ejs');
        expect(page.match(/include\('\.\.\/\.\.\/partials\/erase-override'\)/g)).toHaveLength(1);
    });
    test('no inline handler, no javascript: URL; the script is a static file', () => {
        const partial = read('views/partials/erase-override.ejs');
        expect(partial).not.toMatch(/\son[a-z]+\s*=/i);
        expect(partial).not.toMatch(/javascript:/i);
        expect(partial).toMatch(/<script src="\/js\/erase-override\.js" nonce=/);
        const js = read('public/js/erase-override.js');
        expect(js).toMatch(/addEventListener\('submit'/);
        expect(js).toMatch(/'x-csrf-token': CSRF/);
        expect(js).not.toMatch(/innerHTML/);
    });
});

describe('services', () => {
    test('the purge ledgers a person-level hold as skipped_legal_hold', () => {
        const src = read('src/services/DSRService.js');
        expect(src).toMatch(
            /e\.code === 'erasure_legal_hold'\) \{\s*await this\._ledger\(runId, cat, id, effective, 'skipped_legal_hold'/
        );
    });

    test('the controller names who set the hold, when and why', async () => {
        let pending;
        jest.isolateModules(() => {
            jest.doMock('../../src/services/MaintenanceService', () => ({
                dsrErase: async () => {
                    const e = new Error('maintenance_erase_legal_hold');
                    e.userMessage = 'maintenance_erase_legal_hold';
                    e.status = 409;
                    e.expose = true;
                    e.hold = { by: 'admin:3', at: '2026-09-01T10:00:00Z', reason: 'case 12' };
                    throw e;
                },
            }));
            const ctl = require('../../src/controllers/MaintenanceController');
            const en = JSON.parse(read('locales/en/admin.json'));
            const req = {
                user: { id: 1 },
                body: {},
                t: (k, o) => {
                    let s = en[k.split(':')[1]] || k;
                    for (const [n, v] of Object.entries(o || {}))
                        s = s.replace(`{{${n}}}`, String(v));
                    return s;
                },
            };
            const res = {
                code: 200,
                status(c) {
                    this.code = c;
                    return this;
                },
                json(b) {
                    this.body = b;
                    return this;
                },
            };
            pending = ctl.dsrErase(req, res).then(() => {
                expect(res.code).toBe(409);
                expect(res.body.code).toBe('maintenance_erase_legal_hold');
                expect(res.body.error).toContain('admin:3');
                expect(res.body.error).toContain('2026-09-01');
                expect(res.body.error).toContain('case 12');
            });
        });
        await pending;
        expect.hasAssertions();
    });
});
