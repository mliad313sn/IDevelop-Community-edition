'use strict';

/**
 * `manager_id` is POLYMORPHIC: it points at an employee or at an admin, and the
 * discriminator is `manager_type`. The two id spaces overlap, so forgetting the
 * discriminator hands one person's team to an unrelated person with the same
 * numeric id.
 *
 * Three functions answer "who governs whom" and they must agree:
 *   - governsAnyone      (EmployeeModel.js ~:58)  always filtered it
 *   - governanceOf       (EmployeeModel.js ~:82)  always filtered it
 *   - findGovernedIds    (EmployeeModel.js ~:574) did NOT — the defect
 *
 * findGovernedIds is the one that feeds RBAC scoping on every authenticated
 * request, so it was the worst place to miss it. These tests pin the SQL of all
 * three, and pin the behaviour through a fake driver so a rewrite that keeps the
 * text but loses the meaning still fails.
 */

const path = require('path');
const fs = require('fs');

const MODEL_PATH = path.join(__dirname, '..', '..', 'src', 'models', 'EmployeeModel.js');
const source = fs.readFileSync(MODEL_PATH, 'utf8');

/** Collapse whitespace so a reformat does not break a source pin. */
const flat = (s) => s.replace(/\s+/g, ' ');

describe('findGovernedIds honours manager_type (polymorphic manager_id)', () => {
    test('the traversal query filters manager_type = employee', () => {
        const m = source.match(/async findGovernedIds\(managerId\)[\s\S]*?\n {4}\}/);
        expect(m).toBeTruthy();
        const body = flat(m[0]);
        // It must still traverse BOTH lines...
        expect(body).toContain('supervisor_id = ANY(?)');
        expect(body).toContain('manager_id = ANY(?)');
        // ...but the manager line must carry the discriminator.
        expect(body).toMatch(/manager_id = ANY\(\?\) AND manager_type = 'employee'/);
    });

    test('the two sibling resolvers filter it too, so all three agree', () => {
        const govAnyone = source.match(/async governsAnyone\(employeeId\)[\s\S]*?\n {4}\}/);
        const govOf = source.match(/async governanceOf\(employeeId\)[\s\S]*?\n {4}\}/);
        expect(flat(govAnyone[0])).toMatch(/manager_id = \? AND manager_type = 'employee'/);
        expect(flat(govOf[0])).toMatch(/manager_id = \? AND manager_type = 'employee'/);
    });

    test('an employee managed by an ADMIN of the same numeric id is not governed by that employee', async () => {
        jest.resetModules();
        const captured = [];
        jest.doMock(
            path.join(__dirname, '..', '..', 'src', 'config', 'database'),
            () => ({
                all: jest.fn(async (sql, params) => {
                    captured.push({ sql, params });
                    // A driver that respects the discriminator: employee 287 is
                    // managed by ADMIN 33, so a query carrying manager_type must not
                    // return it for EMPLOYEE 33.
                    const honoursType = /manager_type = 'employee'/.test(sql);
                    const frontier = (params[0] || []).map(Number);
                    if (!frontier.includes(33)) return [];
                    return honoursType ? [] : [{ id: 287 }];
                }),
                get: jest.fn(async () => null),
                run: jest.fn(async () => ({})),
            }),
            { virtual: false }
        );

        const Model = require(MODEL_PATH);
        const governed = await Model.findGovernedIds(33);

        expect(captured.length).toBeGreaterThan(0);
        expect(captured[0].sql).toMatch(/manager_type = 'employee'/);
        // Employee 287 belongs to admin 33, not to employee 33.
        expect(governed).not.toContain(287);
        expect(governed).toEqual([]);
    });
});
