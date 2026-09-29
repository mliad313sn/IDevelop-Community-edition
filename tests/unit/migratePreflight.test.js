'use strict';
/**
 * scripts/migrate-preflight.js — the Migrate mode's pre/post-flight plan.
 *
 * The contract: "pending" means EXACTLY what PostgresDatabase.migrate means.
 * The first version filtered schema_meta keys to /^\d+_/ and so did not see a
 * hand-applied prerequisite (`01a_enum_prereqs`, recorded at 3.22.1 on the
 * appliance) whose .sql still sat in the install directory. The runner skipped
 * it (key present); the report called it pending; post-flight failed; the
 * installer rolled the CODE back over a database that had just been migrated
 * (customer appliance, 3.22.85 -> 3.22.91, 2026-09-09). These tests pin the plan to
 * the runner's own selection and lookup.
 */
const fs = require('fs');
const path = require('path');
const { plan, isMigrationFile, keyOf } = require('../../scripts/migrate-preflight');

const FILES = [
    '01_schema.sql',
    '02_x.sql',
    '10_self_assessment_workflow.sql',
    '10_self_assessment_workflow_down.sql',
    '96_movement_feed_reviewer_identity.sql',
    '97_framework_origin_debrand.sql',
    '106_kpi_snapshots_roles_unmeasured.sql',
    'README.md',
];
const KEYS = [
    'schema_version',
    '02_x',
    '10_self_assessment_workflow',
    '96_movement_feed_reviewer_identity',
];

describe("file selection is the runner's, verbatim", () => {
    test('numbered .sql only; never *_down.sql, never 01_schema.sql, never non-sql', () => {
        expect(FILES.filter(isMigrationFile)).toEqual([
            '02_x.sql',
            '10_self_assessment_workflow.sql',
            '96_movement_feed_reviewer_identity.sql',
            '97_framework_origin_debrand.sql',
            '106_kpi_snapshots_roles_unmeasured.sql',
        ]);
    });

    test("the filter expression in this script is byte-identical to PostgresDatabase.migrate's", () => {
        const FILTER =
            "/^\\d+.*\\.sql$/.test(f) && !/_down\\.sql$/i.test(f) && f !== '01_schema.sql'";
        const runner = fs.readFileSync(
            path.join(__dirname, '../../src/database/PostgresDatabase.js'),
            'utf8'
        );
        const script = fs.readFileSync(
            path.join(__dirname, '../../scripts/migrate-preflight.js'),
            'utf8'
        );
        expect(runner).toContain(FILTER);
        expect(script).toContain(FILTER);
    });

    test('the key is the file name without .sql, like the runner', () => {
        expect(keyOf('106_kpi_snapshots_roles_unmeasured.sql')).toBe(
            '106_kpi_snapshots_roles_unmeasured'
        );
        expect(keyOf('01a_enum_prereqs.SQL')).toBe('01a_enum_prereqs');
    });
});

describe('pending is "file shipped AND key absent from schema_meta" — every key, not only NN_ ones', () => {
    test('a 3.22.85 database against this package: exactly the files it has not seen', () => {
        const p = plan(FILES, KEYS);
        expect(p.pending).toEqual([
            '97_framework_origin_debrand.sql',
            '106_kpi_snapshots_roles_unmeasured.sql',
        ]);
        expect(p.ahead).toEqual([]);
        expect(p.shippedMax).toBe(106);
    });

    test('THE APPLIANCE CASE: a hand-applied prerequisite recorded in schema_meta whose file still sits in the directory is NOT pending', () => {
        const files = [...FILES, '01a_enum_prereqs.sql'];
        const keys = [
            ...KEYS,
            '01a_enum_prereqs',
            '97_framework_origin_debrand',
            '106_kpi_snapshots_roles_unmeasured',
        ];
        const p = plan(files, keys);
        expect(p.pending).toEqual([]);
        expect(p.applied).toContain('01a_enum_prereqs');
        expect(p.ahead).toEqual([]);
    });

    test('a stray file NOT recorded in schema_meta is pending — because the runner WILL run it', () => {
        const p = plan([...FILES, '01a_enum_prereqs.sql'], KEYS);
        expect(p.pending[0]).toBe('01a_enum_prereqs.sql');
    });

    test('a schema_meta key with no matching file is simply ignored (never pending, never ahead below the max)', () => {
        const p = plan(FILES, [...KEYS, '50_some_hotfix_applied_by_hand']);
        expect(p.pending).toEqual([
            '97_framework_origin_debrand.sql',
            '106_kpi_snapshots_roles_unmeasured.sql',
        ]);
        expect(p.ahead).toEqual([]);
    });

    test('a first install (no schema_meta at all) has everything pending', () => {
        expect(plan(FILES, []).pending).toHaveLength(5);
    });
});

describe('downgrade guard', () => {
    test('a key numbered above anything the package ships is refused as AHEAD', () => {
        const p = plan(FILES, [...KEYS, '999_from_a_newer_version']);
        expect(p.ahead).toEqual(['999_from_a_newer_version']);
    });

    test('a hand-applied key with a letter in the number (01a_) never counts as ahead', () => {
        expect(plan(FILES, [...KEYS, '01a_enum_prereqs']).ahead).toEqual([]);
    });

    test('the same numbers with different names are not "ahead" — only the number is compared', () => {
        expect(plan(FILES, [...KEYS, '106_renamed_locally']).ahead).toEqual([]);
    });
});
