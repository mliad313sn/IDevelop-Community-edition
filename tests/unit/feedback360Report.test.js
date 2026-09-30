'use strict';
/**
 * 360° feedback — the anonymity rules of the report (src/services/Feedback360Report.js).
 * Pure: no database. The rules, one test each:
 *   - an anonymous group below the floor is merged into "others" when the merged
 *     pool reaches the floor, and hidden otherwise;
 *   - A GROUP OF TWO IS NEVER SHOWN — not as a group, not merged below the
 *     floor, not through a combined figure, not through its comments;
 *   - "not observed" is never counted as 0 and never enters an average;
 *   - the floor is never below 3, whatever a round was created with;
 *   - the report carries no rater identity and shuffles comments.
 */
const R = require('../../src/services/Feedback360Report');

const items = [
    { type: 'skill', key: '1', label: 'Welding', required: 3 },
    { type: 'skill', key: '2', label: 'Planning', required: 2 },
    { type: 'behaviour', key: 'b_listens', label: 'Listens' },
];
/** One response of `group`, with ratings for skills 1 and 2 and the behaviour. */
const resp = (group, r1, r2, rb, comment) => ({
    group,
    answers: [
        { itemType: 'skill', itemKey: '1', rating: r1 },
        { itemType: 'skill', itemKey: '2', rating: r2 },
        { itemType: 'behaviour', itemKey: 'b_listens', rating: rb },
        ...(comment ? [{ itemType: 'comment', itemKey: 'keep', body: comment }] : []),
    ],
});
const skill = (rep, key) => rep.skills.find((s) => s.key === key);
const group = (rep, key) => rep.groups.find((g) => g.key === key);

describe('resolveGroups — shown, merged, hidden', () => {
    test('a group at the floor is shown; below it, merged into others when the pool reaches it', () => {
        const r = R.resolveGroups({ self: 1, manager: 1, peer: 3, direct_report: 2, other: 1 }, 3);
        expect(r.state.peer).toBe('shown');
        expect(r.state.direct_report).toBe('merged');
        expect(r.target.direct_report).toBe('other');
        expect(r.state.other).toBe('shown');
        expect(r.othersSize).toBe(3);
    });

    test('a GROUP OF TWO with nothing to merge into is HIDDEN', () => {
        const r = R.resolveGroups({ self: 1, manager: 1, peer: 3, direct_report: 2, other: 0 }, 3);
        expect(r.state.direct_report).toBe('hidden');
        expect(r.target.direct_report).toBeNull();
        expect(r.state.other).toBe('empty');
        expect(r.target.other).toBeNull();
    });

    test('two small groups whose pool stays under the floor are both hidden', () => {
        const r = R.resolveGroups({ peer: 1, direct_report: 1, other: 0 }, 3);
        expect(r.state.peer).toBe('hidden');
        expect(r.state.direct_report).toBe('hidden');
        expect(r.target.peer).toBeNull();
    });

    test('the floor is never below 3 (a round stored with 1 or 2 is lifted)', () => {
        expect(R.floorOf(1)).toBe(3);
        expect(R.floorOf(2)).toBe(3);
        expect(R.floorOf(undefined)).toBe(3);
        expect(R.floorOf(5)).toBe(5);
        const r = R.resolveGroups({ peer: 2 }, 1);
        expect(r.threshold).toBe(3);
        expect(r.state.peer).toBe('hidden');
    });

    test('self and manager are named groups: shown with one response', () => {
        const r = R.resolveGroups({ self: 1, manager: 1 }, 3);
        expect(r.state.self).toBe('shown');
        expect(r.state.manager).toBe('shown');
    });
});

describe('buildReport — a group of 2 is never shown', () => {
    // Peers: 3 answers. Direct reports: 2 answers with EXTREME values and a
    // unique comment, and no "others" to merge into.
    const rep = R.buildReport({
        items,
        threshold: 3,
        responses: [
            resp('self', 4, 1, 3, 'self keep'),
            resp('manager', 2, 'na', 2, 'manager keep'),
            resp('peer', 2, null, 2, 'peer one'),
            resp('peer', 2, null, 3),
            resp('peer', 3, 1, 2),
            resp('direct_report', 0, 0, 0, 'DR-SECRET-A'),
            resp('direct_report', 0, 0, 0, 'DR-SECRET-B'),
        ],
    });

    test('the group is reported hidden, without its size', () => {
        const dr = group(rep, 'direct_report');
        expect(dr.state).toBe('hidden');
        expect(dr.responses).toBeUndefined();
    });

    test('its ratings reach no column, no aggregate and no others view', () => {
        const k1 = skill(rep, '1');
        expect(k1.byGroup.direct_report).toBeUndefined();
        // Others = peers only: (2+2+3)/3. Had the zeros counted, it would be 1.4.
        expect(k1.others).toEqual({ state: 'rated', value: 2.33, observed: 3 });
        // Others' view = manager (2) + peers (2,2,3) → 2.25, never touching the zeros.
        expect(k1.othersView).toBe(2.25);
        const flat = JSON.stringify(rep);
        expect(flat).not.toContain('DR-SECRET');
    });

    test('its comments are dropped too', () => {
        const all = [...rep.comments.keep, ...rep.comments.start, ...rep.comments.stop];
        expect(all.sort()).toEqual(['manager keep', 'peer one', 'self keep']);
    });
});

