'use strict';

// Security invariant: the super-admin SQL console must never be able to mutate or
// disable protection on the three immutable audit tables, even via dynamic SQL.
// _auditTamperViolation is the app-layer guard in front of the DB block_mutation
// trigger; this locks its decision table so a refactor can't quietly weaken it.
// The guard is pure (operates on statement strings) — mock the DB module so the
// service loads without a live DATABASE_URL, matching the unit-test convention.
const mockDb = { run: jest.fn(), get: jest.fn(), all: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const svc = require('../../src/services/SqlConsoleService');

const violation = (sql) => svc._auditTamperViolation([sql]);

describe('SqlConsoleService._auditTamperViolation — audit-table tamper guard', () => {
    const PROTECTED = ['system_logs', 'assessment_history', 'review_signatures'];

    describe('BLOCKS direct mutation/DDL of every protected table', () => {
        for (const t of PROTECTED) {
            test(`UPDATE ${t}`, () => expect(violation(`UPDATE ${t} SET action='x'`)).toBeTruthy());
            test(`DELETE FROM ${t}`, () =>
                expect(violation(`DELETE FROM ${t} WHERE id=1`)).toBeTruthy());
            test(`TRUNCATE ${t}`, () => expect(violation(`TRUNCATE ${t}`)).toBeTruthy());
            test(`ALTER TABLE ${t}`, () =>
                expect(violation(`ALTER TABLE ${t} DROP COLUMN action`)).toBeTruthy());
            test(`MERGE INTO ${t}`, () =>
                expect(
                    violation(`MERGE INTO ${t} USING x ON x.id=${t}.id WHEN MATCHED THEN DELETE`)
                ).toBeTruthy());
            test(`public.${t} qualified name`, () =>
                expect(violation(`DELETE FROM public.${t}`)).toBeTruthy());
        }
    });

    test('BLOCKS DISABLE TRIGGER from the console', () => {
        expect(violation('ALTER TABLE employees DISABLE TRIGGER ALL')).toBeTruthy();
    });

    test('BLOCKS the dynamic-SQL bypass (DO/EXECUTE hiding the payload in a $$ body)', () => {
        const payload =
            "DO $$ BEGIN EXECUTE 'ALTER TABLE system_logs DISABLE TRIGGER ALL'; END $$;";
        expect(violation(payload)).toBeTruthy();
    });

    test('BLOCKS CALL/EXECUTE referencing a protected table', () => {
        expect(violation("CALL some_proc('assessment_history')")).toBeTruthy();
    });

    describe('ALLOWS legitimate statements (no false positives)', () => {
        test('plain SELECT of a protected table is read-only → allowed', () => {
            expect(violation('SELECT * FROM system_logs LIMIT 10')).toBeNull();
        });
        test('mutation of a NON-protected table', () => {
            expect(violation("UPDATE employees SET first_name='A' WHERE id=1")).toBeNull();
        });
        test('protected name appearing only inside a string literal is not a reference', () => {
            expect(
                violation("INSERT INTO notes (body) VALUES ('backup of system_logs done')")
            ).toBeNull();
        });
    });

    test('scans EVERY statement in a multi-statement batch, not just the first', () => {
        expect(violation).toBeDefined();
        const batch = ['SELECT 1', 'DELETE FROM review_signatures WHERE id=1'];
        expect(svc._auditTamperViolation(batch)).toBeTruthy();
    });
});
