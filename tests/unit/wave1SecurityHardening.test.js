'use strict';
/**
 * WAVE 1 — security & access hardening.
 *
 *  1. `view_employees` — employee PII becomes a WITHHOLDABLE read capability
 *     (there was no such slug: permissions.js referenced one in prose only).
 *  2. utils/apiErrors — the talent JSON controllers returned `err.message` for
 *     every throw, so raw PostgreSQL text ("invalid input syntax for type
 *     bigint", constraint and relation names) reached the browser, bypassing
 *     errorHandler's environment gate.
 *  3. errorHandler's 5xx verbosity is keyed on appConfig.env (the boot-time
 *     snapshot), not the mutable process.env.NODE_ENV.
 */

describe('permissions catalogue — view_employees', () => {
    const P = require('../../src/config/permissions');
    const fs = require('fs');
    const path = require('path');

    test('the slug exists, is READ-only and sits in the people group', () => {
        expect(P.isValidSlug('view_employees')).toBe(true);
        expect(P.isWrite('view_employees')).toBe(false);
        expect(P.WRITE_SLUGS.has('view_employees')).toBe(false);
        expect(P.BY_SLUG.view_employees.group).toBe('people_assessments');
        expect(P.GROUPS).toContain('people_assessments');
    });

    test('a VIEWER can hold it — that is the point of a read capability', () => {
        // requirePermission ignores write grants for viewers; a read slug is the
        // only kind a read-only account can usefully be delegated.
        expect(P.isWrite('view_employees')).toBe(false);
    });

    test('edit_employees and manage_employees IMPLY it, so existing delegations keep working', () => {
        // This is the backfill: no data migration, expandSlugs does it at session
        // build time (auth.js deserializeUser).
        expect(P.expandSlugs(['edit_employees'])).toContain('view_employees');
        expect(P.expandSlugs(['manage_employees'])).toContain('view_employees');
        // …and manage_employees still implies everything it used to.
        expect(P.expandSlugs(['manage_employees'])).toEqual(
            expect.arrayContaining(['edit_employees', 'reset_employee_password', 'view_employees'])
        );
    });

    test('holding it alone does NOT grant any write capability', () => {
        expect(P.expandSlugs(['view_employees'])).toEqual(['view_employees']);
    });

    test('it has FR + EN label/desc (an unlocalized slug prints a raw key)', () => {
        for (const lng of ['fr', 'en']) {
            const file = path.join(__dirname, '..', '..', 'locales', lng, 'admin.json');
            const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
            expect(dict.perm.view_employees).toBeDefined();
            expect(typeof dict.perm.view_employees.label).toBe('string');
            expect(dict.perm.view_employees.label.length).toBeGreaterThan(0);
            expect(typeof dict.perm.view_employees.desc).toBe('string');
            expect(dict.perm.view_employees.desc.length).toBeGreaterThan(0);
        }
    });

    test('every catalogue slug is still localized in BOTH locales (no orphan)', () => {
        for (const lng of ['fr', 'en']) {
            const dict = JSON.parse(
                fs.readFileSync(
                    path.join(__dirname, '..', '..', 'locales', lng, 'admin.json'),
                    'utf8'
                )
            );
            const missing = P.ALL_SLUGS.filter(
                (s) => !dict.perm || !dict.perm[s] || !dict.perm[s].label || !dict.perm[s].desc
            );
            expect(missing).toEqual([]);
        }
    });
});

