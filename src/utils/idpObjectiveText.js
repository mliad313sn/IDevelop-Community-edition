'use strict';

/**
 * idpObjectiveText — an objective the MACHINE wrote, shown in the READER's
 * language (4.0.0 port, wave 4).
 *
 * The development triggers write a plan objective in the language of the
 * request that opened it (DevelopmentTriggerService COACHING_PIP_TEMPLATES).
 * The stored text is a dated document and is never rewritten; but a sentence
 * that is exactly one of the machine's templates can be recognised and printed
 * again in the reader's language, through the catalogue keys idp:obj_seed and
 * idp:obj_seed_unmeasured. Free text typed by a person, or anything that does
 * not match a template exactly, prints as stored.
 *
 * The recognisers are plain prefix / infix / suffix checks, never a regular
 * expression over the stored text (no backtracking on input).
 */

const TEMPLATES = Object.freeze([
    // `Develop "<skill>" from level <n> to <m>`
    Object.freeze({
        head: 'Develop "',
        mid: '" from level ',
        join: ' to ',
        tail: '',
        measured: true,
    }),
    // `Développer « <skill> » du niveau <n> au niveau <m>`
    Object.freeze({
        head: 'Développer « ',
        mid: ' » du niveau ',
        join: ' au niveau ',
        tail: '',
        measured: true,
    }),
    // `Reach level <m> in "<skill>" (current level not assessed)`
    Object.freeze({
        head: 'Reach level ',
        mid: ' in "',
        tail: '" (current level not assessed)',
        measured: false,
    }),
    // `Atteindre le niveau <m> en « <skill> » (niveau actuel non évalué)`
    Object.freeze({
        head: 'Atteindre le niveau ',
        mid: ' en « ',
        tail: ' » (niveau actuel non évalué)',
        measured: false,
    }),
]);

const isLevel = (t) => t.length === 1 && t >= '0' && t <= '4';

/** { skill, from, to } when `raw` is exactly one machine template, else null. */
function parse(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text || text.length > 400) return null;
    for (const t of TEMPLATES) {
        if (!text.startsWith(t.head) || !text.endsWith(t.tail)) continue;
        const body = text.slice(t.head.length, text.length - t.tail.length);
        if (t.measured) {
            // <skill><mid><from><join><to>
            const j = body.lastIndexOf(t.join);
            if (j < 0) continue;
            const to = body.slice(j + t.join.length);
            const left = body.slice(0, j);
            const m = left.lastIndexOf(t.mid);
            if (m <= 0) continue;
            const from = left.slice(m + t.mid.length);
            const skill = left.slice(0, m);
            if (isLevel(from) && isLevel(to) && skill.trim())
                return { skill, from: Number(from), to: Number(to) };
        } else {
            // <to><mid><skill>
            const m = body.indexOf(t.mid);
            if (m < 0) continue;
            const to = body.slice(0, m);
            const skill = body.slice(m + t.mid.length);
            if (isLevel(to) && skill.trim()) return { skill, from: null, to: Number(to) };
        }
    }
    return null;
}

/**
 * The text to print for a stored objective, in the reader's language when the
 * machine wrote it. `t` is the request's translator (req.t / res.locals.__).
 */
function display(raw, t) {
    const stored = String(raw == null ? '' : raw);
    const v = parse(stored);
    if (!v || typeof t !== 'function') return stored;
    const key = v.from == null ? 'idp:obj_seed_unmeasured' : 'idp:obj_seed';
    const out = t(key, { skill: v.skill, from: v.from, to: v.to });
    return typeof out === 'string' && out && out !== key && out.indexOf('{{') < 0 ? out : stored;
}

module.exports = { parse, display, TEMPLATES };
