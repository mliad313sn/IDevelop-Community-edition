'use strict';
/**
 * public/js/sa-review-bulk.js — the review console's selection rules (pure):
 * which line may join a multi-skill approval and why not, what is sent. Plus
 * the wiring the console relies on: the route's guards and the page's flag.
 */
const fs = require('fs');
const path = require('path');
const R = require('../../public/js/sa-review-bulk.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('selection rules', () => {
    test('only an approvable line is selectable; arbitration shows a disabled box with its reason', () => {
        expect(R.eligibility({ state: 'submitted', self: 2, chosen: 2 })).toEqual({
            show: true,
            selectable: true,
            why: null,
        });
        expect(R.eligibility({ state: 'reviewed', self: 2, chosen: '2' }).selectable).toBe(true);
        expect(R.eligibility({ state: 'arbitration', self: 2, chosen: 2 })).toEqual({
            show: true,
            selectable: false,
            why: 'arbitration',
        });
        for (const st of ['approved', 'rejected', 'draft', 'changes_requested'])
            expect(R.eligibility({ state: st }).show).toBe(false);
    });

    test('a changed rating needs its written reason before it can join', () => {
        expect(R.eligibility({ state: 'submitted', self: 2, chosen: '3', reason: '' })).toEqual({
            show: true,
            selectable: false,
            why: 'reason',
        });
        expect(
            R.eligibility({ state: 'submitted', self: 2, chosen: '3', reason: '  ' }).selectable
        ).toBe(false);
        expect(
            R.eligibility({ state: 'submitted', self: 2, chosen: '3', reason: 'seen' }).selectable
        ).toBe(true);
        // no self level: the empty proposal is not an override
        expect(R.isOverride('', '')).toBe(false);
        expect(R.isOverride(null, '')).toBe(false);
    });

    test('items carry the PROPOSED level (self, or the reviewer’s with its reason); missing reasons are reported', () => {
        const out = R.itemsFor([
            { id: '1', self: '2', chosen: '2', reason: '' },
            { id: 2, self: '2', chosen: '4', reason: ' on site ' },
            { id: 3, self: '1', chosen: '3', reason: '' },
            { id: 4, self: '', chosen: '', reason: '' },
        ]);
        expect(out.items).toEqual([
            { id: 1, supervisorLevel: 2 },
            { id: 2, supervisorLevel: 4, gapReason: 'on site' },
            { id: 4 },
        ]);
        expect(out.missingReason).toEqual([3]);
    });

    test('plural + fill — catalogue strings, whitelisted variables, never HTML', () => {
        expect(R.plural(1, '1 skill', '{n} skills')).toBe('1 skill');
        expect(R.plural(3, '1 skill', '{n} skills')).toBe('3 skills');
        expect(R.fill('For {name} ({n})', { name: 'A', n: 2 })).toBe('For A (2)');
        expect(R.fill('{x}', {})).toBe('{x}');
        expect(R.fill('{constructor}', {})).toBe('{constructor}');
    });
});

describe('wiring', () => {
    const reg = (src, route) => {
        const i = src.indexOf(`'${route}'`);
        return src.slice(i, src.indexOf(')', src.indexOf('Controller', i)));
    };

    test('approve-selected: signed in, the session CSRF token, then the bulk guard', () => {
        const r = reg(
            read('src/routes/index.js'),
            '/api/self-assessment/employee/:employeeId/approve-selected'
        );
        expect(r).toMatch(
            /requireAuth,\s*requireSessionCsrf,\s*require\('..\/middleware\/requireBulkApproveRight'\),\s*SelfAssessmentWorkflowController\.approveSelected/
        );
    });

    test('the console loads the rules and offers the selection only when the page says so', () => {
        const v = read('views/pages/supervisor/self-assessment-review.ejs');
        expect(v).toContain('/js/sa-review-bulk.js?v=<%= assetVersion %>');
        expect(v).toMatch(/canBulk: typeof canBulk === 'undefined' \? false : !!canBulk/);
        expect(v).toContain("'/api/self-assessment/employee/'+Number(empId)+'/approve-selected'");
        const c = read('src/controllers/SelfAssessmentWorkflowController.js');
        expect(c).toMatch(/mayBulkApprove\(req\.user\)/);
    });

    test('every catalogue key the console names exists in FR and EN', () => {
        const v = read('views/pages/supervisor/self-assessment-review.ejs');
        const keys = [...new Set((v.match(/talentx:sab_[a-z_]+/g) || []).map((k) => k.slice(8)))];
        expect(keys.length).toBeGreaterThan(15);
        for (const lang of ['fr', 'en']) {
            const cat = JSON.parse(read(`locales/${lang}/talentx.json`));
            expect([lang, keys.filter((k) => !cat[k])]).toEqual([lang, []]);
        }
    });
});
