'use strict';
/**
 * 3.23.21 — public/js/sa-skill-help.js, the ONE helper behind « Qu'est-ce que
 * c'est ? » (self-assessment + reviewer console).
 *
 *  · Node: the pure core — level text precedence (skill anchor → category
 *    anchor → generic scale; page language first), escaping of every string
 *    in the JS render path (XSS payload), gap text, evidence nudges.
 *  · Browser (vm, minimal DOM): « Afficher toutes les descriptions » opens every
 *    panel and is remembered; Esc closes an open panel and returns focus to its
 *    summary; choosing a level writes its meaning, reveals the required level
 *    only then, and swaps the notes placeholder for a nudge.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'sa-skill-help.js'), 'utf8');
const core = require('../../public/js/sa-skill-help.js');

const LABELS = {
    words: ['Aucun', 'Notions', 'Guidé', 'Autonome', 'Expert'],
    titles: ['G0', 'G1', 'G2', 'G3', 'G4'],
};
const XSS = '<img src=x onerror=alert(1)>\nline2';

describe('resolve — which text each level shows', () => {
    const raw = {
        descriptionFr: 'Texte FR',
        descriptionEn: 'Text EN',
        anchors: {
            skill: { 2: { fr: 'propre 2', en: 'own 2' }, 3: { fr: '', en: 'own 3 en only' } },
            category: { 0: { fr: 'cat 0', en: 'cat 0 en' }, 2: { fr: 'cat 2', en: 'cat 2 en' } },
        },
    };
    test('skill anchor > category anchor > generic scale title', () => {
        const r = core.resolve(raw, 'fr', LABELS);
        expect(r.levels.map((l) => l.text)).toEqual([
            'cat 0',
            'G1',
            'propre 2',
            'own 3 en only',
            'G4',
        ]);
        expect(r.levels.map((l) => l.source)).toEqual([
            'category',
            'generic',
            'skill',
            'skill',
            'generic',
        ]);
    });
    test('the page language first, the other one as a fallback', () => {
        expect(core.resolve(raw, 'en', LABELS).description).toBe('Text EN');
        expect(core.resolve({ descriptionFr: 'seulement FR' }, 'en', LABELS).description).toBe(
            'seulement FR'
        );
        expect(core.resolve({ descriptionEn: 'only EN' }, 'fr', LABELS).description).toBe(
            'only EN'
        );
    });
    test('nothing known → no description, generic scale', () => {
        const r = core.resolve(null, 'fr', LABELS);
        expect(r.description).toBeNull();
        expect(r.levels.map((l) => l.text)).toEqual(LABELS.titles);
    });
});

describe('panelHtml — the JS render path escapes everything', () => {
    const t = {
        summary: "Qu'est-ce que c'est ?",
        noDesc: 'NODESC',
        subDomain: 'SD',
        levelsTitle: 'LT',
        selectedTag: 'SEL',
        requiredTag: 'REQ',
    };
    test('an XSS description is text, not markup; required and self-rating are marked', () => {
        const help = core.resolve(
            {
                descriptionFr: XSS,
                subDomainName: '<b>x</b>',
                anchors: { skill: { 1: { fr: '"><script>alert(2)</script>' } } },
            },
            'fr',
            LABELS
        );
        const html = core.panelHtml({ id: '7', help, selected: 3, required: 2, mode: 'review', t });
        expect(html).not.toMatch(/<img/);
        expect(html).not.toMatch(/<script/);
        expect(html).not.toMatch(/<b>x/);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;\nline2');
        expect(html).toContain('id="sk-desc-7"');
        expect(html).toMatch(/<li data-level="3" class="is-selected">[\s\S]*?SEL/);
        expect(html).toMatch(/<li data-level="2" class="is-required">[\s\S]*?REQ/);
    });
    test('no description → the explicit message, never an empty box', () => {
        const html = core.panelHtml({ id: 1, help: core.resolve(null, 'fr', LABELS), t });
        expect(html).toMatch(/sa-skill-desc-missing[^>]*>NODESC</);
    });
});

describe('gap and nudges', () => {
    const t = { met: 'atteint', gap: 'écart %n%' };
    test('gap only once both levels exist', () => {
        expect(core.gapText(null, 3, t)).toBe('');
        expect(core.gapText(1, 3, t)).toBe('écart -2');
        expect(core.gapText(3, 3, t)).toBe('atteint');
    });
    test('4 or two above required → evidence; 0 → training; else default', () => {
        expect(core.nudgeFor(4, 4)).toBe('evidence');
        expect(core.nudgeFor(3, 1)).toBe('evidence');
        expect(core.nudgeFor(0, 2)).toBe('training');
        expect(core.nudgeFor(2, 2)).toBe('default');
        expect(core.nudgeFor(null, 2)).toBe('default');
    });
});

// ------------------------------------------------------------ minimal DOM
function el(tag, attrs, doc) {
    const n = {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        attrs: Object.assign({}, attrs || {}),
        children: [],
        parentNode: null,
        listeners: {},
        _text: '',
        open: false,
        hidden: false,
        readOnly: false,
        value: '',
        get textContent() {
            return this._text + this.children.map((c) => c.textContent).join('');
        },
        set textContent(v) {
            this._text = String(v);
            this.children = [];
        },
        getAttribute(k) {
            return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
        },
        setAttribute(k, v) {
            this.attrs[k] = String(v);
        },
        appendChild(c) {
            c.parentNode = this;
            this.children.push(c);
            return c;
        },
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        fire(type, ev) {
            (this.listeners[type] || []).forEach((fn) =>
                fn(Object.assign({ target: this }, ev || {}))
            );
        },
        focus() {
            doc.activeElement = this;
        },
        get classList() {
            const self = this;
            const list = () => (self.attrs.class || '').split(/\s+/).filter(Boolean);
            return {
                contains: (c) => list().includes(c),
                toggle: (c, on) => {
                    const l = list().filter((x) => x !== c);
                    if (on) l.push(c);
                    self.attrs.class = l.join(' ');
                },
            };
        },
        matches(sel) {
            return matches(this, sel);
        },
        closest(sel) {
            let c = this;
            while (c && c.nodeType === 1) {
                if (matches(c, sel)) return c;
                c = c.parentNode;
            }
            return null;
        },
        querySelectorAll(sel) {
            const out = [];
            const walk = (x) =>
                x.children.forEach((c) => {
                    if (matches(c, sel)) out.push(c);
                    walk(c);
                });
            walk(this);
            return out;
        },
        querySelector(sel) {
            return this.querySelectorAll(sel)[0] || null;
        },
    };
    return n;
}
function matches(node, sel) {
    const m = /^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
    if (!m) throw new Error('unsupported selector ' + sel);
    if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
    const classes = (m[2] || '').split('.').filter(Boolean);
    const own = (node.attrs.class || '').split(/\s+/);
    if (!classes.every((c) => own.includes(c))) return false;
    const attrs = (m[3] || '').match(/\[[^\]]+\]/g) || [];
    return attrs.every((a) => {
        const am = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(a);
        if (!(am[1] in node.attrs)) return false;
        return am[2] === undefined || node.attrs[am[1]] === am[2];
    });
}
function makeDoc() {
    const doc = { listeners: {}, readyState: 'complete', activeElement: null };
    const body = el('body', {}, doc);
    Object.assign(doc, {
        body,
        createElement: (t) => el(t, {}, doc),
        getElementById: (id) =>
            body.querySelectorAll('[id]').find((n) => n.attrs.id === id) || null,
        querySelectorAll: (s) => body.querySelectorAll(s),
        addEventListener: (type, fn) => (doc.listeners[type] = doc.listeners[type] || []).push(fn),
        mk: (tag, attrs, parent) => (parent || body).appendChild(el(tag, attrs, doc)),
    });
    return doc;
}
function row(doc, id, required) {
    const tr = doc.mk('tr', { 'data-required': String(required) });
    const th = doc.mk('th', {}, tr);
    const det = doc.mk('details', { class: 'sa-skill-help', id: 'sk-help-' + id }, th);
    doc.mk('summary', {}, det);
    const ul = doc.mk('ul', {}, det);
    for (let n = 0; n <= 4; n++) {
        const li = doc.mk('li', { 'data-level': String(n) }, ul);
        doc.mk('span', { class: 'sa-lvl-text' }, li).textContent = 'meaning ' + n;
        const tag = doc.mk('span', { class: 'sa-lvl-tag' }, li);
        tag.hidden = true;
        if (n === required) doc.mk('span', { class: 'sa-req-tag' }, li).hidden = true;
    }
    const cell = doc.mk('td', { 'data-req-cell': '' }, tr);
    cell.textContent = '—';
    const td = doc.mk('td', {}, tr);
    const sel = doc.mk('select', { class: 'self-rating-select', 'data-skill-id': String(id) }, td);
    doc.mk('p', { id: 'sk-lvl-' + id }, td);
    const ta = doc.mk('textarea', { placeholder: 'Notes' }, tr);
    return { tr, det, cell, sel, ta, ul };
}
function boot(doc, store) {
    const I18N = {
        levelLine: 'Niveau %n% :',
        met: 'atteint',
        gap: 'écart %n%',
        nudgeEvidence: 'EXEMPLE ?',
        nudgeTraining: 'FORMATION ?',
        showAll: 'Afficher',
        hideAll: 'Masquer',
    };
    doc.mk('script', { id: 'saHelpI18n' }).textContent = JSON.stringify(I18N);
    const win = {
        document: doc,
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => {
                store[k] = String(v);
            },
        },
    };
    win.window = win;
    const sandbox = { window: win, document: doc };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return win;
}

describe('in the browser (vm)', () => {
    test('« Afficher toutes les descriptions » opens every panel and is remembered', () => {
        const doc = makeDoc();
        const a = row(doc, 1, 3);
        const b = row(doc, 2, 1);
        const btn = doc.mk('button', { id: 'saHelpToggleAll', 'aria-pressed': 'false' });
        doc.mk('span', { id: 'saHelpToggleAllLabel' }, btn);
        const store = {};
        const win = boot(doc, store);
        expect(typeof win.SkillHelp.resolve).toBe('function');
        expect(a.det.open || b.det.open).toBe(false); // default collapsed
        btn.fire('click');
        expect(a.det.open && b.det.open).toBe(true);
        expect(btn.getAttribute('aria-pressed')).toBe('true');
        expect(store.saHelpAllOpen).toBe('1');
        btn.fire('click');
        expect(a.det.open || b.det.open).toBe(false);
        expect(store.saHelpAllOpen).toBe('0');
        // A new page load on the same device starts open.
        const doc2 = makeDoc();
        const c = row(doc2, 3, 2);
        const btn2 = doc2.mk('button', { id: 'saHelpToggleAll', 'aria-pressed': 'false' });
        boot(doc2, { saHelpAllOpen: '1' });
        expect(c.det.open).toBe(true);
        expect(btn2.getAttribute('aria-pressed')).toBe('true');
    });

    test('Esc closes the open panel and puts the focus back on its summary', () => {
        const doc = makeDoc();
        const a = row(doc, 1, 3);
        boot(doc, {});
        a.det.open = true;
        const inside = a.det.querySelector('ul');
        const prevented = jest.fn();
        doc.listeners.keydown.forEach((fn) =>
            fn({ key: 'Escape', target: inside, preventDefault: prevented })
        );
        expect(a.det.open).toBe(false);
        expect(doc.activeElement).toBe(a.det.querySelector('summary'));
        expect(prevented).toHaveBeenCalled();
        // Another key does nothing.
        a.det.open = true;
        doc.listeners.keydown.forEach((fn) => fn({ key: 'a', target: inside }));
        expect(a.det.open).toBe(true);
    });

    test('choosing a level: its meaning, then the required level + gap, then the nudge', () => {
        const doc = makeDoc();
        const a = row(doc, 5, 3);
        boot(doc, {});
        expect(a.cell.textContent).toBe('—'); // required hidden until rated
        a.sel.value = '1';
        a.sel.fire('change');
        expect(doc.getElementById('sk-lvl-5').textContent).toBe('Niveau 1 : meaning 1');
        expect(a.cell.textContent).toBe('3 · écart -2');
        expect(a.ul.querySelector('.sa-req-tag').hidden).toBe(false);
        const li1 = a.ul.querySelectorAll('li[data-level]')[1];
        expect(li1.classList.contains('is-selected')).toBe(true);
        expect(li1.querySelector('.sa-lvl-tag').hidden).toBe(false);
        expect(a.ta.getAttribute('placeholder')).toBe('Notes');
        a.sel.value = '4';
        a.sel.fire('change');
        expect(a.ta.getAttribute('placeholder')).toBe('EXEMPLE ?');
        expect(a.cell.textContent).toBe('3 · atteint');
        a.sel.value = '0';
        a.sel.fire('change');
        expect(a.ta.getAttribute('placeholder')).toBe('FORMATION ?');
        a.sel.value = '2';
        a.sel.fire('change');
        expect(a.ta.getAttribute('placeholder')).toBe('Notes'); // back to the default
    });

    test('a read-only (locked) note is never nudged', () => {
        const doc = makeDoc();
        const a = row(doc, 6, 2);
        a.ta.readOnly = true;
        boot(doc, {});
        a.sel.value = '4';
        a.sel.fire('change');
        expect(a.ta.getAttribute('placeholder')).toBe('Notes');
    });
});