describe('buildReport — "not observed" is not zero', () => {
    const rep = R.buildReport({
        items,
        threshold: 3,
        responses: [
            resp('self', 3, 2, 3),
            resp('manager', 'na', null, 2),
            resp('peer', 2, 'na', 2),
            resp('peer', 4, 'na', 2),
            resp('peer', 3, 1, 'na'),
        ],
    });

    test('a named rater who did not observe is "not observed", not 0', () => {
        expect(skill(rep, '1').manager).toEqual({ state: 'not_observed', value: null });
    });

    test('non-observations leave the average AND its denominator', () => {
        // Peers observed skill 1 three times: (2+4+3)/3 = 3 — not (2+4+3+0)/4.
        expect(skill(rep, '1').byGroup.peer).toEqual({ state: 'rated', value: 3, observed: 3 });
        const beh = rep.behaviours[0];
        // Only two peers observed the behaviour: under the floor → no figure at all.
        expect(beh.byGroup.peer).toEqual({ state: 'too_few_observed', value: null });
        expect(beh.others.value).toBeNull();
    });

    test('an item nobody observed enough is "too few", never an average of zeros', () => {
        const k2 = skill(rep, '2');
        expect(k2.byGroup.peer.state).toBe('too_few_observed');
        expect(k2.others.value).toBeNull();
        // Others' view falls back to what IS printable (here nothing but self).
        expect(k2.othersView).toBeNull();
        expect(k2.gap).toBeNull();
    });

    test('ratingOf: only 0..4 are ratings', () => {
        expect(R.ratingOf('0')).toBe(0);
        expect(R.ratingOf(4)).toBe(4);
        for (const v of ['na', '', null, undefined, 5, -1, '2.5', 'x'])
            expect(R.ratingOf(v)).toBeNull();
    });
});

describe('buildReport — merging and gaps', () => {
    test('small groups merged into others are aggregated as others, and said so', () => {
        const rep = R.buildReport({
            items,
            threshold: 3,
            responses: [
                resp('self', 1, 1, 1),
                resp('peer', 3, 3, 3),
                resp('direct_report', 3, 3, 3),
                resp('other', 4, 4, 4),
            ],
        });
        expect(group(rep, 'peer')).toEqual({ key: 'peer', state: 'merged', mergedInto: 'other' });
        expect(group(rep, 'other')).toMatchObject({ state: 'shown', responses: 3 });
        expect(group(rep, 'other').mergedFrom.sort()).toEqual(['direct_report', 'peer']);
        const k1 = skill(rep, '1');
        expect(k1.byGroup.other.value).toBe(3.33);
        expect(k1.byGroup.peer).toBeUndefined();
        // Self 1 vs others 3.33: a hidden strength.
        expect(k1.flag).toBe('hidden_strength');
        expect(rep.hiddenStrengths.map((h) => h.key)).toContain('1');
    });

    test('self far above others is a blind spot', () => {
        const rep = R.buildReport({
            items,
            threshold: 3,
            responses: [
                resp('self', 4, 2, 2),
                resp('manager', 2, 2, 2),
                resp('peer', 2, 2, 2),
                resp('peer', 2, 2, 2),
                resp('peer', 2, 2, 2),
            ],
        });
        expect(skill(rep, '1').flag).toBe('blind_spot');
        expect(skill(rep, '2').flag).toBeNull();
        expect(rep.blindSpots.map((b) => b.key)).toEqual(['1']);
        expect(skill(rep, '1').required).toBe(3);
    });
});

describe('buildReport — no identity in, none out', () => {
    test('the output carries no id, name or order of the raters', () => {
        const rep = R.buildReport({
            items,
            threshold: 3,
            responses: [
                { ...resp('peer', 2, 2, 2, 'c1'), raterId: 901, name: 'Zed Rater', id: 'uuid-1' },
                { ...resp('peer', 3, 3, 3, 'c2'), raterId: 902, name: 'Yan Rater', id: 'uuid-2' },
                { ...resp('peer', 4, 4, 4, 'c3'), raterId: 903, name: 'Xia Rater', id: 'uuid-3' },
            ],
        });
        const flat = JSON.stringify(rep);
        for (const leak of ['901', '902', '903', 'Rater', 'uuid-', 'raterId'])
            expect(flat).not.toContain(leak);
        expect(rep.comments.keep.sort()).toEqual(['c1', 'c2', 'c3']);
    });

    test('comments are shuffled with a CSPRNG (every order is reachable)', () => {
        const seen = new Set();
        for (let i = 0; i < 200; i++) seen.add(R.shuffle(['a', 'b', 'c']).join(''));
        expect(seen.size).toBe(6);
    });
});
