'use strict';
/**
 * HRIS planner — value mapping (unmapped values reported, never invented),
 * plan computation (joiners, movers, updates, leavers, links), and the
 * mass-leaver guard. Pure: no database.
 */
const P = require('../../src/integrations/hris/planner');
const { normalise } = require('../../src/integrations/hris/HrisConnector');

const NOW = new Date('2026-09-30T12:00:00Z');

function baseRaw(over = {}) {
    return {
        provider: 'csv',
        sites: [
            { id: 1, name: 'Stonebridge', code: 'SB', isActive: true },
            { id: 2, name: 'Northgate', code: 'NG', isActive: true },
        ],
        departments: [
            { id: 10, siteId: 1, name: 'Mining', code: 'MIN', isActive: true },
            { id: 11, siteId: 1, name: 'Processing', isActive: true },
            { id: 20, siteId: 2, name: 'Mining', isActive: true },
        ],
        services: [
            { id: 100, departmentId: 10, name: 'Open Pit', isActive: true },
            { id: 101, departmentId: 10, name: 'Underground', isActive: true },
            { id: 110, departmentId: 11, name: 'Plant', isActive: true },
            { id: 200, departmentId: 20, name: 'North Pit', isActive: true },
        ],
        roles: [
            { id: 1, name: 'Welder', isActive: true },
            { id: 2, name: 'Foreman', isActive: true },
        ],
        mappings: [],
        employees: [],
        links: [],
        options: { now: NOW },
        ...over,
    };
}

const emp = (id, o = {}) => ({
    id,
    employeeNumber: `E${id}`,
    firstName: `F${id}`,
    lastName: `L${id}`,
    email: `e${id}@acme.test`,
    siteId: 1,
    departmentId: 10,
    serviceId: 100,
    roleId: 1,
    supervisorId: null,
    isActive: true,
    cancelledAt: null,
    erasedAt: null,
    ...o,
});
const rec = (o) =>
    normalise(
        {
            firstName: 'Ana',
            lastName: 'Diallo',
            jobTitle: 'Welder',
            department: 'Mining',
            site: 'Stonebridge',
            service: 'Open Pit',
            status: 'active',
            ...o,
        },
        NOW
    );

describe('value mapping', () => {
    test('explicit mappings win; exact names and codes match; accents / case ignored', () => {
        const ctx = P.buildContext(
            baseRaw({
                mappings: [
                    { kind: 'department', externalKey: 'extraction', targetId: 10 },
                    { kind: 'role', externalKey: 'soudeur', targetId: 1 },
                ],
            })
        );
        expect(P.lookup(ctx, 'department', 'EXTRACTION')).toBe(10);
        expect(P.lookup(ctx, 'role', 'Soudeur')).toBe(1);
        expect(P.lookup(ctx, 'site', 'ng')).toBe(2); // code
        expect(P.lookup(ctx, 'role', 'foreman')).toBe(2);
        expect(P.lookup(ctx, 'role', 'Astronaut')).toBeNull();
    });

    test('an ambiguous name is NOT guessed; the known site disambiguates it', () => {
        const ctx = P.buildContext(baseRaw());
        expect(P.lookup(ctx, 'department', 'Mining')).toBeNull(); // two sites have one
        const pl = P.resolvePlacement(rec({ site: 'Northgate', service: null }), ctx);
        expect(pl).toMatchObject({ siteId: 2, departmentId: 20, serviceId: 200, complete: true });
    });

    test('matchByName off: only explicit mappings count', () => {
        const ctx = P.buildContext(baseRaw({ options: { now: NOW, matchByName: false } }));
        const pl = P.resolvePlacement(rec({}), ctx);
        expect(pl.complete).toBe(false);
        expect(pl.unmapped.map((u) => u.field).sort()).toEqual([
            'department',
            'role',
            'service',
            'site',
        ]);
    });

    test('a department with ONE service takes it; with several, the service is reported unmapped', () => {
        const ctx = P.buildContext(baseRaw());
        const plant = P.resolvePlacement(rec({ department: 'Processing', service: null }), ctx);
        expect(plant).toMatchObject({ departmentId: 11, serviceId: 110, complete: true });
        const mining = P.resolvePlacement(rec({ service: null }), ctx);
        expect(mining.complete).toBe(false);
        expect(mining.unmapped).toEqual([{ field: 'service', value: 'Mining' }]);
    });

    test('a service mapping keyed on the department value places the person', () => {
        const ctx = P.buildContext(
            baseRaw({ mappings: [{ kind: 'service', externalKey: 'mining', targetId: 101 }] })
        );
        const pl = P.resolvePlacement(rec({ service: null }), ctx);
        expect(pl).toMatchObject({ siteId: 1, departmentId: 10, serviceId: 101, complete: true });
    });

    test('a site that contradicts the department is an error, not a silent choice', () => {
        const ctx = P.buildContext(
            baseRaw({ mappings: [{ kind: 'department', externalKey: 'plant dept', targetId: 11 }] })
        );
        const pl = P.resolvePlacement(
            rec({ site: 'Northgate', department: 'Plant dept', service: null }),
            ctx
        );
        expect(pl.errors).toContain('site_mismatch');
        expect(pl.complete).toBe(false);
    });

    test('a mapping to an INACTIVE unit resolves to nothing', () => {
        const raw = baseRaw({ mappings: [{ kind: 'role', externalKey: 'welder', targetId: 1 }] });
        raw.roles[0].isActive = false;
        const ctx = P.buildContext(raw);
        expect(P.lookup(ctx, 'role', 'Welder')).toBeNull();
    });
});