describe('utils/apiErrors — no raw DB text reaches the client', () => {
    const E = require('../../src/utils/apiErrors');

    const pgError = (message, code) =>
        Object.assign(new Error(message), {
            code,
            severity: 'ERROR',
            routine: 'errorMissingColumn',
        });

    test('a PostgreSQL error is classified INTERNAL by its SQLSTATE shape', () => {
        expect(E.isInternal(pgError('invalid input syntax for type bigint: "abc"', '22P02'))).toBe(
            true
        );
        expect(
            E.isInternal(
                pgError(
                    'duplicate key value violates unique constraint "uq_idp_open_per_employee"',
                    '23505'
                )
            )
        ).toBe(true);
        expect(
            E.isInternal(
                Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { errno: -4078 })
            )
        ).toBe(true);
    });

    test('programming faults are INTERNAL too', () => {
        expect(
            E.isInternal(new TypeError("Cannot read properties of undefined (reading 'id')"))
        ).toBe(true);
        expect(E.isInternal(new RangeError('Maximum call stack size exceeded'))).toBe(true);
        expect(E.isInternal(null)).toBe(true);
    });

    test('deliberate DOMAIN errors raised by the services are NOT internal', () => {
        [
            'Not authorized: supervisor/admin only',
            'Evaluation not found',
            "Cannot submit from 'approved'",
            'A rejection reason is required.',
            'performance/potential must be low|medium|high',
            'A coaching/mentoring plan must be linked to a context: an IDP, a PIP, or a skill gap',
        ].forEach((m) => expect(E.isInternal(new Error(m))).toBe(false));
    });

    test('the domain status ladder is unchanged (403 / 404 / 409 / 400)', () => {
        expect(E.domainStatus('Not authorized: manager/admin only')).toBe(403);
        expect(E.domainStatus('Plan not found')).toBe(404);
        expect(E.domainStatus("Cannot approve from 'draft'")).toBe(409);
        expect(E.domainStatus('Title required')).toBe(400);
    });

    test('an internal fault becomes a generic FR message + requestId, never the DB text', () => {
        const err = pgError('relation "nine_box_evaluations_old" does not exist', '42P01');
        const { status, body } = E.toResponse(err, { id: 'req-42' }, 'NineBoxController');
        expect(status).toBe(500);
        expect(body.success).toBe(false);
        expect(body.error).toBe(E.GENERIC_FR);
        expect(body.requestId).toBe('req-42');
        // Nothing from the driver survives.
        expect(JSON.stringify(body)).not.toMatch(/relation|does not exist|42P01/);
    });

    test('a domain error keeps its exact wording and status (the UI depends on it)', () => {
        const { status, body } = E.toResponse(
            new Error('Not authorized: confidential talent data'),
            { id: 'r1' },
            'X'
        );
        expect(status).toBe(403);
        expect(body).toEqual({ success: false, error: 'Not authorized: confidential talent data' });
    });

    test('requireId rejects a malformed identifier with a 400 BEFORE any query', () => {
        expect(E.requireId('42')).toBe(42);
        expect(E.requireId(7)).toBe(7);
        for (const bad of ['abc', '', null, undefined, '0', '-3', '1.5', 'NaN', '1; DROP TABLE']) {
            let thrown = null;
            try {
                E.requireId(bad, 'id');
            } catch (e) {
                thrown = e;
            }
            expect(thrown).not.toBeNull();
            expect(thrown.status).toBe(400);
            expect(thrown.expose).toBe(true);
            expect(thrown.message).toMatch(/identifiant invalide/i);
        }
    });

    test('a requireId failure is passed through by toResponse as a 400, not a 500', () => {
        let err = null;
        try {
            E.requireId('abc');
        } catch (e) {
            err = e;
        }
        const { status, body } = E.toResponse(err, { id: 'r2' }, 'X');
        expect(status).toBe(400);
        expect(body.error).toMatch(/identifiant invalide/i);
    });

    test('makeHandle wraps a success into { success: true, ...result }', async () => {
        const handle = E.makeHandle('T');
        const fn = handle(async () => ({ plan: { id: 1 } }));
        const res = {
            headersSent: false,
            code: null,
            payload: null,
            status(c) {
                this.code = c;
                return this;
            },
            json(b) {
                this.payload = b;
                return this;
            },
        };
        await fn({ id: 'r3' }, res);
        expect(res.payload).toEqual({ success: true, plan: { id: 1 } });
        expect(res.code).toBeNull();
    });

    test('makeHandle converts a thrown DB error into the generic 500 body', async () => {
        const handle = E.makeHandle('T');
        const fn = handle(async () => {
            throw pgError('invalid input syntax for type bigint: "NaN"', '22P02');
        });
        const res = {
            headersSent: false,
            code: null,
            payload: null,
            status(c) {
                this.code = c;
                return this;
            },
            json(b) {
                this.payload = b;
                return this;
            },
        };
        await fn({ id: 'r4' }, res);
        expect(res.code).toBe(500);
        expect(res.payload.error).toBe(E.GENERIC_FR);
        expect(JSON.stringify(res.payload)).not.toMatch(/bigint|22P02/);
    });
});

describe('the talent controllers use the shared discipline', () => {
    const fs = require('fs');
    const path = require('path');
    const files = [
        'NineBoxController.js',
        'CoachingPlanController.js',
        'SelfAssessmentWorkflowController.js',
    ];

    test.each(files)('%s no longer returns err.message unconditionally', (f) => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'controllers', f),
            'utf8'
        );
        expect(src).toContain("require('../utils/apiErrors')");
        expect(src).toMatch(/makeHandle\('/);
        // The old leak: `error: m` / `error: msg` straight from err.message.
        expect(src).not.toMatch(/error:\s*(m|msg)\s*\}/);
        // Every id goes through the coercion helper, not a bare Number(req.params.…).
        expect(src).not.toMatch(/Number\(req\.params\./);
    });
});

