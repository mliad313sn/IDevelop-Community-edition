/**
 * sa-skill-help.js — « Qu'est-ce que c'est ? » : what a skill and each of its
 * levels mean, on the self-assessment page and in the reviewer's console.
 *
 * ONE file, two uses:
 *   · in Node (require) it exports the pure core — resolve, panelHtml,
 *     esc — which the server partial views/partials/skill-help.ejs uses
 *     through src/utils/skillHelp.js, so the server and the browser can never
 *     disagree on which text a level shows;
 *   · in the browser it also wires the page behaviour (boot): the live meaning
 *     of the chosen level, the required level revealed only once a row is
 *     rated, the evidence nudges, « Afficher toutes les descriptions », the
 *     intro remembered once read, and Esc to close an open panel.
 *
 * Text precedence for a level: the skill's own anchor, else the anchor of the
 * skill's category, else the generic scale title. For each, the page language
 * first, then the other language. Nothing here ever writes a string into
 * markup unescaped. No inline handlers; CSP-clean.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else if (root) {
        root.SkillHelp = api;
        if (root.document) {
            if (root.document.readyState === 'loading') {
                root.document.addEventListener('DOMContentLoaded', function () {
                    api.boot(root.document, root);
                });
            } else {
                api.boot(root.document, root);
            }
        }
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    var LEVELS = [0, 1, 2, 3, 4];

    function str(v) {
        return v === null || v === undefined ? '' : String(v);
    }
    function clean(v) {
        var s = str(v).trim();
        return s ? s : null;
    }
    function esc(v) {
        return str(v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    /** The page language first, then the other one. */
    function pick(fr, en, lang) {
        var a = clean(fr);
        var b = clean(en);
        return lang === 'en' ? b || a : a || b;
    }

    /**
     * raw    { descriptionFr, descriptionEn, subDomainName, subDomainDefinition,
     *          category, anchors: { skill: {N:{fr,en}}, category: {N:{fr,en}} } }
     *        (null/undefined = nothing known about the skill)
     * lang   'fr' | 'en'
     * labels { words: [5], titles: [5] } — the generic scale, already translated
     */
    function resolve(raw, lang, labels) {
        var r = raw || {};
        var a = r.anchors || {};
        var own = a.skill || {};
        var cat = a.category || {};
        var L = labels || {};
        var words = L.words || [];
        var titles = L.titles || [];
        var levels = LEVELS.map(function (n) {
            var s = own[n] || own[String(n)] || {};
            var c = cat[n] || cat[String(n)] || {};
            var t = pick(s.fr, s.en, lang);
            var source = 'skill';
            if (!t) {
                t = pick(c.fr, c.en, lang);
                source = 'category';
            }
            if (!t) {
                t = clean(titles[n]) || '';
                source = 'generic';
            }
            return { level: n, word: str(words[n]), text: t, source: source };
        });
        return {
            description: pick(r.descriptionFr, r.descriptionEn, lang),
            subDomainName: clean(r.subDomainName),
            subDomainDefinition: clean(r.subDomainDefinition),
            levels: levels,
        };
    }

    function lvl(v) {
        if (v === null || v === undefined || v === '') return null;
        var n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= 4 ? n : null;
    }

    /**
     * The panel for the JS render path (reviewer console). Same markup as the
     * server partial. `t` carries the translated strings.
     * opts { id, help (resolved), selected, required, mode: 'self'|'review', t }
     */
    function panelHtml(opts) {
        var o = opts || {};
        var t = o.t || {};
        var h = o.help || resolve(null, 'fr', {});
        var id = esc(o.id);
        var sel = lvl(o.selected);
        var req = lvl(o.required);
        var html =
            '<details class="sa-skill-help" data-skill-help>' +
            '<summary class="sa-skill-help-btn"><span class="sa-skill-help-icon" aria-hidden="true">ⓘ</span> ' +
            '<span class="sa-skill-help-label">' +
            esc(t.summary) +
            '</span></summary>' +
            '<div class="sa-skill-help-panel">' +
            '<p class="sa-skill-desc' +
            (h.description ? '' : ' sa-skill-desc-missing') +
            '" id="sk-desc-' +
            id +
            '">' +
            esc(h.description || t.noDesc) +
            '</p>';
        if (h.subDomainName) {
            html +=
                '<p class="sa-skill-sub"><strong>' +
                esc(t.subDomain) +
                '</strong> ' +
                esc(h.subDomainName) +
                (h.subDomainDefinition ? ' — ' + esc(h.subDomainDefinition) : '') +
                '</p>';
        }
        html +=
            '<p class="sa-skill-levels-title">' +
            esc(t.levelsTitle) +
            '</p><ul class="sa-skill-levels">';
        h.levels.forEach(function (L) {
            var cls = [];
            if (sel === L.level) cls.push('is-selected');
            if (req === L.level) cls.push('is-required');
            html +=
                '<li data-level="' +
                L.level +
                '"' +
                (cls.length ? ' class="' + cls.join(' ') + '"' : '') +
                '><strong>' +
                L.level +
                (L.word ? ' – ' + esc(L.word) : '') +
                '</strong> : <span class="sa-lvl-text">' +
                esc(L.text) +
                '</span>' +
                (sel === L.level
                    ? ' <span class="sa-lvl-tag">' + esc(t.selectedTag) + '</span>'
                    : '') +
                (req === L.level
                    ? ' <span class="sa-req-tag">' + esc(t.requiredTag) + '</span>'
                    : '') +
                '</li>';
        });
        html += '</ul></div></details>';
        return html;
    }

    /** « atteint » / « écart -2 » — the required level is only compared once rated. */
    function gapText(self, required, t) {
        var s = lvl(self);
        var r = lvl(required);
        if (s === null || r === null) return '';
        if (s >= r) return str((t || {}).met);
        return str((t || {}).gap).replace('%n%', String(s - r));
    }

    /** Which notes placeholder a level calls for (never mandatory). */
    function nudgeFor(self, required) {
        var s = lvl(self);
        var r = lvl(required);
        if (s === null) return 'default';
        if (s === 0) return 'training';
        if (s === 4 || (r !== null && s - r >= 2)) return 'evidence';
        return 'default';
    }

    // ------------------------------------------------------------------ DOM
    function store(win) {
        try {
            return win && win.localStorage ? win.localStorage : null;
        } catch (_) {
            return null;
        }
    }
    function getItem(win, k) {
        var s = store(win);
        if (!s) return null;
        try {
            return s.getItem(k);
        } catch (_) {
            return null;
        }
    }
    function setItem(win, k, v) {
        var s = store(win);
        if (!s) return;
        try {
            s.setItem(k, v);
        } catch (_) {
            /* private mode — the page still works */
        }
    }
    function readI18n(doc) {
        var el = doc.getElementById('saHelpI18n');
        if (!el) return {};
        try {
            return JSON.parse(el.textContent || '{}') || {};
        } catch (_) {
            return {};
        }
    }

    function onLevelChange(doc, select, t) {
        var id = select.getAttribute('data-skill-id');
        var row = select.closest ? select.closest('tr') : null;
        var v = lvl(select.value);
        var required = row ? lvl(row.getAttribute('data-required')) : null;
        // 1. The live meaning of the chosen level.
        var panel = doc.getElementById('sk-help-' + id);
        var line = doc.getElementById('sk-lvl-' + id);
        if (panel) {
            var items = panel.querySelectorAll('li[data-level]');
            for (var i = 0; i < items.length; i++) {
                var li = items[i];
                var n = lvl(li.getAttribute('data-level'));
                var on = n === v;
                if (li.classList) li.classList.toggle('is-selected', on);
                var tag = li.querySelector('.sa-lvl-tag');
                if (tag) tag.hidden = !on;
                if (on && line) {
                    var txt = li.querySelector('.sa-lvl-text');
                    line.textContent =
                        str(t.levelLine).replace('%n%', String(v)) +
                        ' ' +
                        (txt ? txt.textContent : '');
                }
                // 2. The required level is marked only once the row is rated.
                var rtag = li.querySelector('.sa-req-tag');
                if (rtag && v !== null) rtag.hidden = false;
            }
        }
        // 3. Required-level cell: « — » until rated, then the level and the gap.
        var cell = row ? row.querySelector('[data-req-cell]') : null;
        if (cell && v !== null && required !== null) {
            cell.textContent = String(required);
            var g = gapText(v, required, t);
            if (g) {
                var sp = doc.createElement('span');
                sp.className = 'sa-req-gap';
                sp.textContent = ' · ' + g;
                cell.appendChild(sp);
            }
            cell.setAttribute('data-revealed', '1');
        }
        // 4. Evidence nudge on the notes placeholder — never a requirement.
        var ta = row ? row.querySelector('textarea') : null;
        if (ta && !ta.readOnly) {
            if (!ta.getAttribute('data-default-ph'))
                ta.setAttribute('data-default-ph', ta.getAttribute('placeholder') || '');
            var kind = nudgeFor(v, required);
            ta.setAttribute(
                'placeholder',
                kind === 'evidence'
                    ? str(t.nudgeEvidence)
                    : kind === 'training'
                      ? str(t.nudgeTraining)
                      : ta.getAttribute('data-default-ph')
            );
        }
    }

    function boot(doc, win) {
        if (!doc || !doc.querySelectorAll) return;
        var t = readI18n(doc);

        // Esc closes an open panel and returns focus to its summary (WCAG 2.1.2).
        doc.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape' || !e.target || !e.target.closest) return;
            var d = e.target.closest('details.sa-skill-help');
            if (d && d.open) {
                d.open = false;
                var s = d.querySelector('summary');
                if (s && s.focus) s.focus();
                if (e.preventDefault) e.preventDefault();
            }
        });

        // Rating rows (self-assessment page only).
        var selects = doc.querySelectorAll('select.self-rating-select[data-skill-id]');
        for (var i = 0; i < selects.length; i++) {
            (function (s) {
                s.addEventListener('change', function () {
                    onLevelChange(doc, s, t);
                });
            })(selects[i]);
        }

        // « Afficher toutes les descriptions / Tout masquer », remembered per device.
        var btn = doc.getElementById('saHelpToggleAll');
        if (btn) {
            var label = doc.getElementById('saHelpToggleAllLabel') || btn;
            var apply = function (open) {
                var all = doc.querySelectorAll('details.sa-skill-help');
                for (var k = 0; k < all.length; k++) all[k].open = open;
                btn.setAttribute('aria-pressed', open ? 'true' : 'false');
                label.textContent = open ? str(t.hideAll) : str(t.showAll);
            };
            if (getItem(win, 'saHelpAllOpen') === '1') apply(true);
            btn.addEventListener('click', function () {
                var open = btn.getAttribute('aria-pressed') !== 'true';
                apply(open);
                setItem(win, 'saHelpAllOpen', open ? '1' : '0');
            });
        }

        // The intro opens the first time, then stays folded once read.
        var intro = doc.getElementById('saIntro');
        if (intro) {
            if (getItem(win, 'saIntroRead') === '1') intro.open = false;
            intro.addEventListener('toggle', function () {
                if (!intro.open) setItem(win, 'saIntroRead', '1');
            });
        }
    }

    return {
        resolve: resolve,
        panelHtml: panelHtml,
        gapText: gapText,
        nudgeFor: nudgeFor,
        esc: esc,
        boot: boot,
        _onLevelChange: onLevelChange,
    };
});