describe('plan computation', () => {
    test('joiners are placed; unmapped values are reported with counts and block the joiner', () => {
        const ctx = P.buildContext(baseRaw());
        const plan = P.computePlan(
            [
                rec({ externalId: 'A' }),
                rec({ externalId: 'B', jobTitle: 'Astronaut' }),
                rec({
                    externalId: 'C',
                    jobTitle: 'Astronaut',
                    department: 'Marketing',
                    service: null,
                }),
                rec({ externalId: 'D', startDate: '2027-01-01' }),
                rec({ externalId: 'E', status: 'inactive' }),
            ],
            ctx
        );
        expect(plan.joiners.map((j) => j.externalId)).toEqual(['A']);
        expect(plan.joiners[0]).toMatchObject({
            siteId: 1,
            departmentId: 10,
            serviceId: 100,
            roleId: 1,
        });
        expect(plan.blocked.map((b) => b.externalId)).toEqual(['B', 'C']);
        expect(plan.blocked[1].reasons).toEqual(
            expect.arrayContaining(['unmapped_department', 'unmapped_role'])
        );
        const astronaut = plan.unmapped.find((u) => u.field === 'role');
        expect(astronaut).toMatchObject({ value: 'Astronaut', count: 2 });
        expect(plan.unmapped.find((u) => u.field === 'department')).toMatchObject({
            value: 'Marketing',
            count: 1,
        });
        expect(plan.upcoming.map((u) => u.externalId)).toEqual(['D']);
        expect(plan.counts).toMatchObject({ joiners: 1, blocked: 2, upcoming: 1, ignored: 1 });
    });

    test('an existing employee is LINKED on employee number, then e-mail — never duplicated', () => {
        const ctx = P.buildContext(
            baseRaw({ employees: [emp(1), emp(2, { email: 'shared@acme.test' })] })
        );
        const plan = P.computePlan(
            [
                rec({
                    externalId: 'X1',
                    employeeNumber: 'E1',
                    firstName: 'F1',
                    lastName: 'L1',
                    email: 'e1@acme.test',
                }),
                rec({
                    externalId: 'X2',
                    email: 'SHARED@acme.test',
                    firstName: 'F2',
                    lastName: 'L2',
                }),
            ],
            ctx
        );
        expect(plan.joiners).toEqual([]);
        expect(plan.links).toEqual([
            expect.objectContaining({ externalId: 'X1', employeeId: 1, by: 'employee_number' }),
            expect.objectContaining({ externalId: 'X2', employeeId: 2, by: 'email' }),
        ]);
        expect(plan.unchanged).toBe(2);
    });

    test('movers: org, role and manager changes; profile-only changes are updates', () => {
        const ctx = P.buildContext(
            baseRaw({
                employees: [emp(1), emp(2), emp(3), emp(9, { roleId: 2 })],
                links: [
                    { externalId: 'M1', employeeId: 1 },
                    { externalId: 'M2', employeeId: 2 },
                    { externalId: 'M3', employeeId: 3 },
                    { externalId: 'BOSS', employeeId: 9 },
                ],
            })
        );
        const plan = P.computePlan(
            [
                rec({
                    externalId: 'M1',
                    firstName: 'F1',
                    lastName: 'L1',
                    email: 'e1@acme.test',
                    department: 'Processing',
                    service: 'Plant',
                }),
                rec({
                    externalId: 'M2',
                    firstName: 'F2',
                    lastName: 'L2',
                    email: 'e2@acme.test',
                    jobTitle: 'Foreman',
                    managerExternalId: 'BOSS',
                }),
                rec({
                    externalId: 'M3',
                    firstName: 'Renamed',
                    lastName: 'L3',
                    email: 'e3@acme.test',
                }),
                rec({
                    externalId: 'BOSS',
                    firstName: 'F9',
                    lastName: 'L9',
                    email: 'e9@acme.test',
                    jobTitle: 'Foreman',
                }),
            ],
            ctx
        );
        const byExt = Object.fromEntries(plan.movers.map((m) => [m.externalId, m]));
        expect(byExt.M1.changes).toEqual({
            departmentId: { from: 10, to: 11 },
            serviceId: { from: 100, to: 110 },
        });
        expect(byExt.M2.changes).toEqual({
            roleId: { from: 1, to: 2 },
            supervisorId: { from: null, to: 9 },
        });
        expect(plan.updates).toEqual([
            expect.objectContaining({ externalId: 'M3', profile: { firstName: 'Renamed' } }),
        ]);
        expect(plan.unchanged).toBe(1);
    });

    test('an unmapped value never moves anybody; it is reported', () => {
        const ctx = P.buildContext(
            baseRaw({ employees: [emp(1)], links: [{ externalId: 'M1', employeeId: 1 }] })
        );
        const plan = P.computePlan(
            [
                rec({
                    externalId: 'M1',
                    firstName: 'F1',
                    lastName: 'L1',
                    email: 'e1@acme.test',
                    department: 'Nowhere',
                    service: null,
                    jobTitle: 'Mystery',
                }),
            ],
            ctx
        );
        expect(plan.movers).toEqual([]);
        expect(plan.unmapped.map((u) => u.field).sort()).toEqual(['department', 'role']);
    });

    test('leavers: an ended contract, and (full mode) a linked person missing from the export', () => {
        const employees = [
            emp(1),
            emp(2),
            emp(3),
            ...Array.from({ length: 20 }, (_, i) => emp(100 + i)),
        ];
        const links = [
            { externalId: 'A', employeeId: 1 },
            { externalId: 'B', employeeId: 2 },
            { externalId: 'C', employeeId: 3 },
        ];
        const records = [
            rec({
                externalId: 'A',
                firstName: 'F1',
                lastName: 'L1',
                email: 'e1@acme.test',
                endDate: '2026-09-01',
            }),
            rec({ externalId: 'B', firstName: 'F2', lastName: 'L2', email: 'e2@acme.test' }),
        ];
        const full = P.computePlan(
            records,
            P.buildContext(baseRaw({ employees, links, options: { now: NOW, guardPct: 50 } }))
        );
        expect(full.leavers.map((l) => [l.externalId, l.reason])).toEqual([
            ['A', 'ended'],
            ['C', 'missing'],
        ]);
        const delta = P.computePlan(
            records,
            P.buildContext(
                baseRaw({ employees, links, options: { now: NOW, mode: 'delta', guardPct: 50 } })
            )
        );
        expect(delta.leavers.map((l) => l.externalId)).toEqual(['A']);
    });

    test('duplicate external ids are errors, the first row wins', () => {
        const plan = P.computePlan(
            [rec({ externalId: 'A', row: 2 }), rec({ externalId: 'A', row: 3 })].map((r, i) => ({
                ...r,
                row: i + 2,
            })),
            P.buildContext(baseRaw())
        );
        expect(plan.errors).toEqual([{ row: 3, externalId: 'A', code: 'duplicate_external_id' }]);
        expect(plan.joiners).toHaveLength(1);
    });

    test('a joiner managed by another joiner of the same batch is resolved at apply', () => {
        const plan = P.computePlan(
            [
                rec({ externalId: 'J1', managerExternalId: 'J2' }),
                rec({ externalId: 'J2', firstName: 'Boss' }),
            ],
            P.buildContext(baseRaw())
        );
        expect(plan.joiners.find((j) => j.externalId === 'J1').managerPendingExternalId).toBe('J2');
    });

    test('an unknown manager is reported as an unmapped value, the joiner is still placed', () => {
        const plan = P.computePlan(
            [rec({ externalId: 'J1', managerExternalId: 'NOPE' })],
            P.buildContext(baseRaw())
        );
        expect(plan.joiners).toHaveLength(1);
        expect(plan.unmapped).toEqual([
            expect.objectContaining({ field: 'manager', value: 'NOPE' }),
        ]);
    });
});

