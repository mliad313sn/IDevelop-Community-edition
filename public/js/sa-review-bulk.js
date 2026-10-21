/**
 * sa-review-bulk.js — the rules of the review console's multi-skill approval,
 * as pure functions (the page script does the DOM).
 *
 * Which line may join a multi-skill approval, and why not — the service's
 * rules, nothing invented:
 *  - only an approvable state (submitted, under_review, reviewed);
 *  - `arbitration` (a dispute in progress) is decided on its own, never swept
 *    by a bulk action (SelfAssessmentWorkflowService.approveSelected);
 *  - a rating the reviewer CHANGED needs its written reason (approve() refuses
 *    it otherwise): the line joins once the reason is typed.
 * The level sent is the one PROPOSED on the line: the self level, or the
 * reviewer's own when they changed it.
 *
 * Tests: tests/unit/saReviewBulkRules.test.js
 */
(function (root) {
    'use strict';

    var APPROVABLE = ['submitted', 'under_review', 'reviewed'];
    var ACTIONABLE = ['submitted', 'under_review', 'reviewed', 'arbitration'];

    function str(v) {
        return v === null || v === undefined ? '' : String(v);
    }

    var RULES = {
        APPROVABLE: APPROVABLE,
        ACTIONABLE: ACTIONABLE,

        /** Is the reviewer's chosen level different from the employee's own? */
        isOverride: function (self, chosen) {
            var s = str(self);
            var c = str(chosen);
            return c !== '' && s !== '' && c !== s;
        },

        /**
         * May this line be ticked for a multi-skill approval?
         * @param {{state:string, self:any, chosen:any, reason:string}} line
         * @returns {{show:boolean, selectable:boolean, why:(null|'arbitration'|'reason')}}
         *   show: a selection cell with a box at all (any actionable state);
         *   why:  the reason written under a disabled box.
         */
        eligibility: function (line) {
            var l = line || {};
            var st = str(l.state);
            if (ACTIONABLE.indexOf(st) < 0) return { show: false, selectable: false, why: null };
            if (st === 'arbitration') return { show: true, selectable: false, why: 'arbitration' };
            if (RULES.isOverride(l.self, l.chosen) && !str(l.reason).trim())
                return { show: true, selectable: false, why: 'reason' };
            return { show: true, selectable: true, why: null };
        },

        /**
         * The request items for the chosen lines, and the ids still missing a reason.
         * @param {Array<{id:number, self:any, chosen:any, reason:string}>} lines
         * @returns {{items:Array, missingReason:number[]}}
         */
        itemsFor: function (lines) {
            var items = [];
            var missing = [];
            (lines || []).forEach(function (l) {
                var it = { id: Number(l.id) };
                var chosen = str(l.chosen);
                if (chosen !== '') it.supervisorLevel = Number(chosen);
                if (RULES.isOverride(l.self, chosen)) {
                    var why = str(l.reason).trim();
                    if (!why) {
                        missing.push(Number(l.id));
                        return;
                    }
                    it.gapReason = why;
                }
                items.push(it);
            });
            return { items: items, missingReason: missing };
        },

        /** "1 skill" / "3 skills" — two catalogue strings, {n} filled. */
        plural: function (n, one, other) {
            return String(Number(n) === 1 ? one : other).replace(/\{n\}/g, String(n));
        },

        /** Fill {name} / {n} / {skill} from a whitelist object (text, never HTML). */
        fill: function (tpl, vars) {
            return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, function (m, k) {
                return vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
            });
        },
    };

    root.SABulkRules = RULES;
    if (typeof module !== 'undefined' && module.exports) module.exports = RULES;
})(typeof window !== 'undefined' ? window : globalThis);
