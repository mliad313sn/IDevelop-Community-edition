'use strict';
/**
 * UX LOT 2 — « Dire l'attente, et dire l'arrivée ».
 *
 * The self-assessment autosave told three lies, all in the same small block:
 *
 *  1. PARTIAL SAVE READ AS SAVED. `post()` returned a bare `true` whenever the
 *     server answered 200, even with a non-empty `skipped` list — rows the
 *     server had DECLINED (already submitted, approved, or a closed campaign).
 *     The autosave calls with `silent: true`, so it never saw the toast that
 *     explains the refusal; it just printed "enregistré HH:MM:SS" over work
 *     that had not been stored.
 *  2. "SAVING" BEFORE ANY REQUEST. The label was set to `sa_autosaving` at the
 *     top of the 2.5 s debounce, so for two and a half seconds it claimed a
 *     request was in flight while nothing had left the browser.
 *  3. A FAILURE SHOWED NOTHING. On error the label was set to '' — the reader
 *     whose work never reached the server was told exactly nothing, on the one
 *     state of this bar they actually have to act on.
 *
 * These are read off the view source rather than a DOM: the block is inline
 * page script, and what has to hold is the shape of the decision — which
 * branch produces which label — not a rendering.
 */

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const VIEW = read('views/pages/employee/self-assessment.ejs');

/** The body of a named function in the page script. */
const fnBody = (name) => {
    const i = VIEW.indexOf(`function ${name}(`);
    expect(i).toBeGreaterThan(-1);
    const open = VIEW.indexOf('{', i);
    let depth = 0;
    for (let k = open; k < VIEW.length; k++) {
        if (VIEW[k] === '{') depth++;
        else if (VIEW[k] === '}' && --depth === 0) return VIEW.slice(open, k + 1);
    }
    throw new Error(`unbalanced ${name}`);
};

describe('a partial save is never reported as a save', () => {
    test('post() returns what happened, not a bare boolean', () => {
        const body = fnBody('post');
        // The bare `return true;` on the 200 branch is what made a refusal
        // indistinguishable from a save.
        expect(body).toMatch(/return \{ ok: true, skipped \}/);
        expect(body).toMatch(/return \{ ok: false, skipped: \[\] \}/);
        expect(body).not.toMatch(/\breturn true;/);
    });

    test('only an EMPTY skipped list produces the "saved" label', () => {
        const body = fnBody('runAutosave');
        expect(body).toMatch(/r\.ok && !r\.skipped\.length/);
        expect(body).toMatch(/renderAutosave\('saved'\)/);
        // …and a 200 that skipped rows lands in the failed state, with a count.
        expect(body).toMatch(/renderAutosave\('failed',[\s\S]{0,120}?autosavePartial/);
    });

    test('a partial SUBMIT re-enables the button instead of closing the dialog', () => {
        expect(VIEW).toMatch(/if \(!r\.ok \|\| r\.skipped\.length\) \{ this\.disabled = false; \}/);
    });
});

describe('the label describes the moment it is shown', () => {
    test('the debounce says "unsaved", not "saving"', () => {
        const body = fnBody('scheduleAutosave');
        expect(body).toMatch(/renderAutosave\('pending'\)/);
        // The old line set the in-flight label before the timer even started.
        expect(body).not.toMatch(/SA_I18N\.saving/);
        expect(body).toMatch(/setTimeout\(runAutosave, 2500\)/);
    });

    test('"saving" is set when the request actually departs', () => {
        const body = fnBody('runAutosave');
        expect(body.indexOf("renderAutosave('saving')")).toBeGreaterThan(-1);
        expect(body.indexOf("renderAutosave('saving')")).toBeLessThan(body.indexOf('await post('));
    });
});

describe('a failure persists and can be retried', () => {
    test('the failed state renders a real retry control, not an empty string', () => {
        const body = fnBody('renderAutosave');
        expect(body).toMatch(/autosaveFailed/);
        expect(body).toMatch(/createElement\('button'\)/);
        expect(body).toMatch(/addEventListener\('click', runAutosave\)/);
        // The old code blanked the bar on failure.
        expect(fnBody('runAutosave')).not.toMatch(/textContent = ''/);
    });

    test('a retry cannot pile up a second in-flight save', () => {
        const body = fnBody('runAutosave');
        expect(body).toMatch(/if \(autosaveInFlight\) return/);
        expect(body).toMatch(/finally \{[\s\S]{0,80}?autosaveInFlight = false/);
    });

    test('the failed state is visually distinct — it is the one the reader must act on', () => {
        expect(VIEW).toMatch(/\.sa-autosave-failed\s*\{[^}]*color:/);
        expect(VIEW).toMatch(/classList\.toggle\('sa-autosave-failed', state === 'failed'\)/);
    });
});

describe('a routine confirmation no longer interrupts a screen reader', () => {
    const uif = read('public/js/ui-feedback.js');

    test('the toast region is POLITE by default', () => {
        // It was 'assertive' for every toast, so "enregistré" cut the reader
        // off mid-sentence — including mid-way through the content they were
        // reading in order to decide something.
        expect(uif).toMatch(/setAttribute\('aria-live', 'polite'\)/);
        expect(uif).not.toMatch(/setAttribute\('aria-live', 'assertive'\)/);
    });

    test('only an ERROR preempts, via its own role="alert"', () => {
        expect(uif).toMatch(/if \(type === 'error'\) t\.setAttribute\('role', 'alert'\)/);
    });
});

describe('every state has words, in both languages', () => {
    test.each([
        'sa_autosave_pending',
        'sa_autosave_failed',
        'sa_autosave_partial',
        'sa_autosave_retry',
    ])('%s exists in FR and EN and they differ', (key) => {
        const fr = JSON.parse(read('locales/fr/employee.json'));
        const en = JSON.parse(read('locales/en/employee.json'));
        expect(typeof fr[key]).toBe('string');
        expect(typeof en[key]).toBe('string');
        expect(fr[key].length).toBeGreaterThan(0);
        expect(en[key].length).toBeGreaterThan(0);
        expect(fr[key]).not.toBe(en[key]);
    });

    test('the partial message carries the count placeholder', () => {
        const fr = JSON.parse(read('locales/fr/employee.json'));
        const en = JSON.parse(read('locales/en/employee.json'));
        expect(fr.sa_autosave_partial).toContain('{{n}}');
        expect(en.sa_autosave_partial).toContain('{{n}}');
    });
});
