'use strict';

// Lot D — D2/D3/D4: settings, the audit log, the maintenance panel, destructive
// paths, API keys, the licence and the report schedules.
// Findings: L3-07, L4-03..14, L4-19, L4-21, L4-22, L6-15, L6-25.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// Layout-proof: prettier reflows the sources these assertions read.
const { flat } = require('../helpers/flatSource');
const read = (p) => flat(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('L4-07 / L4-08 / L4-09 / L4-10 — the settings page is a real control panel', () => {
    const ctl = read('src/controllers/AppSettingsController.js');
    const model = read('src/models/AppSettingsModel.js');
    const view = read('views/pages/app-settings/index.ejs');

    test('the STORED type wins; the posted settingType never reaches the write', () => {
        expect(ctl).toMatch(/const settingType = currentSetting\.settingType;/);
        // The only mentions left are the WHY comment and the stored value echoed back.
        // Line-based check: needs the RAW source (flat() joins everything into one line).
        const rawCtl = fs.readFileSync(
            path.join(ROOT, 'src/controllers/AppSettingsController.js'),
            'utf8'
        );
        const reads = rawCtl
            .split('\n')
            .filter((l) => /req\.body\.settingType/.test(l) && !/^\s*\/\//.test(l.trim()));
        expect(reads).toEqual([]);
        expect(ctl).toMatch(/const \{ id, settingValue \} = req\.body;/);
    });

    test('a refusal is a field-level message on the same page, never a dashboard bounce', () => {
        expect(ctl).toMatch(/req\.flash\('settingError', JSON\.stringify\(/);
        expect(ctl).toMatch(/return res\.redirect\('\/app-settings'\);/);
        // Either spelling: inline JSON.stringify, or the `json-script` partial
        // that replaced it across the views. `_se` is a REFUSED settings payload
        // echoed back to the page — exactly the reflected shape the partial's
        // `<` escaping exists to contain, so the newer form matters here.
        expect(view).toMatch(
            /var refused = <%- (?:JSON\.stringify\(_se\) %>;|include\('[^']*json-script'\s*,\s*\{\s*v:\s*_se\s*\}\s*\) %>;)/
        );
    });

    test('per-key validators cover the keys the lane named, and refuse out of range', () => {
        const M = require('../../src/models/AppSettingsModel');
        [
            'backupHour',
            'digestDow',
            'smtpPort',
            'sessionTimeout',
            'sessionIdleMinutes',
            'maxLoginAttempts',
            'cycleAutoLock',
            'cycleAutoCloseGraceDays',
        ].forEach((k) => expect(M.ruleFor(k)).toBeTruthy());
        expect(M.validate('backupHour', 'number', '99').ok).toBe(false);
        expect(M.validate('backupHour', 'number', 'abc').ok).toBe(false);
        expect(M.validate('backupHour', 'number', '2').ok).toBe(true);
        expect(M.validate('digestDow', 'number', '9').ok).toBe(false);
        expect(M.validate('smtpPort', 'number', '70000').ok).toBe(false);
        expect(M.validate('sessionTimeout', 'number', '0').ok).toBe(false);
        // a key with no explicit rule still gets one from its NAME
        expect(M.validate('someFutureHour', 'number', '25').ok).toBe(false);
    });

    test('job-state markers are read-only, not tunables (L4-09)', () => {
        const M = require('../../src/models/AppSettingsModel');
        expect(M.isReadOnly('certExpiryLastRunOn')).toBe(true);
        expect(M.isReadOnly('backupLastStatus')).toBe(true);
        expect(M.isReadOnly('backupHour')).toBe(false);
        expect(ctl).toMatch(/isReadOnly\(currentSetting\.settingKey\)\) return refuse\('readonly'/);
        expect(view).toMatch(/jobState/);
    });

    test('attribution is rendered (L4-10) and a restart-needed badge exists (L4-08)', () => {
        expect(view).toMatch(/__\('admin:set_modified'\)/);
        expect(view).toMatch(/modifiedCell\(setting\)/);
        expect(view).toMatch(/admin:set_restart_required/);
    });

    test('L3-07 / L4-08 — the two dead security settings now DO something', () => {
        expect(read('src/middleware/rateLimiter.js')).toMatch(
            /AppSettingsModel\.getValue\('maxLoginAttempts'/
        );
        expect(read('src/middleware/sessionActivity.js')).toMatch(
            /AppSettingsModel\.getValue\('sessionTimeout'/
        );
        // and the .env panel no longer prints a default the code does not use.
        // Lot E keyed the panel's "(default)" suffix (L6-09), so the literal is now
        // composed by dflt('5') — the FIGURE, which is what this pin is about, is
        // still 5 and still there.
        expect(ctl).toMatch(/LOGIN_RATE_LIMIT \|\| dflt\('5'\)/);
        expect(ctl).toMatch(/env_v_default/);
    });
});

describe('L4-03 / L4-04 / L4-05 / L4-06 — the audit log is navigable and exportable', () => {
    const ctl = read('src/controllers/SystemLogController.js');
    const model = read('src/models/SystemLogModel.js');
    const svc = read('src/services/LogService.js');
    const C = require('../../src/controllers/SystemLogController');

    test('an invalid filter keeps the page and names the field (L4-06)', () => {
        const { filters, errors } = C.parseFilters(
            { status: 'abc', from: 'notadate', requestId: 'nope' },
            null
        );
        expect(Object.keys(errors).sort()).toEqual(['from', 'requestId', 'status']);
        expect(filters.status).toBeUndefined();
        expect(filters.from).toBeUndefined();
        // index() renders with the remaining filters; the two /dashboard redirects
        // left are the permission refusal and the catch-all fault, not a bad filter.
        expect(ctl).toMatch(
            /const \{ filters: f, errors: filterErrors \} = parseFilters\(req\.query, req\.t\);/
        );
        expect(ctl).toMatch(/filterErrors,/);
    });

    test('valid status forms are accepted (code, class, range)', () => {
        expect(C.parseFilters({ status: '403' }, null).errors).toEqual({});
        expect(C.parseFilters({ status: '4xx' }, null).errors).toEqual({});
        expect(C.parseFilters({ status: '400-499' }, null).errors).toEqual({});
    });

    test('the export honours the SAME parsed filter as the list, and refuses a bad one', () => {
        expect(ctl).toMatch(/const \{ filters: f, errors \} = parseFilters\(req\.query, req\.t\);/);
        expect(ctl).toMatch(
            /return res\.status\(400\)\.json\(\{ error: 'invalid_filter', fields: errors \}\)/
        );
        expect(ctl).toMatch(/eachFilteredPage\(f, scope/);
        expect(C.EXPORT_HEADERS.length).toBeGreaterThanOrEqual(17);
        expect(C.EXPORT_HEADERS).toEqual(
            expect.arrayContaining([
                'severity',
                'category',
                'route',
                'status_code',
                'latency_ms',
                'request_id',
                'actor_ref',
            ])
        );
    });

    test('the filename carries the window and the filter, and dates are ISO', () => {
        expect(
            C.exportFilename({ from: '2026-09-01', to: '2026-09-10', actor: 'admin' }, 'csv')
        ).toBe('journaux-2026-09-01-2026-09-10-actor-admin.csv');
        expect(ctl).toMatch(/toISOString\(\)/);
    });

    test('L4-04 — one person, one query: actor OR entity', () => {
        expect(model).toMatch(/f\.employeeId != null/);
        expect(model).toMatch(/employee:\$\{id\}`, `manager:\$\{id\}`, `supervisor:\$\{id\}`/);
        expect(model).toMatch(/sl\.actor_ref = ANY\(\?\) OR \(sl\.entity_type IN/);
    });

    test('L4-04 — actor_ref is normalised at write time and entity synonyms are matched', () => {
        expect(svc).toMatch(/actorRef/);
        expect(model).toMatch(/get ENTITY_SYNONYMS\(\)/);
        const M = require('../../src/models/SystemLogModel');
        expect(M.entityTypeVariants('employee')).toEqual(
            expect.arrayContaining(['employee', 'employees'])
        );
        expect(M.entityTypeVariants('self_assessment')).toEqual(
            expect.arrayContaining(['self_assessment', 'selfAssessment'])
        );
    });

    test('L4-05 — category/action/entity filters and the HTTP-trail toggle exist', () => {
        ['f.category', 'f.action', 'f.entityType', 'f.entityId', 'f.excludeHttp'].forEach((k) =>
            expect(model).toContain(k)
        );
        expect(model).toContain(String.raw`sl.action NOT LIKE 'HTTP\\_%'`);
        const view = read('views/pages/system-logs/index.ejs');
        expect(view).toMatch(/name="category"/);
        expect(view).toMatch(/name="action"/);
        expect(view).toMatch(/name="excludeHttp"/);
    });

    test('L4-05 — one severity vocabulary (no "warning")', () => {
        expect(ctl).toMatch(/const SEVERITIES = \['info', 'warn', 'error', 'critical'\]/);
        expect(read('src/services/MaintenanceService.js')).not.toMatch(/severity: 'warning'/);
        const m112 = read('db/postgres/112_system_logs_normalisation.sql');
        expect(m112).toMatch(/SET severity = 'warn' WHERE severity = 'warning'/);
        expect(m112).toMatch(/regexp_replace\(actor_ref/);
        expect(m112).toMatch(
            /INSERT INTO schema_meta\(key, value\) VALUES \('112_system_logs_normalisation'/
        );
    });

    test('the migration leaves the hash chain verifiable (entity_type is NOT rewritten)', () => {
        const m112 = read('db/postgres/112_system_logs_normalisation.sql');
        expect(m112).not.toMatch(/SET entity_type =/);
        expect(m112).toMatch(/DISABLE TRIGGER trg_system_logs_immutable/);
        expect(m112).toMatch(/ENABLE TRIGGER trg_system_logs_immutable/);
    });

    test('L4-04 — the employee page carries a Journal section fed by that union', () => {
        expect(read('src/controllers/EmployeeController.js')).toMatch(
            /employeeId: Number\(id\), excludeHttp: true/
        );
        const show = read('views/pages/employees/show.ejs');
        expect(show).toMatch(/id="empJournal"/);
        expect(show).toMatch(/\/system-logs\?employeeId=<%= employee\.id %>/);
    });
});

describe('L4-11 / L4-12 / L6-15 — the maintenance panel scales and is reversible', () => {
    const svc = read('src/services/MaintenanceService.js');
    const ctl = read('src/controllers/MaintenanceController.js');
    const view = read('views/pages/admin/maintenance.ejs');

    test('the filter predicates are written against the OUTER alias the lists expose', () => {
        const S = require('../../src/services/MaintenanceService');
        const f = S._employeeFilter({ q: 'lindqvist', siteId: 11, employeeId: 84 });
        expect(f.where.join(' ')).toMatch(/x\."lastName" ILIKE \?/);
        expect(f.where.join(' ')).toMatch(/x\."siteId" = \?/);
        expect(f.where.join(' ')).toMatch(/x\."employeeId" = \?/);
        expect(f.params).toEqual([
            '%lindqvist%',
            '%lindqvist%',
            '%lindqvist%',
            '%lindqvist%',
            11,
            84,
        ]);
        // the voided list's rows ARE the people
        expect(S._employeeFilter({ employeeId: 84 }, { idCol: 'x.id' }).where.join(' ')).toMatch(
            /x\.id = \?/
        );
    });

    test('every list is paged with a real total (no silent LIMIT 200)', () => {
        expect(svc).toMatch(
            /async _page\(select, orderBy, where, params, \{ page = 1, perPage = 50 \} = \{\}\)/
        );
        expect(svc).toMatch(/SELECT COUNT\(\*\)::int AS n FROM \(\$\{select\}\) x/);
        expect(ctl).toMatch(/const PER_PAGE = 50;/);
        [
            'plansPager',
            'assessmentsPager',
            'placementsPager',
            'voidedPager',
            'actionsPager',
        ].forEach((k) => expect(ctl).toMatch(k));
        expect(view).toMatch(/admin:ops_maint_range/);
    });

    test("paging keeps every other filter, on each list's own page key", () => {
        const { paramsFrom } = require('../../src/utils/listTools');
        const qs = paramsFrom({ q: 'lindqvist', siteId: '11', pAssess: '2' }, [
            'pPlans',
        ]).toString();
        expect(qs).toMatch(/q=lindqvist/);
        expect(qs).toMatch(/siteId=11/);
        expect(qs).toMatch(/pAssess=2/);
        expect(ctl).toMatch(/function pagerFor\(query, key, \{ page, total, perPage \}\)/);
    });

    test('the trail has real columns and a CSV export honouring its filters', () => {
        expect(svc).toMatch(/_trailFilter\(f = \{\}\)/);
        expect(svc).toMatch(/async trailAll\(f = \{\}, cap = 5000\)/);
        expect(ctl).toMatch(/async trailExport\(req, res\)/);
        expect(ctl).toMatch(/'employee_id', 'employee', 'employee_number'/);
        expect(ctl).toMatch(/csvResponse\(res, `maintenance-trail-/);
        expect(view).toMatch(/\/admin\/maintenance\/trail\/export\.csv/);
    });

    test('"Rétablir" reads the previous state from the panel\'s OWN cancellation record', () => {
        expect(svc).toMatch(/async restorePlan\(user, \{ entityType, entityId, reason \}/);
        expect(svc).toMatch(
            /if \(plan\.state !== 'cancelled'\) throw refuse\('maintenance_restore_not_cancelled'\)/
        );
        expect(svc).toMatch(
            /WHERE entity_type = \? AND entity_id = \? AND decision_note = \? AND state = 'approved'/
        );
        expect(svc).toMatch(/async restorePlacement\(user, \{ evaluationId, reason \}/);
        expect(svc).toMatch(/detail\.maintenance !== true/);
        expect(svc).toMatch(/MAINT_RESTORE_\$\{spec\.label\}/);
        expect(svc).toMatch(/'MAINT_RESTORE_NINEBOX'/);
        // a reason stays mandatory on the reverse action too
        expect(svc).toMatch(/async restorePlan[\s\S]{0,200}assertReason\(reason\)/);
        expect(svc).toMatch(/async restorePlacement[\s\S]{0,200}assertReason\(reason\)/);
    });

    test('the refusal codes are translated in both locales', () => {
        const fr = require('../../locales/fr/admin.json');
        const en = require('../../locales/en/admin.json');
        [
            'maint_err_maintenance_restore_not_cancelled',
            'maint_err_maintenance_restore_no_override',
            'maint_err_maintenance_restore_conflict',
        ].forEach((k) => {
            expect(fr[k]).toBeTruthy();
            expect(en[k]).toBeTruthy();
        });
    });

    test('states are labelled, not raw, and the Lot B block has its marker', () => {
        expect(view).toMatch(/const st = \(v\) =>/);
        expect(view).toMatch(/<%= saSt\(a\.state\) %>/);
        expect(view).toMatch(/<!-- SECTION accounts: DSR block -->/);
    });
});

describe('L4-13 / L4-14 / L6-25 — destructive paths say what they do', () => {
    const routes = read('src/routes/index.js');
    const ctl = read('src/controllers/DataManagementController.js');
    const view = read('views/pages/data-management/index.ejs');

    test('L4-13 — the unguarded wipe endpoint and its handler are gone', () => {
        expect(routes).not.toMatch(/router\.post\('\/admin\/data\/cleanup'/);
        expect(ctl).not.toMatch(/cleanupData/);
        expect(routes).toMatch(/`POST \/admin\/data\/cleanup` was removed/);
    });

    test('L4-14 a — a reset without its backup is ABORTED, and audited as such', () => {
        expect(ctl).toMatch(/action: 'DATABASE_RESET_ABORTED'/);
        expect(ctl).toMatch(/return res\.status\(409\)\.json\(\{[\s\S]*?error: 'backup_failed'/);
        expect(ctl).not.toMatch(/let's log it heavily but proceed/i);
    });

    test('L4-14 b — the reset text no longer claims the logs are deleted', () => {
        expect(ctl).toMatch(/PRESERVED_TABLES = \['system_logs'/);
        expect(view).not.toMatch(/datamgmt:reset_del_logs/);
        expect(view).toMatch(/datamgmt:reset_keep_logs/);
        const fr = require('../../locales/fr/datamgmt.json');
        const en = require('../../locales/en/datamgmt.json');
        expect(fr.reset_del_logs).toBeUndefined();
        expect(en.reset_del_logs).toBeUndefined();
        expect(fr.reset_keep_logs).toMatch(/append-only/);
        expect(fr.reset_backup_required).toBeTruthy();
        expect(en.reset_backup_required).toBeTruthy();
    });

    test('L4-14 c — the restore warning names what is wiped and not restored', () => {
        const fr = require('../../locales/fr/datamgmt.json');
        const en = require('../../locales/en/datamgmt.json');
        expect(fr.js_restore_warn_2).toMatch(/SUPPRIMÉ, PAS RESTAURÉ/);
        expect(fr.js_restore_warn_2).toMatch(/PDI, PIP, coaching, 9-box/);
        expect(en.js_restore_warn_2).toMatch(/DELETED, NOT RESTORED/);
    });

    test('L4-14 d — snapshot rows carry size and captured counts', () => {
        expect(read('src/models/SnapshotModel.js')).toMatch(/async sizesById\(\)/);
        expect(ctl).toMatch(/SnapshotModel\.sizesById\(\)/);
        expect(view).toMatch(/datamgmt:th_size/);
        expect(view).toMatch(/snapshot\.sizeBytes == null/);
    });

    test('L6-25 — the three counts are server-rendered, « — » only when unmeasured', () => {
        expect(ctl).toMatch(/async computeStatistics\(user\)/);
        expect(ctl).toMatch(/this\.computeStatistics\(req\.user\)/);
        expect(view).toMatch(/id="totalEmployees"><%= stats \? stats\.totalEmployees : '—' %>/);
        expect(ctl).toMatch(/this\.index = this\.index\.bind\(this\)/); // handlers are passed unbound
        expect(ctl).toMatch(/this\.getStatistics = this\.getStatistics\.bind\(this\)/);
    });
});

describe('L4-21 / L4-22 / L4-19 — keys, licence and schedules', () => {
    test('L4-21 — key create and revoke are audited, revoke idempotently', () => {
        const svc = read('src/services/ApiKeyService.js');
        expect(svc).toMatch(/async function audit\(action, req, keyId, details\)/);
        expect(svc).toMatch(/action, entityType: 'api_key', entityId: keyId, category: 'security'/);
        expect(svc).toMatch(/await audit\('API_KEY_CREATED'/);
        expect(svc).toMatch(/if \(r && r\.changes\) await audit\('API_KEY_REVOKED'/);
        expect(read('src/routes/index.js')).toMatch(
            /ApiKeyService\.revoke\(Number\(req\.params\.id\), req\)/
        );
    });

    test('L4-21 — the one-time key waits for an explicit acknowledgement', () => {
        const view = read('views/pages/admin/api-keys.ejs');
        expect(view).not.toMatch(/setTimeout\(\(\)=>location\.reload\(\), 30000\)/);
        expect(view).toMatch(/id="ak-done"/);
        expect(view).toMatch(/admin:ops_apikey_copied_btn/);
    });

    test('L4-22 — a licence is validated structurally, and unknown keys are named', () => {
        const L = require('../../src/controllers/LicenseController');
        expect(L.validateLicense('{ not json')).toMatchObject({ ok: false, errors: ['json'] });
        expect(L.validateLicense('[]')).toMatchObject({ ok: false, errors: ['object'] });
        expect(L.validateLicense('{"seats":"many"}')).toMatchObject({
            ok: false,
            errors: ['seats'],
        });
        expect(L.validateLicense('{"expiresOn":"31/12/2027"}')).toMatchObject({
            ok: false,
            errors: ['expires'],
        });
        expect(L.validateLicense('{"features":"all"}')).toMatchObject({
            ok: false,
            errors: ['features'],
        });
        // the lane's exact typo: `seat` instead of `seats` is SAVED but reported
        expect(L.validateLicense('{"customer":"Acme","seat":50}')).toMatchObject({
            ok: true,
            ignored: ['seat'],
        });
        expect(
            L.validateLicense('{"customer":"Acme","seats":50,"expiresOn":"2027-12-31"}')
        ).toMatchObject({ ok: true, ignored: [] });
        const fr = require('../../locales/fr/admin.json');
        [
            'ops_lic_saved',
            'ops_lic_refused',
            'ops_lic_ignored_keys',
            'ops_lic_err_json',
            'ops_lic_err_seats',
            'ops_lic_err_expires',
        ].forEach((k) => expect(fr[k]).toBeTruthy());
        expect(read('src/controllers/LicenseController.js')).toMatch(/alert\('ops\.license'/);
    });

    test('L4-19 — run-now replays the scheduled path, and next run is computed', () => {
        const sched = require('../../src/jobs/report-scheduler');
        expect(typeof sched.runOne).toBe('function');
        expect(typeof sched.loadSchedule).toBe('function');
        const src = read('src/jobs/report-scheduler.js');
        expect(src).toMatch(/for \(const s of due\) \{\s*await runOne\(s, now\);\s*ran\+\+;\s*\}/);
        const ctl = read('src/controllers/ReportController.js');
        expect(ctl).toMatch(/const status = await scheduler\.runOne\(s\);/);
        expect(ctl).toMatch(/action: 'REPORT_SCHEDULE_RUN_MANUAL'/);
        // ownership is re-checked: a non-SuperAdmin may only run their own
        expect(ctl).toMatch(/req\.user\.role !== 'superadmin' && !owns/);
    });

    test('L4-19 — nextRunAt: null while paused, next matching slot otherwise', () => {
        const { nextRunAt } = require('../../src/jobs/report-scheduler');
        const monday = new Date('2026-09-14T05:00:00');
        expect(nextRunAt({ isActive: false, frequency: 'daily', hour: 6 }, monday)).toBeNull();
        const daily = nextRunAt({ isActive: true, frequency: 'daily', hour: 6 }, monday);
        expect(daily.getHours()).toBe(6);
        expect(daily.getDate()).toBe(14);
        // already ran today → tomorrow
        const ranToday = nextRunAt(
            { isActive: true, frequency: 'daily', hour: 6, lastRunAt: monday.toISOString() },
            monday
        );
        expect(ranToday.getDate()).toBe(15);
        // weekly on Monday, asked on a Monday before the hour → today
        expect(
            nextRunAt(
                { isActive: true, frequency: 'weekly', dayOfWeek: 1, hour: 6 },
                monday
            ).getDate()
        ).toBe(14);
        // monthly → the 1st
        expect(nextRunAt({ isActive: true, frequency: 'monthly', hour: 6 }, monday).getDate()).toBe(
            1
        );
    });

    test('L4-19 — a failed delivery is an ops alert, not a console line', () => {
        expect(read('src/jobs/report-scheduler.js')).toMatch(
            /alert\(\s*'ops\.smtp_failed',\s*`schedule:\$\{s\.id\}`/
        );
    });

    test('the ops notification kinds are registered with a link and both languages', () => {
        const src = read('src/services/NotificationService.js');

        // Cut out one registry entry by BALANCING ITS BRACES, not by taking a
        // window of N characters. The previous spelling pinned the one-line
        // layout (`'k': { icon:`); prettier breaks the entry across lines the
        // moment it overflows, and the assertion then failed on a registry that
        // had not changed at all. Brace matching cannot be reformatted away.
        const entryOf = (key) => {
            const open = src.search(new RegExp(`'${key.replace('.', '\\.')}':\\s*\\{`));
            expect(open).toBeGreaterThan(-1);
            const from = src.indexOf('{', open);
            let depth = 0;
            for (let i = from; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
            }
            throw new Error(`unbalanced registry entry for ${key}`);
        };

        ['ops.job_failed', 'ops.backup_stale', 'ops.smtp_failed', 'ops.license'].forEach((k) => {
            const entry = entryOf(k);
            // What the test's NAME promises: an icon, a deep link the reader can
            // actually follow, and a title in both languages — not merely that
            // the key exists.
            expect(entry).toMatch(/icon:\s*'fa-/);
            expect(entry).toMatch(/link:\s*'\//);
            expect(entry).toMatch(/fr:\s*'[^']+'/);
            expect(entry).toMatch(/en:\s*'[^']+'/);
            // And the delivery tier, which lives in a separate flat map.
            expect(src).toMatch(new RegExp(`'${k.replace('.', '\\.')}':\\s*'digest'`));
        });
    });
});

describe('FR/EN parity for every key this lot added', () => {
    test('admin, chrome, syslogs and datamgmt have the same key sets', () => {
        ['admin', 'chrome', 'syslogs', 'datamgmt'].forEach((ns) => {
            const fr = require(`../../locales/fr/${ns}.json`);
            const en = require(`../../locales/en/${ns}.json`);
            const miss = Object.keys(fr)
                .filter((k) => !(k in en))
                .concat(Object.keys(en).filter((k) => !(k in fr)));
            expect({ ns, miss }).toEqual({ ns, miss: [] });
        });
    });

    test('the help entry and the user guide carry the new page', () => {
        expect(read('public/js/help.js')).toMatch(/'\/admin\/health': \{/);
        expect(read('src/config/userGuideContent.js')).toMatch(
            /Santé de l’instance — les tâches, les sauvegardes/
        );
    });
});
