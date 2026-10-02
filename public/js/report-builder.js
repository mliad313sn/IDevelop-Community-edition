/* ================================================================
   REPORT BUILDER — Core Engine
   State management, section CRUD, filters, SQL gen,
   template system, 10 prebuilt templates, UI wiring

   NO mock/sample data lives here. Every section is drawn from
   /reports/data; a section that cannot load says so explicitly.
   ================================================================ */
/* global RBRenderers */
window.RB = (function () {
    'use strict';

    // Server-rendered strings (builder.ejs). English literals are the fallback
    // when the page did not inject them.
    const I18N = window.RB_I18N || {};
    function T(key, fallback) {
        var v = I18N[key];
        return typeof v === 'string' && v ? v : fallback;
    }

    // FRENCH-FIRST: never let a Date/Number format call pin its own locale.
    // builder.ejs injects `lang` ('fr-FR' / 'en-GB'); the fallback is French,
    // never the runtime/browser default.
    function _locale() {
        return typeof I18N.lang === 'string' && I18N.lang ? I18N.lang : 'fr-FR';
    }

    // Prebuilt-template labels. builder.ejs injects the localized strings under
    // I18N.pb; the English literal stays inline as the fallback so a missing key
    // degrades to the old text instead of an empty card.
    function TP(key, fallback) {
        var v = I18N.pb && I18N.pb[key];
        return typeof v === 'string' && v ? v : fallback;
    }

    // ── Source-to-field mapping ──
    // Keys and metric names MUST match SOURCE_SCHEMA in ReportDataService.js —
    // a source listed here that the server does not implement can only ever
    // render an error box.
    const SOURCE_META = {
        v_employee_readiness: {
            labelKey: 'src_readiness',
            label: 'Employee Readiness',
            dims: ['site', 'department', 'service', 'role', 'employee'],
            metrics: [
                'readinessPct',
                'pointsGained',
                'pointsRequired',
                'gapCount',
                'roleReady',
                'skillsMet',
                'totalRequired',
                'coveragePct',
                'assessedSkills',
                'expectedSkills',
                'neverAssessedSkills',
            ],
        },
        v_employee_skill_gaps: {
            labelKey: 'src_gaps',
            label: 'Skill Gaps',
            dims: ['site', 'department', 'service', 'role', 'employee', 'skill', 'domain'],
            metrics: [
                'requiredLevel',
                'currentLevel',
                'gap',
                'isCritical',
                'isMet',
                'criticalGapCount',
                'neverAssessedCount',
                'selfOnlyCount',
            ],
        },
        v_domain_capability: {
            labelKey: 'src_capability',
            label: 'Domain Capability',
            dims: ['site', 'department', 'service', 'role', 'domain', 'skill'],
            metrics: ['avgLevel', 'maxLevel', 'minLevel', 'assessmentCount', 'resolvedLevel'],
        },
        v_employee_details: {
            labelKey: 'src_employees',
            label: 'Employee Details',
            dims: ['site', 'department', 'service', 'role', 'employee'],
            metrics: ['employeeCount'],
        },
        v_resolved_assessments: {
            labelKey: 'src_assessments',
            label: 'Resolved Assessments',
            dims: ['employee', 'skill', 'domain'],
            metrics: ['resolvedLevel', 'assessmentCount'],
        },
        v_employee_assessment_coverage: {
            labelKey: 'src_coverage',
            label: 'Assessment Coverage',
            dims: ['site', 'department', 'service', 'role', 'employee'],
            metrics: [
                'coveragePct',
                'assessedSkills',
                'expectedSkills',
                'neverAssessedSkills',
                'selfOnlySkills',
                'validatedSkills',
                'readinessAssessedOnly',
                'neverAssessedEmployees',
                'employeeCount',
            ],
        },
        v_requirement_provenance: {
            labelKey: 'src_provenance',
            label: 'Requirement Provenance',
            dims: ['site', 'department', 'service', 'role', 'skill', 'domain', 'employee'],
            metrics: [
                'requirementCount',
                'assessedCount',
                'neverAssessedCount',
                'selfOnlyCount',
                'validatedCount',
                'requiredLevel',
                'assessedLevel',
            ],
        },
        nineBoxAssessments: {
            labelKey: 'src_ninebox',
            label: '9-Box Talent',
            dims: ['site', 'department', 'service', 'role', 'employee', 'box', 'tier'],
            metrics: ['performanceScore', 'potentialScore', 'employeeCount'],
        },
    };

    // How many options each filter list actually holds, so "everything ticked"
    // is judged against the REAL catalogue. There is no hard-coded fallback
    // catalogue any more: inventing site/department names when the reference
    // endpoint fails produced filters that match nothing, i.e. a silently empty
    // report built on names this deployment never had.
    const FILTER_COUNTS = { sites: 0, departments: 0, domains: 0, roles: 0 };

    // ── State ──
    let state = {
        title: 'Untitled Report',
        sections: [],
        globalFilters: {
            sites: [],
            departments: [],
            domains: [],
            roles: [],
            criticalOnly: false,
            gapsOnly: false,
            activeOnly: true,
        },
        charts: {},
        editingSectionId: null,
    };

    // ── SQL Generator ──
    function generateSQL(section) {
        const c = section.config;
        if (!c.source || !c.dimension || !c.metric)
            return '-- Configure source, dimension, and metric';
        const aggFn = (c.aggregation || 'avg').toUpperCase();
        const dim2 = c.dimension2 ? ',\n  ' + c.dimension2 : '';
        const grp2 = c.dimension2 ? ', ' + c.dimension2 : '';
        const order = c.sortOrder === 'alpha' ? c.dimension : 'value ' + (c.sortOrder || 'DESC');
        return (
            '-- Section: ' +
            section.title +
            '\nSELECT\n  ' +
            c.dimension +
            dim2 +
            ',\n  ' +
            aggFn +
            '(' +
            c.metric +
            ') AS value\nFROM ' +
            c.source +
            '\nWHERE 1=1\nGROUP BY ' +
            c.dimension +
            grp2 +
            '\nORDER BY ' +
            order +
            '\nLIMIT ' +
            (c.limit || 20) +
            ';'
        );
    }

    // ── Section CRUD ──
    function addSection(config, title, width) {
        const id = 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        // width lands in a class="..." attribute: an imported template file is
        // not trusted, so only the two known values survive.
        const section = {
            id,
            title: title || 'Section ' + (state.sections.length + 1),
            order: state.sections.length,
            width: width === 'half' ? 'half' : 'full',
            config: { ...config },
        };
        state.sections.push(section);
        renderAllSections();
        updateSQLPreview();
        updateSectionsList();
        return id;
    }

    function removeSection(id) {
        state.sections = state.sections.filter((s) => s.id !== id);
        if (state.charts[id]) {
            state.charts[id].destroy();
            delete state.charts[id];
        }
        renderAllSections();
        updateSQLPreview();
        updateSectionsList();
    }

    function duplicateSection(id) {
        const orig = state.sections.find((s) => s.id === id);
        if (!orig) return;
        addSection({ ...orig.config }, orig.title + ' (copy)', orig.width);
    }

    function moveSection(id, dir) {
        const idx = state.sections.findIndex((s) => s.id === id);
        const newIdx = idx + dir;
        if (newIdx < 0 || newIdx >= state.sections.length) return;
        [state.sections[idx], state.sections[newIdx]] = [
            state.sections[newIdx],
            state.sections[idx],
        ];
        renderAllSections();
        updateSectionsList();
    }

    function toggleWidth(id) {
        const sec = state.sections.find((s) => s.id === id);
        if (sec) {
            sec.width = sec.width === 'full' ? 'half' : 'full';
            renderAllSections();
            updateSectionsList();
        }
    }

    function editSection(id) {
        const sec = state.sections.find((s) => s.id === id);
        if (!sec) return;
        state.editingSectionId = id;
        const c = sec.config;
        _val('cfgSource', c.source);
        onSourceChange();
        _val('cfgDimension', c.dimension);
        _val('cfgDimension2', c.dimension2 || '');
        _val('cfgMetric', c.metric);
        _val('cfgAggregation', c.aggregation || 'avg');
        _val('cfgChartType', c.chartType || 'bar');
        _val('cfgColorScheme', c.colorScheme || 'multi');
        _val('cfgCFPreset', c.cfPreset || '');
        _val('cfgSortOrder', c.sortOrder || 'desc');
        _val('cfgLimit', c.limit || 20);
        _val('cfgSectionTitle', sec.title);
        _val('cfgWidth', sec.width);
        switchSidebarTab('config');
        const btn = document.getElementById('cfgAddSection');
        btn.innerHTML =
            '<span class="icon">✓</span> ' + _esc(T('update_section', 'Update Section'));
    }

    // ── Render All Sections ──
    function renderAllSections() {
        const container = document.getElementById('rbSections');
        const empty = document.getElementById('rbEmptyState');
        // Destroy all charts
        Object.keys(state.charts).forEach((k) => {
            if (state.charts[k]) state.charts[k].destroy();
        });
        state.charts = {};

        if (!state.sections.length) {
            container.innerHTML = '';
            if (empty) {
                container.appendChild(empty);
                empty.style.display = '';
            }
            return;
        }
        if (empty) empty.style.display = 'none';

        container.innerHTML = state.sections
            .map((sec, i) => {
                const delay = (i * 0.08).toFixed(2);
                // Section id rides in a JSON data-args attribute (csp-actions.js),
                // never inside a JS string in an inline handler.
                const sid = _esc(sec.id);
                return (
                    '<div class="rb-section ' +
                    _esc(sec.width) +
                    '" id="' +
                    sid +
                    '" style="animation-delay:' +
                    delay +
                    's">' +
                    '<div class="rb-section-header"><h4>' +
                    _esc(sec.title) +
                    '</h4>' +
                    '<div class="rb-section-actions">' +
                    '<button title="Edit" data-sec-id="' +
                    sid +
                    '"' +
                    _onClick('editSection', [String(sec.id)]) +
                    '>✏️</button>' +
                    '<button title="Duplicate" data-sec-id="' +
                    sid +
                    '"' +
                    _onClick('duplicateSection', [String(sec.id)]) +
                    '>📋</button>' +
                    '<button title="Toggle width" data-sec-id="' +
                    sid +
                    '"' +
                    _onClick('toggleWidth', [String(sec.id)]) +
                    '>↔️</button>' +
                    '<button title="Move up" data-sec-id="' +
                    sid +
                    '"' +
                    _onClick('moveSection', [String(sec.id), -1]) +
                    '>▲</button>' +
                    '<button title="Move down" data-sec-id="' +
                    sid +
                    '"' +
                    _onClick('moveSection', [String(sec.id), 1]) +
                    '>▼</button>' +
                    '<button title="Remove" data-sec-id="' +
                    sid +
                    '"' +
                    _onClick('removeSection', [String(sec.id)]) +
                    '>🗑️</button>' +
                    '</div></div><div class="rb-section-body" id="body_' +
                    sid +
                    '"></div></div>'
                );
            })
            .join('');

        // Render each section with REAL data (mock is only a fallback).
        const token = ++_renderToken;
        state.sections.forEach((sec) => renderSectionBody(sec, token));
    }

    // ── Real data fetch (replaces mock) ──
    let _renderToken = 0;

    function _csrfHeaders() {
        const m = document.querySelector('meta[name="csrf-token"]');
        return m && m.content ? { 'CSRF-Token': m.content } : {};
    }

    async function fetchSectionData(config) {
        const payload = Object.assign({}, config, { filters: state.globalFilters });
        const res = await fetch('/reports/data', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, _csrfHeaders()),
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (!json.success || !json.data || json.data.error)
            throw new Error((json.data && json.data.error) || json.error || 'no data');
        return json.data;
    }

    async function renderSectionBody(sec, token) {
        const body = document.getElementById('body_' + sec.id);
        if (!body) return;
        body.innerHTML =
            '<div class="rb-loading" style="padding:32px;text-align:center;opacity:.55">' +
            _esc(T('loading', 'Loading data…')) +
            '</div>';
        let data;
        try {
            data = await fetchSectionData(sec.config);
        } catch (e) {
            // NEVER fabricate sample data in an HR decision tool — a stray amber note is
            // too easy to miss and a manager could read/print fake figures as real. Show
            // an explicit error state instead so the section is unmistakably empty.
            if (token !== _renderToken) return;
            const bodyErr = document.getElementById('body_' + sec.id);
            if (bodyErr)
                bodyErr.innerHTML =
                    '<div class="rb-error" style="padding:24px;color:#d97706">' +
                    _esc(
                        T(
                            'load_error',
                            'Couldn’t load data for this section. Check the dimension/metric configuration or try again.'
                        )
                    ) +
                    '</div>';
            return;
        }
        // A newer render started — discard this stale result.
        if (token !== _renderToken) return;
        const body2 = document.getElementById('body_' + sec.id);
        if (!body2) return;

        // Provenance (migration 71): when NOTHING in this section was ever
        // assessed the server sends `unmeasured` rather than a number. Say so —
        // drawing a 0 % gauge would present an unmeasured population as a
        // measured failure.
        if (data && data.unmeasured) {
            body2.innerHTML =
                '<div class="rb-note" style="padding:24px;text-align:center;opacity:.75">' +
                _esc(T('never_assessed', 'Never assessed')) +
                '</div>';
            return;
        }

        const renderFn = RBRenderers['render_' + sec.config.chartType];
        if (renderFn) {
            const chart = renderFn(body2, data, sec.config);
            if (chart) state.charts[sec.id] = chart;
            // Groups with no assessed data at all were left out rather than
            // drawn as zeros — footnote the fact instead of hiding it.
            if (data.unmeasuredGroups > 0) {
                const note = document.createElement('div');
                note.className = 'rb-note';
                note.style.cssText = 'padding:8px 4px 0;font-size:11px;opacity:.7';
                note.textContent =
                    T('unmeasured_groups', 'Not shown (never assessed):') +
                    ' ' +
                    data.unmeasuredGroups;
                body2.appendChild(note);
            }
        } else {
            body2.innerHTML =
                '<div class="rb-error">' +
                _esc(T('unknown_chart', 'Unknown chart type:') + ' ' + sec.config.chartType) +
                '</div>';
        }
    }

    // ── SQL Preview ──
    function updateSQLPreview() {
        const el = document.getElementById('rbSQLContent');
        if (!state.sections.length) {
            el.textContent = T('sql_empty', '-- Add sections to see generated SQL');
            return;
        }
        const sql = state.sections.map((s) => generateSQL(s)).join('\n\n');
        el.innerHTML = _highlightSQL(sql);
    }

    // The generated SQL carries free text (the section title in the "-- Section:"
    // comment, dimension/metric names from an imported template file). It is
    // HTML-escaped FIRST and only then decorated: highlighting raw text straight
    // into innerHTML let a title such as an <img> with an error handler run as script.
    // Only & < > are escaped (text context): the quote-matching and number rules
    // below must still see ' and must not meet a numeric entity like &#39;.
    function _highlightSQL(sql) {
        return String(sql == null ? '' : sql)
            .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
            .replace(/--[^\n]*/g, '<span class="cmt">$&</span>')
            .replace(
                /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|LIMIT|AS|AND|OR|BETWEEN|CASE|WHEN|THEN|ELSE|END|COUNT|AVG|SUM|MIN|MAX|COUNT_DISTINCT|DESC|ASC|HAVING|JOIN|ON|LEFT|RIGHT|INNER|OUTER|DISTINCT|IN|NOT|NULL|IS)\b/gi,
                '<span class="kw">$&</span>'
            )
            .replace(/\b(\d+(\.\d+)?)\b/g, '<span class="num">$1</span>')
            .replace(/'[^']*'/g, '<span class="str">$&</span>');
    }

    // ── Sections List (sidebar) ──
    function updateSectionsList() {
        const el = document.getElementById('sectionsList');
        if (!state.sections.length) {
            el.innerHTML =
                '<div class="rb-empty" style="padding:20px"><p>' +
                _esc(T('no_sections', 'No sections added yet')) +
                '</p></div>';
            return;
        }
        const icons = {
            bar: '📊',
            stackedBar: '📊',
            horizontalBar: '📊',
            line: '📈',
            area: '📈',
            radar: '🕸️',
            doughnut: '🍩',
            gauge: '⏲️',
            scatter: '⚡',
            heatmap: '🔥',
            table: '📋',
            kpi: '🎯',
            progress: '📏',
        };
        el.innerHTML = state.sections
            .map(
                (s) =>
                    '<div class="rb-section-list-item" data-sec-id="' +
                    _esc(s.id) +
                    '"' +
                    _onClick('editSection', [String(s.id)]) +
                    '>' +
                    '<span class="rb-sec-icon">' +
                    (icons[s.config.chartType] || '📊') +
                    '</span>' +
                    '<div class="rb-sec-info"><div class="rb-sec-name">' +
                    _esc(s.title) +
                    '</div>' +
                    '<div class="rb-sec-type">' +
                    _esc(s.config.chartType) +
                    ' · ' +
                    _esc(_sourceLabel(s.config.source)) +
                    '</div></div></div>'
            )
            .join('');
    }

    function _sourceLabel(key) {
        const m = SOURCE_META[key];
        return m ? T(m.labelKey, m.label) : key || '?';
    }

    // ── Source Change Handler ──
    function onSourceChange() {
        const src = _val('cfgSource');
        const meta = SOURCE_META[src];
        const dimSel = document.getElementById('cfgDimension');
        const dim2Sel = document.getElementById('cfgDimension2');
        const metSel = document.getElementById('cfgMetric');
        dimSel.innerHTML = '<option value="">' + _esc(T('select', '— Select —')) + '</option>';
        dim2Sel.innerHTML = '<option value="">' + _esc(T('none_paren', '(none)')) + '</option>';
        metSel.innerHTML = '<option value="">' + _esc(T('select', '— Select —')) + '</option>';
        if (!meta) return;
        meta.dims.forEach((d) => {
            dimSel.innerHTML += '<option value="' + _esc(d) + '">' + _esc(d) + '</option>';
            dim2Sel.innerHTML += '<option value="' + _esc(d) + '">' + _esc(d) + '</option>';
        });
        meta.metrics.forEach(
            (m) => (metSel.innerHTML += '<option value="' + _esc(m) + '">' + _esc(m) + '</option>')
        );
    }

    // ── Filter Engine ──
    async function populateFilters() {
        const load = async (src, container) => {
            let names = [];
            try {
                const r = await fetch('/reports/reference/' + src);
                const j = await r.json();
                names = (j.data || []).map((x) => x.name).filter(Boolean);
            } catch (e) {
                names = [];
            }
            FILTER_COUNTS[src] = names.length;
            _populateChecks(container, names);
        };
        await Promise.all([
            load('sites', 'filterSites'),
            load('departments', 'filterDepts'),
            load('domains', 'filterDomains'),
            load('roles', 'filterRoles'),
        ]);
    }

    function _populateChecks(containerId, items) {
        const el = document.getElementById(containerId);
        if (!el) return;
        if (!items.length) {
            // Say the list is unavailable rather than offering invented values.
            el.innerHTML =
                '<div class="rb-empty" style="padding:12px;font-size:12px;opacity:.7">' +
                _esc(T('load_error', 'Couldn’t load data for this section.')) +
                '</div>';
            return;
        }
        el.innerHTML = items
            .map(
                (item) =>
                    '<label class="rb-checkbox-item"><input type="checkbox" value="' +
                    _esc(item) +
                    '" checked><span>' +
                    _esc(item) +
                    '</span></label>'
            )
            .join('');
    }

    function getFilters() {
        return {
            sites: _getChecked('filterSites'),
            departments: _getChecked('filterDepts'),
            domains: _getChecked('filterDomains'),
            roles: _getChecked('filterRoles'),
            criticalOnly: document.getElementById('filterCritical').checked,
            gapsOnly: document.getElementById('filterGaps').checked,
            // Always true, and the server does not read it: every report source is
            // built on v_employee_details, which filters is_active in the view. Kept
            // in the payload only so a saved report's shape stays stable.
            activeOnly: true,
        };
    }

    function _getChecked(containerId) {
        return [...document.querySelectorAll('#' + containerId + ' input:checked')].map(
            (el) => el.value
        );
    }

    function applyFilters() {
        state.globalFilters = getFilters();
        renderFilterTags();
        renderAllSections();
    }

    function renderFilterTags() {
        const el = document.getElementById('rbFilterTags');
        const f = state.globalFilters;
        let tags = '';
        if (f.sites.length < FILTER_COUNTS.sites)
            tags += f.sites
                .map(
                    (s) =>
                        '<span class="rb-filter-tag">' +
                        _esc(s) +
                        ' <span class="remove" data-filter-type="sites" data-filter-value="' +
                        _esc(s) +
                        '"' +
                        _onClick('removeFilterTagEl', ['$el']) +
                        '>×</span></span>'
                )
                .join('');
        if (f.criticalOnly)
            tags +=
                '<span class="rb-filter-tag">Critical Only <span class="remove"' +
                _onClick('clearFlagFilter', ['filterCritical']) +
                '>×</span></span>';
        if (f.gapsOnly)
            tags +=
                '<span class="rb-filter-tag">Gaps Only <span class="remove"' +
                _onClick('clearFlagFilter', ['filterGaps']) +
                '>×</span></span>';
        el.innerHTML = tags;
    }

    // The value travels on data- attributes, never inside a JS string in an
    // onclick: _esc turns ' into &#39;, which the HTML parser decodes back
    // before the handler is compiled, so a site named  x');alert(1);//  ran.
    function removeFilterTagEl(el) {
        if (!el || !el.dataset) return;
        removeFilterTag(el.dataset.filterType, el.dataset.filterValue);
    }

    // "×" on the Critical-only / Gaps-only tags: untick the checkbox, re-filter.
    function clearFlagFilter(checkboxId) {
        const cb = document.getElementById(checkboxId);
        if (cb) cb.checked = false;
        applyFilters();
    }

    function removeFilterTag(type, value) {
        const checks = document.querySelectorAll(
            '#filter' +
                (type === 'sites'
                    ? 'Sites'
                    : type === 'departments'
                      ? 'Depts'
                      : type === 'domains'
                        ? 'Domains'
                        : 'Roles') +
                ' input'
        );
        checks.forEach((cb) => {
            if (cb.value === value) cb.checked = false;
        });
        applyFilters();
    }

    function checkAll(containerId) {
        document
            .querySelectorAll('#' + containerId + ' input')
            .forEach((cb) => (cb.checked = true));
    }
    function checkNone(containerId) {
        document
            .querySelectorAll('#' + containerId + ' input')
            .forEach((cb) => (cb.checked = false));
    }

    // ── Template System ──
    function getReportState() {
        return {
            title: state.title,
            sections: state.sections.map((s) => ({
                title: s.title,
                width: s.width,
                config: { ...s.config },
            })),
            globalFilters: { ...state.globalFilters },
        };
    }

    function loadReportState(data) {
        state.sections = [];
        Object.keys(state.charts).forEach((k) => {
            if (state.charts[k]) state.charts[k].destroy();
        });
        state.charts = {};
        state.title = data.title || 'Untitled Report';
        document.getElementById('rbReportTitle').value = state.title;
        document.getElementById('rbReportTitleDisplay').textContent = state.title;
        (data.sections || []).forEach((s) => addSection(s.config, s.title, s.width));
    }

    function saveTemplate() {
        const name = prompt(T('tpl_name_prompt', 'Template name:'), state.title);
        if (!name) return;
        const data = getReportState();
        data.name = name;
        // Save to backend
        fetch('/reports/templates', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, _csrfHeaders()),
            body: JSON.stringify({
                name,
                reportType: 'composite',
                dataSource: 'multi',
                selectedFields: JSON.stringify({ sections: data.sections }),
                filters: JSON.stringify(data.globalFilters),
            }),
        })
            .then((r) => r.json())
            .then(() => alert(T('tpl_saved', 'Template saved.')))
            .catch(() => {
                // Fallback: save to localStorage
                const saved = JSON.parse(localStorage.getItem('rb_templates') || '[]');
                saved.push({ id: Date.now(), name, data, createdAt: new Date().toISOString() });
                localStorage.setItem('rb_templates', JSON.stringify(saved));
                alert(T('tpl_saved_local', 'Template saved locally.'));
            });
        loadSavedTemplates();
    }

    function loadSavedTemplates() {
        const el = document.getElementById('savedTemplates');
        const saved = JSON.parse(localStorage.getItem('rb_templates') || '[]');
        if (!saved.length) {
            el.innerHTML =
                '<div class="rb-empty" style="padding:20px"><p>' +
                _esc(T('no_saved', 'No saved templates')) +
                '</p></div>';
            return;
        }
        el.innerHTML = saved
            .map(
                (t) =>
                    '<div class="rb-template-card"' +
                    _onClick('loadLocalTemplate', [t.id]) +
                    '><h5>' +
                    _esc(t.name) +
                    '</h5><div class="rb-tpl-meta">' +
                    _esc(new Date(t.createdAt).toLocaleDateString(_locale())) +
                    '</div></div>'
            )
            .join('');
    }

    function loadLocalTemplate(id) {
        const saved = JSON.parse(localStorage.getItem('rb_templates') || '[]');
        const tpl = saved.find((t) => t.id === id);
        if (tpl && tpl.data) loadReportState(tpl.data);
    }

    function exportReport() {
        const data = getReportState();
        data.sql = state.sections.map((s) => generateSQL(s)).join('\n\n');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (state.title || 'report') + '.json';
        a.click();
    }

    function importReport() {
        document.getElementById('rbImportFile').click();
    }

    function handleImport(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (ev) {
            try {
                const data = JSON.parse(ev.target.result);
                loadReportState(data);
            } catch (err) {
                alert(T('invalid_file', 'Invalid file format.'));
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    }

    // ── 10 Prebuilt Templates ──
    const PREBUILT = [
        {
            name: TP('rbp_workforce_readiness_dashboard', 'Workforce Readiness Dashboard'),
            desc: TP(
                'rbp_kpi_strip_bar_by_site_progress_by_dept',
                'KPI strip + Bar by site + Progress by dept'
            ),
            sections: [
                {
                    title: TP('rbp_key_metrics', 'Key Metrics'),
                    width: 'full',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'site',
                        metric: 'readinessPct',
                        aggregation: 'avg',
                        chartType: 'kpi',
                        colorScheme: 'multi',
                        cfPreset: 'readiness',
                        sortOrder: 'desc',
                        limit: 20,
                    },
                },
                {
                    title: TP('rbp_readiness_by_site', 'Readiness by Site'),
                    width: 'half',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'site',
                        metric: 'readinessPct',
                        aggregation: 'avg',
                        chartType: 'bar',
                        colorScheme: 'gold',
                        cfPreset: 'readiness',
                        sortOrder: 'desc',
                        limit: 10,
                    },
                },
                {
                    title: TP('rbp_coverage_by_department', 'Coverage by Department'),
                    width: 'half',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'department',
                        metric: 'readinessPct',
                        aggregation: 'avg',
                        chartType: 'progress',
                        colorScheme: 'emerald',
                        cfPreset: 'readiness',
                        sortOrder: 'desc',
                        limit: 10,
                    },
                },
            ],
        },
        {
            name: TP('rbp_critical_skill_gap_analysis', 'Critical Skill Gap Analysis'),
            desc: TP(
                'rbp_kpi_strip_gap_table_h_bar_by_domain',
                'KPI strip + Gap table + H-Bar by domain'
            ),
            sections: [
                {
                    title: TP('rbp_gap_overview', 'Gap Overview'),
                    width: 'full',
                    config: {
                        source: 'v_employee_skill_gaps',
                        dimension: 'domain',
                        metric: 'gap',
                        aggregation: 'count',
                        chartType: 'kpi',
                        colorScheme: 'multi',
                        cfPreset: 'gap',
                        sortOrder: 'desc',
                        limit: 20,
                    },
                },
                {
                    title: TP('rbp_top_gaps_by_domain', 'Top Gaps by Domain'),
                    width: 'half',
                    config: {
                        source: 'v_employee_skill_gaps',
                        dimension: 'domain',
                        metric: 'gap',
                        aggregation: 'avg',
                        chartType: 'horizontalBar',
                        colorScheme: 'heatscale',
                        cfPreset: 'gap',
                        sortOrder: 'desc',
                        limit: 10,
                    },
                },
                {
                    title: TP('rbp_gap_details', 'Gap Details'),
                    width: 'half',
                    config: {
                        source: 'v_employee_skill_gaps',
                        dimension: 'employee',
                        metric: 'gap',
                        aggregation: 'sum',
                        chartType: 'table',
                        colorScheme: 'multi',
                        cfPreset: 'gap',
                        sortOrder: 'desc',
                        limit: 15,
                    },
                },
            ],
        },
        {
            name: TP('rbp_site_x_domain_capability', 'Site × Domain Capability'),
            desc: TP('rbp_heatmap_radar_comparisons', 'Heatmap + Radar comparisons'),
            sections: [
                {
                    title: TP('rbp_capability_heatmap', 'Capability Heatmap'),
                    width: 'full',
                    config: {
                        source: 'v_domain_capability',
                        dimension: 'site',
                        dimension2: 'domain',
                        metric: 'avgLevel',
                        aggregation: 'avg',
                        chartType: 'heatmap',
                        colorScheme: 'heatscale',
                        cfPreset: 'level',
                        sortOrder: 'none',
                        limit: 20,
                    },
                },
                {
                    title: TP('rbp_site_radar', 'Site Radar'),
                    width: 'half',
                    config: {
                        source: 'v_domain_capability',
                        dimension: 'domain',
                        dimension2: 'site',
                        metric: 'avgLevel',
                        aggregation: 'avg',
                        chartType: 'radar',
                        colorScheme: 'multi',
                        cfPreset: '',
                        sortOrder: 'none',
                        limit: 8,
                    },
                },
                {
                    title: TP('rbp_department_radar', 'Department Radar'),
                    width: 'half',
                    config: {
                        source: 'v_domain_capability',
                        dimension: 'domain',
                        dimension2: 'department',
                        metric: 'avgLevel',
                        aggregation: 'avg',
                        chartType: 'radar',
                        colorScheme: 'cool',
                        cfPreset: '',
                        sortOrder: 'none',
                        limit: 8,
                    },
                },
            ],
        },
        {
            name: TP('rbp_bench_strength_report', 'Bench Strength Report'),
            desc: TP('rbp_gauges_stacked_bar_scatter', 'Gauges + Stacked bar + Scatter'),
            sections: [
                {
                    title: TP('rbp_overall_readiness', 'Overall Readiness'),
                    width: 'half',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'role',
                        metric: 'readinessPct',
                        aggregation: 'avg',
                        chartType: 'gauge',
                        colorScheme: 'gold',
                        cfPreset: 'readiness',
                        sortOrder: 'desc',
                        limit: 1,
                    },
                },
                {
                    title: TP('rbp_qualification_status_by_role', 'Qualification Status by Role'),
                    width: 'half',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'role',
                        dimension2: 'department',
                        metric: 'readinessPct',
                        aggregation: 'count',
                        chartType: 'stackedBar',
                        colorScheme: 'multi',
                        cfPreset: '',
                        sortOrder: 'desc',
                        limit: 8,
                    },
                },
                {
                    title: TP('rbp_9_box_talent_grid', '9-Box Talent Grid'),
                    width: 'full',
                    config: {
                        source: 'nineBoxAssessments',
                        dimension: 'employee',
                        metric: 'performanceScore',
                        aggregation: 'avg',
                        chartType: 'scatter',
                        colorScheme: 'multi',
                        cfPreset: '',
                        sortOrder: 'none',
                        limit: 15,
                    },
                },
            ],
        },
        {
            name: TP('rbp_assessment_coverage', 'Assessment Coverage'),
            desc: TP('rbp_kpi_progress_line_trend', 'KPI + Progress + Line trend'),
            sections: [
                {
                    title: TP('rbp_coverage_kpis', 'Coverage KPIs'),
                    width: 'full',
                    config: {
                        source: 'v_resolved_assessments',
                        dimension: 'domain',
                        metric: 'assessmentCount',
                        aggregation: 'count',
                        chartType: 'kpi',
                        colorScheme: 'multi',
                        cfPreset: 'coverage',
                        sortOrder: 'desc',
                        limit: 20,
                    },
                },
                {
                    title: TP('rbp_coverage_by_site', 'Coverage by Site'),
                    width: 'half',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'site',
                        metric: 'readinessPct',
                        aggregation: 'avg',
                        chartType: 'progress',
                        colorScheme: 'emerald',
                        cfPreset: 'coverage',
                        sortOrder: 'desc',
                        limit: 8,
                    },
                },
                {
                    title: TP('rbp_assessment_trend', 'Assessment Trend'),
                    width: 'half',
                    config: {
                        source: 'v_resolved_assessments',
                        dimension: 'domain',
                        dimension2: 'site',
                        metric: 'assessmentCount',
                        aggregation: 'count',
                        chartType: 'line',
                        colorScheme: 'cool',
                        cfPreset: '',
                        sortOrder: 'none',
                        limit: 12,
                    },
                },
            ],
        },
        {
            name: TP('rbp_department_comparison', 'Department Comparison'),
            desc: TP('rbp_stacked_bar_radar_overlay', 'Stacked bar + Radar overlay'),
            sections: [
                {
                    title: TP('rbp_department_x_domain', 'Department × Domain'),
                    width: 'full',
                    config: {
                        source: 'v_domain_capability',
                        dimension: 'department',
                        dimension2: 'domain',
                        metric: 'avgLevel',
                        aggregation: 'avg',
                        chartType: 'stackedBar',
                        colorScheme: 'multi',
                        cfPreset: '',
                        sortOrder: 'desc',
                        limit: 10,
                    },
                },
                {
                    title: TP('rbp_department_radar_overlay', 'Department Radar Overlay'),
                    width: 'full',
                    config: {
                        source: 'v_domain_capability',
                        dimension: 'domain',
                        dimension2: 'department',
                        metric: 'avgLevel',
                        aggregation: 'avg',
                        chartType: 'radar',
                        colorScheme: 'multi',
                        cfPreset: '',
                        sortOrder: 'none',
                        limit: 8,
                    },
                },
            ],
        },
        {
            name: TP('rbp_training_needs_priority', 'Training Needs Priority'),
            desc: TP('rbp_h_bar_table_with_cf', 'H-Bar + Table with CF'),
            sections: [
                {
                    title: TP('rbp_gaps_by_skill', 'Gaps by Skill'),
                    width: 'full',
                    config: {
                        source: 'v_employee_skill_gaps',
                        dimension: 'skill',
                        metric: 'gap',
                        aggregation: 'avg',
                        chartType: 'horizontalBar',
                        colorScheme: 'heatscale',
                        cfPreset: 'gap',
                        sortOrder: 'desc',
                        limit: 15,
                    },
                },
                {
                    title: TP('rbp_priority_list', 'Priority List'),
                    width: 'full',
                    config: {
                        source: 'v_employee_skill_gaps',
                        dimension: 'employee',
                        metric: 'gap',
                        aggregation: 'sum',
                        chartType: 'table',
                        colorScheme: 'multi',
                        cfPreset: 'gap',
                        sortOrder: 'desc',
                        limit: 20,
                    },
                },
            ],
        },
        {
            name: TP('rbp_skills_distribution', 'Skills Distribution'),
            desc: TP('rbp_doughnut_area_progress', 'Doughnut + Area + Progress'),
            sections: [
                {
                    title: TP('rbp_skills_by_domain', 'Skills by Domain'),
                    width: 'half',
                    config: {
                        source: 'v_domain_capability',
                        dimension: 'domain',
                        metric: 'avgLevel',
                        aggregation: 'avg',
                        chartType: 'doughnut',
                        colorScheme: 'multi',
                        cfPreset: '',
                        sortOrder: 'desc',
                        limit: 10,
                    },
                },
                {
                    title: TP('rbp_level_trend', 'Level Trend'),
                    width: 'half',
                    config: {
                        source: 'v_domain_capability',
                        dimension: 'domain',
                        dimension2: 'site',
                        metric: 'avgLevel',
                        aggregation: 'avg',
                        chartType: 'area',
                        colorScheme: 'cool',
                        cfPreset: '',
                        sortOrder: 'none',
                        limit: 12,
                    },
                },
                {
                    title: TP('rbp_domain_coverage', 'Domain Coverage'),
                    width: 'full',
                    config: {
                        source: 'v_domain_capability',
                        dimension: 'domain',
                        metric: 'avgLevel',
                        aggregation: 'avg',
                        chartType: 'progress',
                        colorScheme: 'emerald',
                        cfPreset: 'level',
                        sortOrder: 'desc',
                        limit: 10,
                    },
                },
            ],
        },
        {
            name: TP('rbp_executive_summary', 'Executive Summary'),
            desc: TP('rbp_kpi_gauge_bar_heatmap', 'KPI + Gauge + Bar + Heatmap'),
            sections: [
                {
                    title: TP('rbp_key_metrics', 'Key Metrics'),
                    width: 'full',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'site',
                        metric: 'readinessPct',
                        aggregation: 'avg',
                        chartType: 'kpi',
                        colorScheme: 'multi',
                        cfPreset: 'readiness',
                        sortOrder: 'desc',
                        limit: 20,
                    },
                },
                {
                    title: TP('rbp_overall_readiness', 'Overall Readiness'),
                    width: 'half',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'site',
                        metric: 'readinessPct',
                        aggregation: 'avg',
                        chartType: 'gauge',
                        colorScheme: 'gold',
                        cfPreset: 'readiness',
                        sortOrder: 'desc',
                        limit: 1,
                    },
                },
                {
                    title: TP('rbp_readiness_by_site', 'Readiness by Site'),
                    width: 'half',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'site',
                        metric: 'readinessPct',
                        aggregation: 'avg',
                        chartType: 'bar',
                        colorScheme: 'gold',
                        cfPreset: 'readiness',
                        sortOrder: 'desc',
                        limit: 10,
                    },
                },
                {
                    title: TP('rbp_site_x_domain', 'Site × Domain'),
                    width: 'full',
                    config: {
                        source: 'v_domain_capability',
                        dimension: 'site',
                        dimension2: 'domain',
                        metric: 'avgLevel',
                        aggregation: 'avg',
                        chartType: 'heatmap',
                        colorScheme: 'heatscale',
                        cfPreset: 'level',
                        sortOrder: 'none',
                        limit: 20,
                    },
                },
            ],
        },
        {
            name: TP('rbp_9_box_talent_grid', '9-Box Talent Grid'),
            desc: TP('rbp_scatter_kpi_by_role', 'Scatter + KPI by role'),
            sections: [
                {
                    title: TP('rbp_talent_grid', 'Talent Grid'),
                    width: 'full',
                    config: {
                        source: 'nineBoxAssessments',
                        dimension: 'employee',
                        metric: 'performanceScore',
                        aggregation: 'avg',
                        chartType: 'scatter',
                        colorScheme: 'multi',
                        cfPreset: '',
                        sortOrder: 'none',
                        limit: 20,
                    },
                },
                {
                    title: TP('rbp_role_kpis', 'Role KPIs'),
                    width: 'full',
                    config: {
                        source: 'v_employee_readiness',
                        dimension: 'role',
                        metric: 'readinessPct',
                        aggregation: 'avg',
                        chartType: 'kpi',
                        colorScheme: 'multi',
                        cfPreset: 'readiness',
                        sortOrder: 'desc',
                        limit: 10,
                    },
                },
            ],
        },
    ];

    function renderPrebuiltTemplates() {
        const el = document.getElementById('prebuiltTemplates');
        el.innerHTML = PREBUILT.map(
            (t, i) =>
                '<div class="rb-template-card"' +
                _onClick('loadPrebuilt', [i]) +
                '><h5>' +
                _esc(t.name) +
                '</h5><div class="rb-tpl-desc">' +
                _esc(t.desc) +
                '</div><div class="rb-tpl-meta">' +
                t.sections.length +
                ' sections</div></div>'
        ).join('');
    }

    function loadPrebuilt(idx) {
        const tpl = PREBUILT[idx];
        if (!tpl) return;
        loadReportState({ title: tpl.name, sections: tpl.sections });
    }

    // ── UI Wiring ──
    function switchSidebarTab(tab) {
        document
            .querySelectorAll('.rb-sidebar-tab')
            .forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
        document.querySelectorAll('.rb-sidebar-panel').forEach((p) => p.classList.remove('active'));
        const panelMap = {
            config: 'panelConfig',
            sections: 'panelSections',
            filters: 'panelFilters',
            templates: 'panelTemplates',
        };
        const panel = document.getElementById(panelMap[tab]);
        if (panel) panel.classList.add('active');
    }

    function switchRightTab(tab) {
        document
            .querySelectorAll('.rb-right-tab')
            .forEach((t) => t.classList.toggle('active', t.dataset.rtab === tab));
        document.querySelectorAll('.rb-right-panel').forEach((p) => p.classList.remove('active'));
        const panelMap = { sql: 'rpanelSql', data: 'rpanelData', rules: 'rpanelRules' };
        const panel = document.getElementById(panelMap[tab]);
        if (panel) panel.classList.add('active');
    }

    function _val(id, set) {
        const el = document.getElementById(id);
        if (!el) return '';
        if (set !== undefined) {
            el.value = set;
            return set;
        }
        return el.value;
    }

    function _esc(s) {
        return String(s == null ? '' : s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }

    // CSP — no inline on*= handlers: a click is declared as
    // data-on-click="RB.<fn>" + JSON data-args, dispatched by csp-actions.js.
    function _onClick(fn, args) {
        return (
            ' data-on-click="RB.' + fn + '" data-args="' + _esc(JSON.stringify(args || [])) + '"'
        );
    }

    // ── Init ──
    function init() {
        // Populate source dropdown
        const srcSel = document.getElementById('cfgSource');
        Object.keys(SOURCE_META).forEach((k) => {
            const m = SOURCE_META[k];
            srcSel.innerHTML +=
                '<option value="' + _esc(k) + '">' + _esc(T(m.labelKey, m.label)) + '</option>';
        });

        // Source change
        document.getElementById('cfgSource').addEventListener('change', onSourceChange);

        // Add/Update section button
        document.getElementById('cfgAddSection').addEventListener('click', function () {
            const config = {
                source: _val('cfgSource'),
                dimension: _val('cfgDimension'),
                dimension2: _val('cfgDimension2'),
                metric: _val('cfgMetric'),
                aggregation: _val('cfgAggregation'),
                chartType: _val('cfgChartType'),
                colorScheme: _val('cfgColorScheme'),
                cfPreset: _val('cfgCFPreset'),
                sortOrder: _val('cfgSortOrder'),
                limit: parseInt(_val('cfgLimit')) || 20,
            };
            if (state.editingSectionId) {
                const sec = state.sections.find((s) => s.id === state.editingSectionId);
                if (sec) {
                    sec.config = config;
                    sec.title = _val('cfgSectionTitle') || sec.title;
                    sec.width = _val('cfgWidth') || sec.width;
                }
                state.editingSectionId = null;
                this.innerHTML =
                    '<span class="icon">+</span> ' + _esc(T('add_section', 'Add Section'));
                renderAllSections();
                updateSQLPreview();
                updateSectionsList();
            } else {
                addSection(config, _val('cfgSectionTitle'), _val('cfgWidth'));
            }
        });

        // Sidebar tabs
        document
            .querySelectorAll('.rb-sidebar-tab')
            .forEach((tab) =>
                tab.addEventListener('click', () => switchSidebarTab(tab.dataset.tab))
            );

        // Right tabs
        document
            .querySelectorAll('.rb-right-tab')
            .forEach((tab) =>
                tab.addEventListener('click', () => switchRightTab(tab.dataset.rtab))
            );

        // Panel toggles
        document
            .getElementById('rbToggleSidebar')
            .addEventListener('click', () =>
                document.getElementById('rbSidebar').classList.toggle('collapsed')
            );
        document
            .getElementById('rbToggleRight')
            .addEventListener('click', () =>
                document.getElementById('rbRight').classList.toggle('collapsed')
            );

        // Title sync
        document.getElementById('rbReportTitle').addEventListener('input', function () {
            state.title = this.value;
            document.getElementById('rbReportTitleDisplay').textContent =
                this.value || 'Untitled Report';
        });

        // Header actions
        document.getElementById('rbPrintBtn').addEventListener('click', () => {
            document.getElementById('rbApp').classList.toggle('print-mode');
        });
        document.getElementById('rbExportBtn').addEventListener('click', exportReport);
        document.getElementById('rbImportBtn').addEventListener('click', importReport);
        document.getElementById('rbSaveBtn').addEventListener('click', saveTemplate);
        document.getElementById('rbImportFile').addEventListener('change', handleImport);

        // Copy SQL
        document.getElementById('rbCopySQL').addEventListener('click', () => {
            const sql = state.sections.map((s) => generateSQL(s)).join('\n\n');
            navigator.clipboard.writeText(sql).then(() => {
                const btn = document.getElementById('rbCopySQL');
                btn.textContent = T('copied', 'Copied.');
                setTimeout(() => (btn.textContent = T('copy', 'Copy')), 1500);
            });
        });

        // Apply filters
        document.getElementById('applyFiltersBtn').addEventListener('click', applyFilters);

        // Date
        document.getElementById('rbDate').textContent = new Date().toLocaleDateString(_locale(), {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });

        // Populate
        populateFilters();
        renderPrebuiltTemplates();
        loadSavedTemplates();
    }

    document.addEventListener('DOMContentLoaded', init);

    // Public API
    return {
        addSection,
        removeSection,
        duplicateSection,
        moveSection,
        toggleWidth,
        editSection,
        applyFilters,
        checkAll,
        checkNone,
        removeFilterTag,
        removeFilterTagEl,
        clearFlagFilter,
        loadPrebuilt,
        loadLocalTemplate,
        state,
    };
})();
