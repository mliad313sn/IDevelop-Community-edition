'use strict';
/**
 * The board pack's pure rules (BoardPackService) and the name guard
 * (src/utils/boardNameGuard.js). Invented names only.
 *
 *   - the name guard refuses two adjacent, different words of a person's
 *     names, in any order, accents and case ignored; one word alone passes;
 *     the text is split without a regular expression on the input;
 *   - the scope key: the unit key for a validated scope, the `reader:` key
 *     otherwise; English owner-role codes;
 *   - a decision from the form: role from the fixed list, dates real and not
 *     in the future, due not before the decision, a linkable indicator;
 *   - since the last pack: exact entries and exits, NO change across a KPI
 *     contract change, no entries / exits under 5 people;
 *   - trends: only from a 90 to 135-day-old snapshot, never invented;
 *   - population ids are whole numbers only.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const G = require('../../src/utils/boardNameGuard');
const B = require('../../src/services/BoardPackService');

describe('the name guard', () => {
    const P = { firstName: 'Ada Grace', lastName: 'Lovelace' };
    test('two adjacent words of the names, any order, accents and case ignored', () => {
        expect(G.textNamesPerson('Ask Ada Lovelace to lead', P.firstName, P.lastName)).toBe(true);
        expect(G.textNamesPerson('LOVELACE, Ada will lead', P.firstName, P.lastName)).toBe(true);
        expect(G.textNamesPerson('grace lovelace', P.firstName, P.lastName)).toBe(true);
        expect(G.textNamesPerson('Àda Lövelace', P.firstName, P.lastName)).toBe(true);
    });
    test('one word alone, or the same word twice, is not a name', () => {
        expect(G.textNamesPerson('Grace period for the plan', P.firstName, P.lastName)).toBe(false);
        expect(G.textNamesPerson('Ada and the training team', P.firstName, P.lastName)).toBe(false);
        expect(G.textNamesPerson('ada ada', P.firstName, P.lastName)).toBe(false);
        expect(G.textNamesPerson('Ada Lovelace', 'Ada', '')).toBe(false); // one token: nothing to match
    });
    test('the first person named among several, or null', () => {
        const people = [{ firstName: 'Tomas', lastName: 'Verlaine' }, P];
        expect(G.firstNamed('Verlaine Tomas leads', people)).toBe(people[0]);
        expect(G.firstNamed('The site manager leads', people)).toBeNull();
    });
    test('words are split by a character loop, not a regular expression on the input', () => {
        expect(G.wordsOf("L'équipe, a-b 12 x")).toEqual(['equipe', '12']);
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/utils/boardNameGuard.js'),
            'utf8'
        );
        expect(src).not.toMatch(/\.split\(\//);
        expect(src).not.toMatch(/\bnew RegExp\b/);
    });
});

describe('scope keys and the owner roles', () => {
    test('the unit key of a validated scope', () => {
        expect(B.unitKey({})).toBe('org');
        expect(B.unitKey({ site: 3 })).toBe('site:3');
        expect(B.unitKey({ site: 'none' })).toBe('site:none');
        expect(B.unitKey({ department: 4 })).toBe('dept:4');
        expect(B.unitKey({ site: 3, department: 4 })).toBe('site:3/dept:4');
    });
    test('a reader key, English prefix, with the unit', () => {
        expect(B.readerKey({ id: 7, userType: 'manager' }, 'site:3')).toBe(
            'reader:manager:7/site:3'
        );
        expect(B.readerKey({ id: 2, userType: 'admin' }, 'org')).toBe('reader:admin:2');
        const rx =
            /^(org|site:(none|[0-9]{1,9})|dept:[0-9]{1,9}|site:[0-9]{1,9}\/dept:[0-9]{1,9}|svc:[0-9]{1,9}|reader:(admin|employee|manager):[0-9]{1,12}(\/(site:(none|[0-9]{1,9})|dept:[0-9]{1,9}|site:[0-9]{1,9}\/dept:[0-9]{1,9}|svc:[0-9]{1,9}))?)$/;
        for (const k of [
            B.readerKey({ id: 7, userType: 'manager' }, 'site:3/dept:4'),
            B.readerKey({ id: 9, userType: 'employee' }, 'site:none'),
        ])
            expect(k).toMatch(rx);
    });
    test('owner roles are English codes; who may write', () => {
        expect(B.OWNER_ROLES).toEqual([
            'exec_committee',
            'hr_director',
            'hse',
            'site',
            'training',
            'hr_local',
            'managers',
            'finance',
        ]);
        expect(B.canWrite({ userType: 'manager' })).toBe(true);
        expect(B.canWrite({ userType: 'admin', role: 'localadmin' })).toBe(true);
        expect(B.canWrite({ userType: 'admin', role: 'viewer' })).toBe(false);
        expect(B.canWrite({ userType: 'employee' })).toBe(false);
        expect(B.canWrite(null)).toBe(false);
    });
});

describe('a decision from the form', () => {
    const T = '2026-10-20';
    const ok = { decisionText: ' Open a session ', ownerRole: 'training' };
    const code = (body) => {
        try {
            B.parseDecision(body, T);
            return null;
        } catch (e) {
            return e.code;
        }
    };
    test('valid: trimmed, today by default, pack date = decision date', () => {
        expect(B.parseDecision(ok, T)).toEqual({
            text: 'Open a session',
            ownerRole: 'training',
            decidedAt: T,
            packDate: T,
            dueDate: null,
            kpiId: null,
        });
    });
    test('each refusal has its code', () => {
        expect(code({ ...ok, decisionText: '  ' })).toBe('text_required');
        expect(code({ ...ok, decisionText: 'x'.repeat(2001) })).toBe('text_too_long');
        expect(code({ ...ok, ownerRole: 'codir' })).toBe('owner_role');
        expect(code({ ...ok, decidedAt: '2026-02-30' })).toBe('decided_at');
        expect(code({ ...ok, decidedAt: '2026-10-21' })).toBe('decided_future');
        expect(code({ ...ok, packDate: 'yesterday' })).toBe('pack_date');
        expect(code({ ...ok, dueDate: '2026-13-01' })).toBe('due_date');
        expect(code({ ...ok, dueDate: '2026-10-01' })).toBe('due_before');
        expect(code({ ...ok, kpiId: 'K99' })).toBe('kpi');
        expect(code({ ...ok, decisionText: ['a', 'Last wins'] })).toBeNull();
    });
    test('a decision id from the URL is a whole number, else « not found »', () => {
        expect(B.decisionId('42')).toBe(42);
        for (const bad of ['0', '-1', 'abc', '1e3', '', '1'.repeat(19)])
            expect(() => B.decisionId(bad)).toThrow(expect.objectContaining({ status: 404 }));
    });
});

describe('since the last pack', () => {
    const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);
    const prev = {
        on: '2026-07-01',
        contract: 'kpi-2',
        population: 8,
        ids: ids(8),
        coverage: 40,
        values: { K1: { value: 50, unit: 'pct' }, K8: { value: 3, unit: 'count' } },
    };
    const now = {
        values: { K1: { value: 62.5, unit: 'pct' }, K8: { value: 1, unit: 'count' } },
        ids: ids(9, 3),
        coverage: 55,
    };
    test('exact entries and exits, changes on the printed values', () => {
        const c = B.compareRuns(prev, now, 'kpi-2');
        expect(c.population).toEqual({ then: 8, now: 9, entered: 3, exited: 2 });
        expect(c.coverage).toEqual({ then: 40, now: 55, delta: 15 });
        expect(c.kpis.find((k) => k.kpi === 'K1')).toMatchObject({
            then: 50,
            now: 62.5,
            delta: 12.5,
        });
        expect(c.kpis.find((k) => k.kpi === 'K8')).toMatchObject({ delta: -2 });
        expect(c.definitionsChanged).toBe(false);
    });
    test('no change across a KPI contract change', () => {
        const c = B.compareRuns({ ...prev, contract: 'kpi-1' }, now, 'kpi-2');
        expect(c.definitionsChanged).toBe(true);
        expect(c.coverage.delta).toBeNull();
        for (const k of c.kpis) expect(k.delta).toBeNull();
    });
    test('fewer than 5 people on a side: no entries or exits that could point at someone', () => {
        const c = B.compareRuns({ ...prev, ids: ids(3), population: 3 }, now, 'kpi-2');
        expect(c.population.entered).toBeNull();
        expect(c.population.exited).toBeNull();
    });
    test('no previous pack: « first pack »', () => {
        expect(B.compareRuns(null, now, 'kpi-2')).toEqual({ previous: null });
    });
    test('population ids are whole numbers only, sorted, once each', () => {
        expect(B.populationIds({ ids: [5, '3', 3, 'x', 2.5, -1, null, 9] })).toEqual([3, 5, 9]);
    });
});

describe('trends from snapshots', () => {
    const snap = (date, ready, notReady) => ({
        date,
        roleReadyCount: ready,
        notReadyCount: notReady,
    });
    test('only a 90 to 135-day-old snapshot; never invented', () => {
        const rows = [snap('2026-05-01', 5, 5), snap('2026-06-15', 6, 4), snap('2026-09-20', 8, 2)];
        expect(B.trendOf(rows, 'K1')).toEqual({ delta: 20, since: '2026-06-15', reason: null });
        expect(B.trendOf([snap('2026-09-01', 5, 5), snap('2026-09-20', 8, 2)], 'K1')).toEqual({
            delta: null,
            reason: 'no_history',
        });
        expect(B.trendOf(rows, 'K17')).toEqual({ delta: null, reason: 'not_tracked' });
        expect(B.trendOf([snap('2026-06-15', 1, 1), snap('2026-09-20', 8, 2)], 'K1')).toEqual({
            delta: null,
            reason: 'unmeasured',
        });
    });
    test('the indicator since a decision', () => {
        const rows = [snap('2026-06-01', 5, 5), snap('2026-08-01', 7, 3)];
        expect(B.kpiSinceDecision({ kpiId: 'K1', decidedAt: '2026-06-10' }, rows)).toMatchObject({
            delta: 20,
            from: '2026-06-01',
        });
        expect(B.kpiSinceDecision({ kpiId: 'K1', decidedAt: '2026-08-02' }, rows)).toMatchObject({
            reason: 'too_recent',
        });
        expect(B.kpiSinceDecision({ kpiId: null }, rows)).toBeNull();
    });
    test('a target applies to the organisation or a whole site only', () => {
        expect(B.targetScopeOf('org')).toBe('org');
        expect(B.targetScopeOf('site:4')).toEqual({ type: 'site', id: 4 });
        expect(B.targetScopeOf('dept:4')).toBeNull();
        expect(B.targetScopeOf('reader:manager:7/site:4')).toBeNull();
    });
});

describe('the pack is rendered from locale keys in FR and EN', () => {
    test('every exec: key of the pack and the decisions page exists in both languages', () => {
        const fr = require('../../locales/fr/exec.json');
        const en = require('../../locales/en/exec.json');
        for (const f of ['board-pack.ejs', 'decisions.ejs']) {
            const src = fs.readFileSync(path.join(__dirname, '../../views/pages/exec', f), 'utf8');
            for (const m of src.matchAll(/'exec:([a-z0-9_]+)'/g)) {
                expect([f, m[1], typeof fr[m[1]]]).toEqual([f, m[1], 'string']);
                expect([f, m[1], typeof en[m[1]]]).toEqual([f, m[1], 'string']);
            }
            expect(src).not.toMatch(/\son[a-z]+=/i);
        }
    });
});