describe('routes/index.js — employee reads are gated and admins land on /dashboard', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
        'utf8'
    );

    test('the home route sends an admin to /dashboard, not the employee list', () => {
        const home = src.slice(src.indexOf("router.get('/', (req, res) => {"));
        const body = home.slice(0, home.indexOf('});'));
        expect(body).toContain("res.redirect('/dashboard')");
        expect(body).not.toContain("return res.redirect('/employees')");
        // The employee / manager landings are untouched.
        expect(body).toContain("res.redirect('/employee/dashboard')");
        expect(body).toContain("res.redirect('/supervisor/dashboard')");
    });

    test('GET /employees and GET /employees/:id require the view_employees capability', () => {
        expect(src).toContain("requireManagerOrAnyPermission('view_employees')");
        expect(src).toMatch(/router\.get\(\s*'\/employees',\s*_requireEmployeeReadPerm,/);
        expect(src).toMatch(/router\.get\(\s*'\/employees\/:id',\s*requireEmployeeRead,/);
        // The list is no longer gated on role shape alone.
        expect(src).not.toMatch(/router\.get\(\s*'\/employees',\s*requireManagerOrAdmin/);
    });

    test('the SCOPE check still runs on the individual record (capability ≠ scope)', () => {
        // Cut the registration at its OWN closing `);` rather than taking a
        // window of N characters. `[^\n]*` said "same line as the path", which
        // the reformat broke; a 200-char window then "fixed" it and was
        // VACUOUS — removing the guard still matched, because the comment
        // immediately below the route says the words "checkEmployeeAccess".
        // Verified by mutation: deleting the guard now reddens this test.
        const i = src.search(/router\.get\(\s*'\/employees\/:id',/);
        expect(i).toBeGreaterThan(-1);
        const registration = src.slice(i, src.indexOf('\n);', i));
        // 3.23.15: the READ variant, which runs the same scope check first and
        // only adds an admin's directly-designated reports (RBACService.canViewEmployee).
        expect(registration).toMatch(/checkEmployee(Read)?Access/);
    });

    test('a self-service employee keeps access to their OWN record', () => {
        // requireEmployeeRead lets employee/manager through to checkEmployeeAccess,
        // which already restricts a plain employee to themselves.
        expect(src).toMatch(
            /const requireEmployeeRead = [\s\S]{0,400}?t === 'employee' \|\| t === 'manager'[\s\S]{0,80}?return next\(\)/
        );
    });

    test('HTML employee + supervisor-review routes reject a non-numeric id as a 404', () => {
        expect(src).toMatch(/const requireNumericParam\s*=/);
        expect(src).toMatch(/err\.status = 404/);
        // REGEXES, not `toContain` strings. These were literal strings carrying
        // `\s*`, which in a double-quoted JS string is just the letter `s` — the
        // needle could never appear in the source, so the check was dead. And a
        // plain string pins the one-line layout that prettier no longer uses:
        // each guard now sits on its own line.
        for (const re of [
            /router\.get\(\s*'\/employees\/:id',\s*requireEmployeeRead,\s*requireNumericParam\('id'\)/,
            /requireNumericParam\('reviewId'\)/,
            // `\s*` between the path and the check would say "requireNumericParam
            // is the FIRST guard", which it no longer is: these reads gained the
            // view_employees capability gate in front of it. What must hold is
            // that the registration CARRIES the numeric check, not where in the
            // list it sits — so allow the guards between, bounded so this cannot
            // drift into the next route.
            /router\.get\(\s*'\/employees\/:id\/assessments',[\s\S]{0,120}?requireNumericParam\('id'\)/,
            /router\.get\(\s*'\/employees\/:id\/timeline',[\s\S]{0,120}?requireNumericParam\('id'\)/,
        ]) {
            expect(src).toMatch(re);
        }
    });
});

describe('errorHandler — verbosity is keyed on the boot-time env, not process.env', () => {
    const ORIGINAL = process.env.NODE_ENV;
    afterEach(() => {
        process.env.NODE_ENV = ORIGINAL;
        jest.resetModules();
    });

    function load(configEnv) {
        jest.resetModules();
        jest.doMock('../../src/config/app', () => ({ env: configEnv, port: 3000, apiKey: 'x' }));
        return require('../../src/middleware/errorHandler');
    }

    function jsonRun(errorHandler, err, t) {
        const req = {
            path: '/api/v1/x',
            method: 'GET',
            headers: { accept: 'application/json' },
            id: 'r9',
            get: () => '',
        };
        if (t) req.t = t;
        const res = {
            code: null,
            body: null,
            status(c) {
                this.code = c;
                return this;
            },
            json(b) {
                this.body = b;
                return this;
            },
        };
        errorHandler(err, req, res, () => {});
        return res;
    }

    test('appConfig.env=production suppresses the message and the stack even if NODE_ENV says otherwise', () => {
        process.env.NODE_ENV = 'development'; // the mutable value lies
        const { errorHandler } = load('production');
        const raw = 'relation "admins" does not exist';
        const res = jsonRun(errorHandler, Object.assign(new Error(raw), { status: 500 }));
        expect(res.code).toBe(500);
        // The point of the mask is that the SQL/internal text never reaches the
        // client — not which language the mask is written in.
        expect(res.body.error).not.toContain('admins');
        expect(res.body.error).not.toBe(raw);
        // French-first: with no translator attached the fallback is the FR string.
        expect(res.body.error).toBe('Une erreur est survenue');
        expect(res.body.stack).toBeUndefined();
        expect(res.body.requestId).toBe('r9');
    });

    test('the production mask is localised through req.t, not a hardcoded literal', () => {
        const { errorHandler } = load('production');
        const raw = 'relation "admins" does not exist';
        const res = jsonRun(errorHandler, Object.assign(new Error(raw), { status: 500 }), (k) =>
            k === 'chrome:error_message' ? 'An error occurred' : null
        );
        expect(res.body.error).toBe('An error occurred');
        expect(res.body.error).not.toContain('admins');
    });

    test('a non-production appliance still gets the detail (developer ergonomics unchanged)', () => {
        process.env.NODE_ENV = 'production'; // …and lies the other way
        const { errorHandler } = load('development');
        const res = jsonRun(errorHandler, Object.assign(new Error('boom'), { status: 500 }));
        expect(res.body.error).toBe('boom');
        expect(res.body.stack).toBeDefined();
    });

    test('an `expose`d client-fault message survives in production (it was written for the user)', () => {
        const { errorHandler } = load('production');
        const err = Object.assign(new Error('Identifiant invalide'), { status: 404, expose: true });
        const res = jsonRun(errorHandler, err);
        expect(res.code).toBe(404);
        expect(res.body.error).toBe('Identifiant invalide');
    });

    test('boot fails fast on an unrecognised NODE_ENV rather than silently going verbose', () => {
        expect(() => load('prod')).toThrow(/expected one of/i);
        expect(() => load('')).toThrow(/expected one of/i);
    });

    test('an HTML 4xx renders the styled error page instead of a naked JSON blob', () => {
        const { errorHandler } = load('development');
        const req = {
            path: '/employees/abc',
            method: 'GET',
            headers: { accept: 'text/html' },
            id: 'r5',
            get: () => '',
            flash: jest.fn(),
        };
        let sentStatus = null;
        let sentHtml = null;
        const res = {
            locals: {},
            status(c) {
                sentStatus = c;
                return this;
            },
            send(h) {
                sentHtml = h;
                return this;
            },
            redirect: jest.fn(),
            render(view, locals, cb) {
                expect(view).toBe('pages/error');
                expect(locals.message).toBe('Identifiant invalide');
                cb(null, '<html>styled</html>');
            },
        };
        errorHandler(
            Object.assign(new Error('Identifiant invalide'), { status: 404, expose: true }),
            req,
            res,
            () => {}
        );
        expect(sentStatus).toBe(404);
        expect(sentHtml).toBe('<html>styled</html>');
        expect(res.redirect).not.toHaveBeenCalled();
    });

    test('an HTML 5xx keeps the historical flash + same-origin redirect', () => {
        const { errorHandler } = load('development');
        const req = {
            path: '/employees',
            method: 'GET',
            headers: { accept: 'text/html' },
            id: 'r6',
            get: () => '',
            flash: jest.fn(),
        };
        const res = {
            locals: {},
            status: jest.fn(function () {
                return this;
            }),
            redirect: jest.fn(),
            render: jest.fn(),
            send: jest.fn(),
        };
        errorHandler(Object.assign(new Error('boom'), { status: 500 }), req, res, () => {});
        expect(res.render).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalled();
        expect(req.flash).toHaveBeenCalledWith('error', 'boom');
    });

    test('a render failure degrades to flash + redirect rather than masking the error', () => {
        const { errorHandler } = load('development');
        const req = {
            path: '/employees/abc',
            method: 'GET',
            headers: { accept: 'text/html' },
            id: 'r7',
            get: () => '',
            flash: jest.fn(),
        };
        const res = {
            locals: {},
            status: jest.fn(function () {
                return this;
            }),
            redirect: jest.fn(),
            send: jest.fn(),
            render: (v, l, cb) => cb(new Error('template blew up')),
        };
        errorHandler(
            Object.assign(new Error('Identifiant invalide'), { status: 404, expose: true }),
            req,
            res,
            () => {}
        );
        expect(res.redirect).toHaveBeenCalled();
        expect(req.flash).toHaveBeenCalled();
    });
});