describe('mass-leaver guard', () => {
    const population = (n) => Array.from({ length: n }, (_, i) => emp(i + 1));
    const linksFor = (n) =>
        Array.from({ length: n }, (_, i) => ({ externalId: `X${i + 1}`, employeeId: i + 1 }));
    const keep = (n) =>
        Array.from({ length: n }, (_, i) =>
            rec({
                externalId: `X${i + 1}`,
                firstName: `F${i + 1}`,
                lastName: `L${i + 1}`,
                email: `e${i + 1}@acme.test`,
            })
        );

    test('10 % by default: 10 of 100 passes, 11 of 100 trips', () => {
        const ctx = P.buildContext(baseRaw({ employees: population(100), links: linksFor(100) }));
        const ok = P.computePlan(keep(90), ctx);
        expect(ok.guard).toMatchObject({ leavers: 10, population: 100, pct: 10, tripped: false });
        const bad = P.computePlan(keep(89), ctx);
        expect(bad.guard).toMatchObject({
            leavers: 11,
            tripped: true,
            reason: 'too_many_leavers',
            limitPct: 10,
        });
    });

    test('an empty full export while people are linked always trips', () => {
        const ctx = P.buildContext(
            baseRaw({
                employees: population(100),
                links: linksFor(1),
                options: { now: NOW, guardPct: 100 },
            })
        );
        expect(P.computePlan([], ctx).guard).toMatchObject({
            tripped: true,
            reason: 'empty_export',
        });
    });

    test('the threshold is configurable', () => {
        const ctx = P.buildContext(
            baseRaw({
                employees: population(10),
                links: linksFor(10),
                options: { now: NOW, guardPct: 50 },
            })
        );
        expect(P.computePlan(keep(6), ctx).guard.tripped).toBe(false); // 40 %
        expect(P.computePlan(keep(4), ctx).guard.tripped).toBe(true); // 60 %
    });
});
