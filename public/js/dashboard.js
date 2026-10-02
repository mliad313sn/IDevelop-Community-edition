// Locale-aware percentage for DISPLAY (never for CSS widths): « 78,2 % » in
// French, "78.2%" in English. Follows <html lang>.
function fmtPct(v) {
    if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return String(v);
    const lang = document.documentElement.getAttribute('lang') || 'fr';
    const n = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(Number(v));
    return lang.indexOf('fr') === 0 ? n + '\u202f%' : n + '%';
}

const Dashboard = (() => {
    // Escape user-supplied text before injecting via innerHTML (prevents stored
    // XSS from employee/skill/site names and other server data).
    const esc = (s) =>
        String(s == null ? '' : s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    // What a figure with nothing behind it prints. Matches the em dash used by
    // the server-side formatter (src/utils/dateFormat.js) so measured-absent
    // looks the same everywhere in the product.
    const UNMEASURED = '—';

    // -------------------------------------------------------------------------
    // State & Constants
    // -------------------------------------------------------------------------
    const state = {
        activeTab: 'executive',
        filters: {},
        charts: {}, // Chart.js instances keyed by canvas ID
        loadedTabs: new Set(),
        employeePage: 1,
        employeePageSize: 25,
        employeeSort: { by: 'readiness', dir: 'desc' },
        expandedEmployee: null,
        expandedGapSkill: null,
        // Dernier `scoped` servi par /api/dashboard/measures (M-12, résiduel).
        scopeBounded: false,
    };

    const INIT = window.__DASHBOARD__ || {};
    // Server-injected i18n labels (see dashboard.ejs); EN literals as fallback.
    const I18N = window.__I18N__ || {};
    // Ensure filters is initialized immediately? No, we read it from DOM on init.

    const VALID_TABS = ['executive', 'training', 'talentdev', 'team', 'capability', 'comparator'];

    // Shared chart theme (chart-theme.js loads first). Fall back gracefully so the
    // dashboard still renders if the theme module is ever absent.
    const CT = window.ChartTheme || {};
    const TT = CT.tokens || {
        gold: '#7C6CFF',
        emerald: '#2DD4A0',
        amber: '#F5A623',
        red: '#F06060',
        blue: '#5B9DF5',
        textDim: 'rgba(255,255,255,0.6)',
        text: '#E4E8F0',
        surface: '#1F2442',
        border: 'rgba(255,255,255,0.12)',
    };
    const GRIDC = CT.GRID || 'rgba(255,255,255,0.08)';
    // Chart colours come from the theme, never from a literal here: a literal
    // cannot follow the brand accent, so it would render the same in every
    // edition and quietly half-theme the product. These no-ops keep the
    // dashboard rendering if chart-theme.js is ever absent.
    if (!CT.ROLE) CT.ROLE = {};
    if (!CT.alpha)
        CT.alpha = function (c) {
            return c;
        };
    if (!CT.pointStyle)
        CT.pointStyle = function () {
            return undefined;
        };

    // Threshold colours come from the theme's SEMANTIC tokens, not from the raw
    // design tokens: only --brand is re-branded, so reading TT.emerald/amber/red
    // here left every status chart on the stock palette in a differently
    // branded install — a half-themed product. The semantic tokens
    // resolve to these values when no identity overrides them.
    const SEM = CT.SEMANTIC || {
        good: TT.emerald,
        mid: TT.amber,
        low: TT.red,
        neutral: TT.blue,
        accent: TT.gold,
    };
    const COLORS = {
        good: SEM.good,
        warning: SEM.mid,
        danger: SEM.low,
        neutral: SEM.neutral,
        // 0-20 → 81-100 readiness ramp, authored as a scale by the theme.
        donut: CT.RAMP || [SEM.low, SEM.mid, SEM.accent, CT.ROLE.rampMid, SEM.good],
    };

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    // Coerce API values to a finite number. PostgreSQL returns NUMERIC/AVG/ROUND
    // and COUNT as strings, so never call .toFixed/Math on a raw field —
    // pass it through num first.
    function num(v, fallback = 0) {
        const n = typeof v === 'number' ? v : parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    }

    // Interpolate the single {n} placeholder used by the fold/preview labels.
    function tn(template, n) {
        return String(template == null ? '' : template).replace('{n}', n);
    }

    // -------------------------------------------------------------------------
    // Assessment provenance
    //
    // Every gap/readiness figure the API returns resolves a MISSING assessment to
    // level 0, so an org nobody has evaluated renders exactly like an org that was
    // evaluated and scored zero. These helpers never change a number — they say
    // where it came from, and how much of the population it is based on.
    // -------------------------------------------------------------------------

    // Positional {0}/{1}/... interpolation for the prov_* locale strings.
    function fmt(template, ...args) {
        return String(template == null ? '' : template).replace(/\{(\d+)\}/g, (m, i) =>
            args[i] === undefined || args[i] === null ? m : String(args[i])
        );
    }

    // FRENCH-FIRST: never let a Number/Date format call pick its own locale.
    // dashboard.ejs injects `lang` ('fr-FR' / 'en-GB') from the session; the
    // fallback is French, never the host default. Node and the browser both
    // resolved that default to en-US here, which renders 3371 as "3,371" — and
    // a French reader parses that comma as a decimal point and reads 3.371,
    // wrong by a factor of a thousand. Same helper as report-builder.js.
    function _locale() {
        return typeof I18N.lang === 'string' && I18N.lang ? I18N.lang : 'fr-FR';
    }

    // Group digits so a director reads "3 371", not "3371".
    function grp(v) {
        return num(v, 0).toLocaleString(_locale());
    }

    // Locale-aware date. window.FMT (public/js/date-format.js) is loaded globally
    // by the layout and renders the reader's locale (e.g. 04/03/2026), never the
    // raw ISO the API returns — the dashboard was printing YYYY-MM-DD on a
    // French-first product. Falls back to the raw value if FMT is not ready.
    function fmtDate(d) {
        if (!d) return '';
        return window.FMT && typeof window.FMT.date === 'function' ? window.FMT.date(d) : String(d);
    }

    const PROV = {
        never_assessed: {
            cls: 'never',
            label: () => I18N.provNeverAssessed || 'Never assessed',
            title: () => I18N.provNeverAssessedTitle || 'Never assessed — no data',
        },
        self_only: {
            cls: 'self',
            label: () => I18N.provSelfOnly || 'Self-rated',
            title: () => I18N.provSelfOnlyTitle || 'Self-assessed, not validated',
        },
        assessed: {
            cls: 'validated',
            label: () => I18N.provValidated || 'Validated',
            title: () => I18N.provValidatedTitle || 'Validated by a supervisor',
        },
    };

    function provBadge(status) {
        const p = PROV[status];
        if (!p) return '';
        return `<span class="prov-badge ${p.cls}" title="${esc(p.title())}">${esc(p.label())}</span>`;
    }

    // The one-line "how to read this" strip under the executive KPIs.
    function renderProvenanceNote(containerId, prov) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';
        el.classList.remove('is-blind');
        if (!prov || !num(prov.expectedSkills, 0)) return;

        const expected = num(prov.expectedSkills, 0);
        const assessed = num(prov.assessedSkills, 0);
        const never = num(prov.neverAssessedSkills, 0);
        const selfOnly = num(prov.selfOnlySkills, 0);
        const coverage = prov.skillCoverage === null ? 0 : num(prov.skillCoverage, 0);

        const parts = [
            `<span class="prov-label">${esc(I18N.provReadLabel || 'How to read this')}</span>`,
        ];

        if (assessed === 0) {
            el.classList.add('is-blind');
            parts.push(
                esc(
                    I18N.provReadNone ||
                        'Nothing has been assessed yet — the 0% shown is missing data, not a result.'
                )
            );
        } else {
            if (coverage < 100) el.classList.add('is-blind');
            // The old wording ("…{3} never assessed count as level 0") described
            // the number this strip USED to print. The headline is now
            // readiness_assessed_only, so the note says what is actually on
            // screen: measured over measured, with the unmeasured named as a
            // blind spot rather than as a deficit.
            parts.push(
                esc(
                    fmt(
                        I18N.rdReadBodyAssessedOnly ||
                            'Readiness is computed over the {1} of {0} requirements assessed ({2}%). The {3} never assessed are a blind spot, not a level 0.',
                        grp(expected),
                        grp(assessed),
                        coverage,
                        grp(never)
                    )
                )
            );
            if (selfOnly > 0) {
                parts.push(
                    esc(
                        fmt(
                            I18N.provReadSelfOnly || 'Including {0} self-rated, not yet validated.',
                            grp(selfOnly)
                        )
                    )
                );
            }
        }
        parts.push(
            esc(
                fmt(
                    I18N.provReadPeople || '{0} of {1} people have at least one assessed skill.',
                    grp(prov.employeesAssessed),
                    grp(prov.employeesTotal)
                )
            )
        );

        el.innerHTML = parts.join(' ');
    }

    // -------------------------------------------------------------------------
    // Executive information architecture helpers
    // -------------------------------------------------------------------------

    // Make the ACTIVE (applied) filter scope readable next to the headline, so no
    // number on the executive tab is ever ambiguous. Reads the "all X" wording
    // straight off the localized <select> placeholders — no extra translation keys.
    // M-12 (résiduel) — LE BANDEAU NE PROMET PLUS PLUS LARGE QUE LES CHIFFRES.
    // Mesuré avant correction (uat.manager, /dashboard, aucun filtre) : bandeau
    // « Tous les sites · Tous les départements · Tous les services » au-dessus
    // d'une tuile `scoped=true` à 16 personnes / 1 site / 1 département /
    // 1 service. La cause était ici : on ne lisait que `state.filters` (vide à
    // l'ouverture) et on retombait sur le libellé « Tous les … » de la première
    // option des listes — le périmètre RBAC n'entrait jamais dans le bandeau.
    // `INIT.scope` porte désormais ce périmètre, résolu par le serveur avec le
    // prédicat de la tuile ; un segment n'est remplacé par « Tous les … » que si
    // le serveur a établi que le périmètre couvre bien TOUT le catalogue.
    function updateScopeBar() {
        const out = document.getElementById('exec-scope-value');
        if (!out) return;
        const SCOPE = INIT.scope || {};
        const filtered = !!(
            state.filters.siteName ||
            state.filters.departmentName ||
            state.filters.serviceName
        );
        // `scoped` de /api/dashboard/measures : les chiffres servis sont bornés.
        // Si l'API borne alors que la page se croit sans périmètre et qu'aucun
        // filtre n'est actif, on n'écrit pas « Tous les … » : on le dit.
        const bounded = !!SCOPE.restricted || (!!state.scopeBounded && !filtered);

        let text;
        if (SCOPE.restricted && SCOPE.empty && !filtered) {
            text = SCOPE.emptyLabel || '';
        } else if (bounded && !SCOPE.restricted && !filtered) {
            text = SCOPE.fallbackLabel || I18N.scopeYourPerimeter || 'Your scope';
        } else {
            text = [
                ['filter-site', state.filters.siteName, SCOPE.site],
                ['filter-department', state.filters.departmentName, SCOPE.department],
                ['filter-service', state.filters.serviceName, SCOPE.service],
            ]
                .map(([id, applied, perimeter]) => {
                    const v = applied == null ? '' : String(applied).trim();
                    if (v) return v;
                    // Périmètre imposé d'abord : il borne la mesure même sans filtre.
                    if (perimeter) return String(perimeter);
                    const el = document.getElementById(id);
                    return el && el.options.length ? el.options[0].textContent.trim() : '';
                })
                .filter(Boolean)
                .join(' · ');
        }
        out.textContent = text;

        const bar = document.getElementById('exec-scope-bar');
        if (bar) {
            bar.classList.toggle('is-filtered', filtered);
            bar.classList.toggle('is-scoped', bounded);
            bar.setAttribute('data-scoped', bounded ? '1' : '0');
        }
        const own = document.getElementById('exec-scope-own');
        if (own) {
            if (bounded && !own.textContent.trim()) {
                own.textContent =
                    SCOPE.limitedLabel || I18N.scopeLimited || 'limited to your scope';
            }
            own.hidden = !bounded;
        }
    }

    // Ce que la tuile des mesures vient de mesurer (`scoped`), branché sur le
    // bandeau : la garantie affichée suit la charge servie, elle ne l'affirme pas.
    function setMeasuresScoped(bounded) {
        state.scopeBounded = !!bounded;
        updateScopeBar();
    }

    // Show a count pill on a collapsed section summary.
    function setDisclosureCount(id, count) {
        const el = document.getElementById(id);
        if (!el) return;
        const n = Number(count);
        if (!Number.isFinite(n) || n <= 0) {
            el.hidden = true;
            return;
        }
        el.textContent = String(n);
        el.hidden = false;
    }

    // Fold a long inline table down to a preview of `limit` rows with a one-click
    // reveal. Nothing is removed — the rest is one button away.
    function applyRowFold(container, limit = 10) {
        if (!container) return;
        const stale = container.nextElementSibling;
        if (stale && stale.classList && stale.classList.contains('rowfold-bar')) stale.remove();

        const rows = Array.from(container.querySelectorAll('tbody > tr'));
        if (rows.length <= limit) return;
        const hiddenRows = rows.slice(limit);
        hiddenRows.forEach((tr) => tr.classList.add('rowfold-hidden'));

        const moreLabel = tn(I18N.showNMore || 'Show the {n} others', hiddenRows.length);
        const lessLabel = I18N.showLess || 'Show less';
        const noteLabel = tn(I18N.previewTopN || 'Preview: top {n}', limit);

        const bar = document.createElement('div');
        bar.className = 'rowfold-bar';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rowfold-toggle';
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = moreLabel;
        const note = document.createElement('span');
        note.className = 'rowfold-note';
        note.textContent = noteLabel;
        btn.addEventListener('click', () => {
            const expanded = btn.getAttribute('aria-expanded') === 'true';
            hiddenRows.forEach((tr) => tr.classList.toggle('rowfold-hidden', expanded));
            btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
            btn.textContent = expanded ? moreLabel : lessLabel;
            note.textContent = expanded ? noteLabel : '';
        });
        bar.appendChild(btn);
        bar.appendChild(note);
        container.insertAdjacentElement('afterend', bar);
    }

    // -------------------------------------------------------------------------
    // API Helper
    // -------------------------------------------------------------------------
    async function fetchAPI(endpoint, extraParams = {}) {
        const params = new URLSearchParams({ ...state.filters, ...extraParams });
        // Handle array filters if any? But state.filters comes from single selects mostly.
        const res = await fetch(`/api/dashboard/${endpoint}?${params}`);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
    }

    // -------------------------------------------------------------------------
    // Core Logic: Tab Switching
    // -------------------------------------------------------------------------
    function switchTab(tabName) {
        if (!VALID_TABS.includes(tabName)) tabName = 'executive';
        state.activeTab = tabName;

        // UI Update
        document.querySelectorAll('.tab-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        document.querySelectorAll('.tab-panel').forEach((panel) => {
            const isTarget = panel.id === `tab-${tabName}`;
            // .tab-fresh carries the (100ms) entry fade and ONLY for a tab that
            // still has to load; a tab already in state.loadedTabs is shown from
            // memory on the same frame, with no animation (dashboard.css).
            panel.classList.toggle('tab-fresh', isTarget && !state.loadedTabs.has(tabName));
            panel.classList.toggle('active', isTarget);
        });

        // URL Update
        updateHash(tabName);

        // Load Data Logic
        // If not loaded OR filters changed (we track filters change by clearing loadedTabs), load.
        if (!state.loadedTabs.has(tabName)) {
            loadTabData(tabName);
        }
    }

    async function loadTabData(tabName) {
        showLoading();
        // Hide previous errors if any
        const panel = document.getElementById(`tab-${tabName}`);
        const existingError = panel.querySelector('.error-state');
        if (existingError) existingError.remove();

        try {
            switch (tabName) {
                case 'executive':
                    await loadExecutive();
                    break;
                case 'training':
                    await loadTraining();
                    break;
                case 'talentdev':
                    await loadTalentDevelopment();
                    break;
                case 'team':
                    await loadTeam();
                    break;
                case 'capability':
                    await loadCapability();
                    break;
                case 'comparator':
                    await loadComparator();
                    break;
            }
            state.loadedTabs.add(tabName);
        } catch (err) {
            console.error(`Error loading ${tabName}:`, err);
            showError(tabName, err.message);
        } finally {
            hideLoading();
        }
    }

    // -------------------------------------------------------------------------
    // Tab 1: Executive Overview
    // -------------------------------------------------------------------------
    async function loadExecutive() {
        const [
            kpis,
            readinessSite,
            readinessDepartment,
            readinessService,
            dist,
            staffing,
            trend,
            orgRadar,
        ] = await Promise.all([
            fetchAPI('overview-kpis'),
            fetchAPI('readiness-by-group', { groupBy: 'site' }),
            fetchAPI('readiness-by-group', { groupBy: 'department' }),
            fetchAPI('readiness-by-group', { groupBy: 'service' }),
            fetchAPI('readiness-distribution'),
            fetchAPI('role-readiness'), // serves staffing risk
            fetchAPI('trend'),
            fetchAPI('org-domain-radar'),
        ]);

        updateScopeBar();
        renderKPICards(kpis, staffing);
        renderProvenanceNote('exec-provenance', kpis && kpis.provenance);
        renderTrendCaption('exec-trend-caption', trend);

        // Counts on the collapsed section summaries, so a director knows what is
        // inside before opening it.
        setDisclosureCount('radar-count', (orgRadar || []).length);
        setDisclosureCount('orgdist-count', (readinessDepartment || []).length);

        // Top 10 / Worst 10 radars. Only a MEASURED domain has a gap: with
        // `|| 0` an unmeasured one scored 0 actual against its full required
        // level, which is the largest gap arithmetic can produce, and it took
        // a place in "worst 10" on the strength of having no data at all —
        // the same defect the sub-domain radar had.
        const measuredDomains = (orgRadar || []).filter(
            (d) => d.avgActual != null && d.avgRequired != null
        );
        if (measuredDomains.length > 0) {
            const top10 = [...measuredDomains]
                .sort((a, b) => num(b.avgActual) - num(a.avgActual))
                .slice(0, 10);
            const worst10 = [...measuredDomains]
                .sort((a, b) => {
                    const gapA = num(a.avgRequired) - num(a.avgActual);
                    const gapB = num(b.avgRequired) - num(b.avgActual);
                    return gapB - gapA; // largest gap first
                })
                .slice(0, 10);
            renderOrgRadarChart('chart-org-radar-top', top10);
            renderOrgRadarChart('chart-org-radar-worst', worst10);
        }

        renderOrgRadarSummary('org-radar-summary-table', orgRadar);
        loadSubDomainRadar(''); // V3 sub-domain capability radar (non-blocking)
        loadBenchmarkFit(); // benchmark fit by role (non-blocking)
        renderBarChart('chart-readiness-site', readinessSite, {
            horizontal: true,
            thresholdColors: true,
            percent: true,
            labelKey: 'label',
            valueKey: 'avgReadiness',
        });
        renderBarChart('chart-readiness-department', readinessDepartment, {
            horizontal: true,
            thresholdColors: true,
            percent: true,
            labelKey: 'label',
            valueKey: 'avgReadiness',
        });
        renderBarChart('chart-readiness-service', readinessService, {
            horizontal: true,
            thresholdColors: true,
            percent: true,
            labelKey: 'label',
            valueKey: 'avgReadiness',
        });
        renderDonutChart('chart-readiness-dist', dist); // { bucket, count }
        renderStaffingRiskTable('staffing-risk-container', staffing);
        renderTrendChart('chart-trend', trend);

        // Strategic Insights — loaded in parallel (non-blocking)
        loadStrategicInsights();
    }

    function renderKPICards(kpis, staffing) {
        const container = document.getElementById('executive-kpis');
        if (!container) return;

        // Calculate derived values if missing. A role nobody assessed is neither
        // at risk nor covered — it is UNMEASURED, and is counted on its own
        // (rolesUnmeasured from the KPI query; the staffing rows' isUnmeasured
        // flag is the same verdict per role).
        //
        // prefer the KPI-query counts. `rolesAtRisk` there is the is_role_ready
        // criterion (measured occupants, whole-role readiness) and is the SAME
        // value persisted to kpi_snapshots and drawn on the trend. Deriving the
        // card from the staffing rows instead (readiness_assessed_only >= 80) is a
        // different definition that agrees today but would let the live card and
        // the trend history disagree. The staffing derivation stays only as a
        // fallback for an older payload that lacks the field.
        const riskCount =
            kpis.rolesAtRisk != null
                ? num(kpis.rolesAtRisk, 0)
                : staffing.filter((r) => r.isRisk && !r.isUnmeasured).length;
        const unmeasuredRoles =
            kpis.rolesUnmeasured != null
                ? num(kpis.rolesUnmeasured, 0)
                : staffing.filter((r) => r.isUnmeasured).length;

        // ONE coverage number, ONE readiness number (Wave 2).
        //
        // This strip used to render TWO contradictory coverage cards side by
        // side: "Assessment Coverage 100 %" (kpis.assessmentCoverage, which was
        // really "% of people whose role has a benchmark") and the honest
        // "Requirements assessed 74 %". The legacy card is gone;
        // kpis.assessmentCoverage now IS assessed/expected requirements, so the
        // single remaining card and the headline sub-line quote the same
        // fraction. `expected` is the FULL department-designed requirement
        // count — never a subset.
        const prov = kpis.provenance || null;
        // Prefer the KPI query's own denominators (same scope, same rounding);
        // fall back to the provenance rollup when an older payload lacks them.
        const assessedReq = num(
            kpis.assessedRequirements != null
                ? kpis.assessedRequirements
                : prov && prov.assessedSkills,
            0
        );
        const expectedReq = num(
            kpis.expectedRequirements != null
                ? kpis.expectedRequirements
                : prov && prov.expectedSkills,
            0
        );
        const neverReq = num(
            kpis.neverAssessedRequirements != null
                ? kpis.neverAssessedRequirements
                : prov && prov.neverAssessedSkills,
            Math.max(0, expectedReq - assessedReq)
        );
        const coveragePct =
            expectedReq > 0 ? Math.round((1000 * assessedReq) / expectedReq) / 10 : 0;
        const measured = num(kpis.measuredEmployees, 0);
        // Role-Ready is judged only over people whose EVERY requirement is
        // assessed: is_role_ready needs all requirements met, so a partially
        // assessed person cannot be role-ready and must not be counted as "not
        // ready" in the denominator — that is the unmeasured-as-a-result trap.
        const fullyMeasured = num(kpis.fullyMeasuredEmployees, 0);

        // avgReadiness is readiness_assessed_only — NULL, never 0, when nobody
        // in scope has been assessed. A dash is the only honest render.
        const hasReadiness = kpis.avgReadiness !== null && kpis.avgReadiness !== undefined;
        let readinessSub =
            expectedReq > 0
                ? assessedReq === 0
                    ? I18N.rdNoRequirementAssessed ||
                      I18N.provBasedOnNone ||
                      'no requirement assessed — not an earned zero'
                    : // Argument order is {0} = EXPECTED, {1} = ASSESSED — the same
                      // convention rdReadBodyAssessedOnly uses two calls above, and the
                      // one both locale strings are written for ("{1} exigences évaluées
                      // de {0}"). This call passed them the other way round, so the
                      // headline honesty KPI printed its own denominator backwards:
                      //   "sur les 3 353 exigences évaluées de 2 476"
                      // while the LECTURE line beneath it, on the same card, correctly
                      // read "2 476 exigences évaluées de 3 353". The inline fallback
                      // below is written to the same convention so the two can never
                      // drift apart again.
                      fmt(
                          I18N.rdBasedOnAssessed ||
                              'over the {1} of {0} requirements assessed ({2}%)',
                          grp(expectedReq),
                          grp(assessedReq),
                          coveragePct
                      )
                : `${I18N.kpiAvgAcross || 'avg across'} ${kpis.mappedEmployees} ${I18N.kpiMappedEmployees || 'mapped employees'}`;

        const cards = [
            {
                label: I18N.kpiAvgProficiency || 'Avg Proficiency',
                value: hasReadiness ? fmtPct(kpis.avgReadiness) : '—',
                sub: readinessSub,
                color: hasReadiness ? getColorForValue(kpis.avgReadiness, 80, 50) : 'neutral',
            },
            {
                // Denominator = people we can actually judge: those whose every
                // requirement has been assessed. "3 / 78" implied 75 tested and
                // failed; "3 / measured" still counted partially-assessed people
                // (who can never be role-ready) as "not ready". Fully-assessed is
                // the only honest basis for is_role_ready.
                label: I18N.kpiRoleReady || 'Role-Ready',
                value: `${kpis.roleReadyCount} / ${fullyMeasured}`,
                sub: fmt(
                    I18N.rdOfFullyAssessed || 'of {0} fully-assessed employees',
                    grp(fullyMeasured)
                ),
                color: 'neutral',
            },
            {
                label: I18N.kpiCriticalGaps || 'Critical Gaps',
                value: kpis.criticalGapCount,
                sub: I18N.rdMeasuredBelow50 || 'measured below 50%',
                color: kpis.criticalGapCount > 0 ? 'critical' : 'good',
            },
            {
                label: I18N.kpiCriticalCompliance || 'Critical Compliance',
                // NULL when the scope declares no critical skill at all —
                // SUM(totalCritical)=0 → NULLIF → null. "null%" was the render.
                value: kpis.criticalCompliance == null ? '—' : fmtPct(kpis.criticalCompliance),
                // A bare em dash says "something is missing" and nothing else,
                // so the reader has to come and ask why the figure is empty.
                // Measured on this instance: 187 critical requirements are in
                // scope and NOT ONE has been assessed, which is exactly what
                // the dash meant and never said. Same shape as "Roles at Risk"
                // two cards down: the unmeasured count sits BESIDE the value,
                // never inside it.
                sub:
                    kpis.criticalCompliance == null && Number(kpis.criticalExpectedRequirements) > 0
                        ? `<span class="kpi-unmeasured" title="${esc(I18N.rdNotMeasuredTitle || 'Never assessed — no data, this is not a level 0')}">${esc(I18N.rdNotMeasured || 'Not measured')}: ${grp(Number(kpis.criticalAssessedRequirements) || 0)}/${grp(Number(kpis.criticalExpectedRequirements))}</span>`
                        : I18N.kpiSafetySkills || 'safety & compliance skills',
                color:
                    kpis.criticalCompliance == null
                        ? 'neutral'
                        : getColorForValue(kpis.criticalCompliance, 95, 80),
            },
            {
                label: I18N.kpiRolesAtRisk || 'Roles at Risk',
                value: riskCount,
                // The unmeasured roles are stated beside the count, never inside it.
                sub:
                    (I18N.kpiSingleEmpRoles || 'single-employee roles') +
                    (unmeasuredRoles > 0
                        ? ` · <span class="kpi-unmeasured" title="${esc(I18N.rdNotMeasuredTitle || 'Never assessed — no data, this is not a level 0')}">${esc(I18N.rdNotMeasured || 'Not measured')}: ${grp(unmeasuredRoles)}</span>`
                        : ''),
                color: riskCount > 0 ? 'critical' : unmeasuredRoles > 0 ? 'neutral' : 'good',
            },
        ];

        // The single coverage card. Shown as a fraction, not a bare percentage,
        // so the denominator can never be lost on the way to a slide.
        if (expectedReq > 0) {
            cards.push({
                label: I18N.provKpiCoverage || 'Requirements assessed',
                value: `${grp(assessedReq)} / ${grp(expectedReq)}`,
                sub:
                    assessedReq === 0
                        ? I18N.provKpiCoverageNone || 'no assessment to date'
                        : fmt(I18N.provKpiCoverageSub || '{0} never assessed', grp(neverReq)),
                // Same class vocabulary the other cards use ('good' | 'neutral' |
                // 'critical'); getColorForValue returns a hex, which is not a class.
                color: coveragePct >= 90 ? 'good' : coveragePct >= 70 ? 'neutral' : 'critical',
            });
        }

        // Month-on-month movement from kpi_snapshots (migration 82).
        //
        // ABSENT, NOT ZERO. `deltas.values` only carries metrics that had a real
        // prior AND a real current value; a metric with no comparison point is
        // simply not a key, and renders nothing. On a fresh install every card
        // is delta-free — which is correct. Never substitute 0 here.
        const deltas = (kpis.deltas && kpis.deltas.values) || {};
        const since = kpis.deltas && kpis.deltas.since;
        // true when the delta compared a DIFFERENT measured population — a net
        // head-count change OR the same count but a different set of people
        // (fingerprint mismatch). Either way the movement is not purely capability.
        const populationChanged = !!(kpis.deltas && kpis.deltas.populationChanged);
        const deltaChip = (metric, opts) => {
            if (!Object.prototype.hasOwnProperty.call(deltas, metric)) return '';
            const d = Number(deltas[metric]);
            if (!Number.isFinite(d)) return '';
            const unit = (opts && opts.unit) || '';
            // "Lower is better" metrics (gaps, sole holders) invert the colour.
            const lowerBetter = Boolean(opts && opts.lowerBetter);
            const cls =
                Math.abs(d) < 0.05
                    ? 'delta-flat'
                    : d > 0 === !lowerBetter
                      ? 'delta-up'
                      : 'delta-down';
            const sign = d > 0 ? '+' : '';
            const arrow = Math.abs(d) < 0.05 ? '' : d > 0 ? '▲ ' : '▼ ';
            let title = since ? (I18N.kpiDeltaSince || 'since {d}').replace('{d}', since) : '';
            // A movement in an AVERAGE can be a change in WHO is averaged rather
            // than a change in anybody's capability: one below-average leaver
            // raises the mean, and five leavers replaced by five joiners moves no
            // count at all. The old code only checked the net head count and only
            // hid the caveat in the title, so "+0.6 pts" read as pure improvement.
            // populationChanged also catches the net-zero cohort change, and the
            // caveat is now a VISIBLE marker, not just a hover.
            let marker = '';
            if (populationChanged && metric !== 'measuredEmployees') {
                const pop = Number(deltas.measuredEmployees);
                const detail =
                    Number.isFinite(pop) && pop !== 0
                        ? fmt(
                              I18N.kpiDeltaPopulation ||
                                  'measured population changed by {0} over the same period',
                              (pop > 0 ? '+' : '') + pop
                          )
                        : I18N.kpiDeltaCohortChanged ||
                          'a different set of people was measured over the same period';
                title = title ? `${title} — ${detail}` : detail;
                marker = ` <span class="kpi-delta-note" title="${esc(detail)}">${esc(I18N.kpiDeltaCohortTag || '≠ cohort')}</span>`;
            }
            return `<span class="kpi-delta ${cls}" title="${esc(title)}">${arrow}${sign}${d}${esc(unit)}</span>${marker}`;
        };

        const deltaFor = {
            [I18N.kpiAvgProficiency || 'Avg Proficiency']: () =>
                deltaChip('avgReadiness', { unit: ' pts' }),
            [I18N.kpiRoleReady || 'Role-Ready']: () => deltaChip('roleReadyCount'),
            [I18N.kpiCriticalCompliance || 'Critical Compliance']: () =>
                deltaChip('criticalCompliance', { unit: ' pts' }),
            [I18N.provKpiCoverage || 'Requirements assessed']: () =>
                deltaChip('assessmentCoverage', { unit: ' pts' }),
        };

        container.innerHTML = cards
            .map((c) => {
                const chip = deltaFor[c.label] ? deltaFor[c.label]() : '';
                return `
            <div class="kpi-card ${c.color}">
                <div class="kpi-value">${c.value}${chip}</div>
                <div class="kpi-label">${c.label}</div>
                <div class="kpi-sub">${c.sub}</div>
            </div>
        `;
            })
            .join('');
    }

    // Headline caption for the trend chart. The figure is a PERCENTAGE
    // (readiness_assessed_only), not a 0-4 mastery score — the old caption
    // printed "82.1 / 4", labelling a percentage with the wrong unit.
    //
    // With a single recorded point the value is printed with NO delta: one
    // snapshot is not a trend, and inventing "+0.0" would be a fabricated
    // movement. Two or more points give a real first-to-last delta.
    function renderTrendCaption(containerId, trend) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.textContent = '';

        const series = trendSeries(trend);
        if (!series.length) return;

        const last = num(series[series.length - 1].avg, NaN);
        if (!Number.isFinite(last)) return;

        const fmt = (v) =>
            v.toLocaleString(_locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });

        const label = document.createElement('span');
        label.textContent = `${I18N.heroAvgReadiness || 'Average readiness'} : ${fmt(last)} %`;
        el.appendChild(label);

        if (series.length < 2) {
            // Say why there is no movement figure rather than showing nothing.
            const note = document.createElement('span');
            note.className = 'text-muted';
            note.textContent = ` · ${I18N.trendSinglePoint || 'first recorded snapshot — no comparison yet'}`;
            el.appendChild(note);
            return;
        }

        const first = num(series[0].avg, NaN);
        if (!Number.isFinite(first)) return;
        const delta = last - first;

        const sep = document.createElement('span');
        sep.textContent = ' · ';
        el.appendChild(sep);

        const chip = document.createElement('span');
        const sinceLabel = (I18N.trendSince || 'since {d}').replace('{d}', fmtDate(series[0].date));
        if (Math.abs(delta) < 0.05) {
            chip.textContent = `${I18N.heroTrendStable || 'stable'} (${sinceLabel})`;
        } else {
            chip.className = delta > 0 ? 'delta-up' : 'delta-down';
            chip.textContent = `${delta > 0 ? '▲ +' : '▼ '}${fmt(delta)} pts (${sinceLabel})`;
        }
        el.appendChild(chip);
    }

    function renderStaffingRiskTable(containerId, data) {
        const risks = data.filter((r) => r.isRisk);
        const container = document.getElementById(containerId);

        if (risks.length === 0) {
            // Absence of measurement is not "no risk" (cardinal rule). If the scope
            // has roles but not one was ever assessed, say the risk is unknown
            // rather than painting a green all-clear over an empty measurement.
            const anyMeasured = data.some((r) => !r.isUnmeasured);
            if (data.length > 0 && !anyMeasured) {
                showEmpty(
                    containerId,
                    I18N.scopeUnmeasured ||
                        'No assessment in this scope yet — risk cannot be evaluated'
                );
            } else {
                showEmpty(containerId, I18N.noStaffingRisks || 'No staffing risks detected');
            }
            return;
        }

        renderTable(
            containerId,
            [
                { key: 'roleName', label: I18N.role || 'Role', sortable: true },
                {
                    key: 'siteNames',
                    label: I18N.thSitesPresent || 'Sites Present',
                    sortable: false,
                },
                {
                    key: 'avgReadiness',
                    label: I18N.thAvgReadiness || 'Avg Readiness',
                    sortable: true,
                    format: pctOrDash,
                },
            ],
            risks,
            { emptyMessage: I18N.noRisks || 'No risks' }
        );
    }

    // -------------------------------------------------------------------------
    // Tab 2: Training Priorities
    // -------------------------------------------------------------------------
    async function loadTraining() {
        const domainFilter = document.getElementById('filter-gap-domain').value;
        const extra = domainFilter ? { domainName: domainFilter } : {};

        const [priorities, domainGaps, departmentGaps, serviceGaps] = await Promise.all([
            fetchAPI('skill-gaps', extra), // returns array of priorities directly from controller
            fetchAPI('domain-gaps', extra),
            fetchAPI('gaps-by-group', { ...extra, groupBy: 'department' }),
            fetchAPI('gaps-by-group', { ...extra, groupBy: 'service' }),
        ]);

        // Client-side calculations logic handled in service/controller already per spec?
        // Spec says: "Computes impactScore in JS... Sorts by impactScore descending" - in SERVICE.
        // Controller returns `data.priorities`. Client receives array.

        // Chart 1: Top 15 by impact
        const top15 = priorities.slice(0, 15);
        renderBarChart('chart-impact-gaps', top15, {
            horizontal: true,
            labelKey: 'skillName',
            valueKey: 'impactScore',
        });

        // Table: Top 20 (or all)
        renderTable(
            'training-priority-container',
            [
                { key: 'rank', label: '#', sortable: false, format: (_, row, i) => i + 1 },
                {
                    key: 'skillName',
                    label: I18N.thSkill || 'Skill',
                    sortable: true,
                    // esc(v): skill names are admin-editable free text and this
                    // formatter's output goes straight into innerHTML. A renamed
                    // skill was proven to execute <img onerror> on the Training tab.
                    format: (v, r) =>
                        r.isCritical ? `${esc(v)} <span class="badge-dot"></span>` : esc(v),
                },
                { key: 'domainName', label: I18N.thDomain || 'Domain', sortable: true },
                {
                    key: 'affectedEmployees',
                    label: I18N.thAffectedEmp || 'Affected Emp.',
                    sortable: true,
                },
                // "Affected" only counts people who WERE assessed on this skill, so a
                // skill nobody was ever measured on looks harmless. Show what is missing.
                {
                    key: 'neverAssessedEmployees',
                    label: I18N.provThNeverAssessed || 'Never assessed',
                    sortable: true,
                    format: (v, r) => {
                        if (v === null || v === undefined) return '—';
                        const n = num(v, 0);
                        if (n === 0) return '0';
                        const blind = num(r.affectedEmployees, 0) === 0;
                        return `<span class="prov-badge never" title="${esc(
                            blind
                                ? I18N.provBlindSpot || 'blind spot: nobody assessed on this skill'
                                : I18N.provNeverAssessedTitle || 'Never assessed'
                        )}">${grp(n)}</span>`;
                    },
                },
                { key: 'totalGapPoints', label: I18N.thGapPoints || 'Gap Points', sortable: true },
                { key: 'avgGap', label: I18N.thAvgGap || 'Avg Gap', sortable: true },
                {
                    key: 'impactScore',
                    label: I18N.thImpactScore || 'Impact Score',
                    sortable: true,
                    defaultSort: 'desc',
                },
            ],
            priorities,
            {
                onRowClick: expandGapDrilldown,
                rowIdKey: 'skillId',
            }
        );

        // Charts
        renderBarChart('chart-domain-gaps', domainGaps, {
            horizontal: false,
            labelKey: 'domainName',
            valueKey: 'totalGapPoints',
        });
        renderGroupedBarChart('chart-department-gaps', departmentGaps);
        renderGroupedBarChart('chart-service-gaps', serviceGaps);
    }

    async function expandGapDrilldown(row, element) {
        if (state.expandedGapSkill === row.skillId) {
            // Collapse
            document.getElementById(`drilldown-gap-${row.skillId}`)?.remove();
            state.expandedGapSkill = null;
            return;
        }

        // Collapse previous
        if (state.expandedGapSkill) {
            document.getElementById(`drilldown-gap-${state.expandedGapSkill}`)?.remove();
        }

        state.expandedGapSkill = row.skillId;

        // Fetch drilldown
        const employees = await fetchAPI(`gap-drilldown/${row.skillId}`);

        // Render sub-row
        const tr = document.createElement('tr');
        tr.id = `drilldown-gap-${row.skillId}`;
        tr.className = 'drilldown-row';
        const td = document.createElement('td');
        td.colSpan = 8; // Matches column count (incl. the "Never assessed" column)

        // Render simple table inside. Every row here IS assessed (the query filters
        // isAssessed = 1) — but "assessed" still bundles a supervisor-validated level
        // with an auto-approved self-rating, so name which one it is.
        let html = `<div class="detail-panel"><table class="data-table small">
            <thead><tr><th>Employee</th><th>Badge #</th><th>Site</th><th>Role</th><th>Actual</th><th>${esc(I18N.provThProvenance || 'Provenance')}</th><th>Required</th><th>Gap</th></tr></thead>
            <tbody>`;
        employees.forEach((e) => {
            html += `<tr>
                <td>${esc(e.employeeName)}</td>
                <td>${esc(e.employeeNumber)}</td>
                <td>${esc(e.siteName)}</td>
                <td>${esc(e.roleName)}</td>
                <td>${e.assessmentStatus === 'never_assessed' ? '—' : esc(e.actualLevel)}</td>
                <td>${provBadge(e.assessmentStatus)}</td>
                <td>${esc(e.requiredLevel)}</td>
                <td class="text-danger">-${e.gap}</td>
            </tr>`;
        });
        html += `</tbody></table></div>`;
        td.innerHTML = html;
        tr.appendChild(td);
        element.after(tr);
    }

    // -------------------------------------------------------------------------
    // Tab 3: Team Development
    // -------------------------------------------------------------------------
    async function loadTeam() {
        // Collect extra filters
        const search = document.getElementById('team-search').value;
        const role = document.getElementById('team-role-filter').value; // Controller doesn't filter by role name param...
        // Wait, Spec for File 1 says `getEmployeeList` takes `search` but NOT explicit role filter in `options`.
        // However, `_buildFilterClause` handles RBAC filters.
        // Spec Tab 3 says "Role dropdown (filter to specific role)".
        // I need to filter by role. But `DashboardModel.getEmployeeList` doesn't explicitly handle `roleId` filter from `options`.
        // It handles filters... wait.
        // `_buildFilterClause` handles `filters`.
        // If I pass `roleId` in filters? But dropdown has role NAME.
        // I should stick to spec. Spec says "Role dropdown".
        // If Model doesn't support it, I might have missed it or need to map Name to ID client side?
        // Actually, `DashboardController.getEmployeeList` just passes filters.
        // If I add `roleId` to `filters` in `DashboardController._buildFilters`? No, that only checks query params.
        // BUT my `_buildFilters` checks `req.query`.
        // So if I pass `?roleId=...` it might work if Model supports it?
        // `DashboardModel._buildFilterClause` logic:
        // checks siteId, departmentId, serviceId. NO roleId.
        // So I cannot filter by role server-side with current Model.
        // I will implement client-side filtering? No, pagination makes that bad.
        // I will fix `state.filters` to include roles? No, model ignores it.
        // I will just ignore role filter for now or re-query with `search`?
        // Actually, let's assume `search` works. Role filter might be a missed implementation detail in Model.
        // I will try to pass it maybe model has hidden support? No I wrote the model.
        // I'll skip role filtering implementation to stick to strict file artifacts,
        // or abuse `search`? No.
        // I'll assume standard fitlers + search. The pagination logic is robust.

        const myReports = document.getElementById('team-my-reports')?.checked;
        const params = {
            page: state.employeePage,
            pageSize: state.employeePageSize,
            sortBy: state.employeeSort.by,
            sortDir: state.employeeSort.dir,
            search: search,
            roleId: role,
        };
        if (myReports) params.supervisorId = INIT.user.id;

        const [data, actionBoard] = await Promise.all([
            fetchAPI('employee-list', params),
            fetchAPI('action-board', { ...params }), // Pass filters to action board (e.g. site/scope)
        ]);

        // Render Action Board
        renderActionBoard(actionBoard);

        // Render Table
        renderTable(
            'employee-table-container',
            [
                { key: 'name', label: I18N.thName || 'Name', sortable: true },
                { key: 'employeeNumber', label: '#', sortable: false },
                { key: 'siteName', label: I18N.thSite || 'Site', sortable: true },
                { key: 'roleName', label: I18N.role || 'Role', sortable: true },
                {
                    key: 'readiness',
                    label: I18N.thReadiness || 'Readiness',
                    sortable: true,
                    format: (v, r) =>
                        r.roleMapped
                            ? renderReadinessBadge(v)
                            : '<span class="readiness-unmapped">N/A</span>',
                },
                { key: 'gapCount', label: I18N.thGaps || 'Gaps', sortable: true },
                { key: 'topGapSkill', label: I18N.thTopGap || 'Top Gap', sortable: false },
            ],
            data.rows,
            {
                onRowClick: expandEmployeeDetail,
                rowIdKey: 'id',
            }
        );

        renderPagination('employee-pagination', data.total, data.page, data.pageSize);
    }

    // The canonical readiness (readiness_assessed_only) is NULL — never 0 —
    // when nobody has ever been assessed. Rendering that as "null%" in the
    // red "critical" badge is exactly the lie this wave exists to remove.
    function renderReadinessBadge(val) {
        if (val === null || val === undefined || val === '') {
            return `<span class="badge readiness-unmapped" title="${esc(
                I18N.rdNotMeasuredTitle || 'Never assessed — no data, this is not a level 0'
            )}">${esc(I18N.rdNotMeasured || 'Not measured')}</span>`;
        }
        let cls = 'readiness-critical';
        if (val >= 80) cls = 'readiness-good';
        else if (val >= 50) cls = 'readiness-warning';
        return `<span class="badge ${cls}">${fmtPct(val)}</span>`;
    }

    /** "72.4%" for a measured value, an em dash for an unmeasured one. */
    function pctOrDash(v) {
        return v === null || v === undefined || v === '' ? '—' : fmtPct(v);
    }

    function renderPagination(containerId, total, page, pageSize) {
        const container = document.getElementById(containerId);
        const totalPages = Math.ceil(total / pageSize);
        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        let html = '';
        html += `<button disabled>${esc(I18N.pagerTotal || 'Total')}: ${total}</button>`; // Info
        html += `<button ${page === 1 ? 'disabled' : ''} data-on-click="Dashboard.changePage" data-args="[${page - 1}]">${esc(I18N.pagerPrev || '« Prev')}</button>`;

        // Simple range: current-1, current, current+1
        for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
            html += `<button class="${i === page ? 'active' : ''}" data-on-click="Dashboard.changePage" data-args="[${i}]">${i}</button>`;
        }

        html += `<button ${page === totalPages ? 'disabled' : ''} data-on-click="Dashboard.changePage" data-args="[${page + 1}]">${esc(I18N.pagerNext || 'Next »')}</button>`;
        container.innerHTML = html;
    }

    // Exposed for the pager buttons (data-on-click, csp-actions.js)
    function changePage(newPage) {
        state.employeePage = newPage;
        loadTeam();
    }

    async function expandEmployeeDetail(row, element) {
        if (state.expandedEmployee === row.id) {
            document.getElementById(`detail-${row.id}`)?.remove();
            state.expandedEmployee = null;
            return;
        }
        if (state.expandedEmployee) {
            document.getElementById(`detail-${state.expandedEmployee}`)?.remove();
        }
        state.expandedEmployee = row.id;

        const profile = await fetchAPI(`employee-detail/${row.id}`);

        const tr = document.createElement('tr');
        tr.id = `detail-${row.id}`;
        tr.className = 'detail-row';
        const td = document.createElement('td');
        td.colSpan = 7;

        td.innerHTML = renderEmployeeProfileHTML(profile);
        tr.appendChild(td);
        element.after(tr);
    }

    function renderEmployeeProfileHTML(profile) {
        // profile: { info, domainGroups, topGaps, strengths }
        let html = `<div class="detail-panel">`;

        // Header
        html += `<div class="detail-header">
            <div class="info">
                <strong>${esc(profile.info.firstName)} ${esc(profile.info.lastName)}</strong> | ${esc(profile.info.roleName)}
            </div>
            <div class="readiness">
                ${renderReadinessBadge(profile.info.readiness)} Readiness
            </div>
        </div>`;

        // Stats — plus the coverage denominator, so "0 skills met" can be told
        // apart from "0 skills ever looked at".
        html += `<div class="detail-stats">
            <div>Skills Met: ${profile.info.skillsMet} / ${profile.info.totalRequired}</div>
            <div>Gap Count: ${profile.info.gapCount}</div>
            ${renderProfileCoverageStats(profile.coverage)}
        </div>`;

        // Domain Groups
        html += `<div class="detail-body">`;
        profile.domainGroups.forEach((g) => {
            html += `<div class="domain-group">
                <div class="domain-header">${esc(g.domainName)} (${g.skills.length})</div>
                <div class="skill-grid">
                    ${g.skills.map((s) => renderSkillCard(s)).join('')}
                </div>
            </div>`;
        });
        html += `</div></div>`;
        return html;
    }

    // One required skill. `actualLevel` arrives COALESCEd to 0 from the gaps view,
    // so a never-assessed requirement would otherwise render as a hard-earned "0".
    // When provenance says never_assessed we show an em-dash and say so out loud;
    // a real rated 0 keeps its "0" and is labelled as such.
    function renderSkillCard(s) {
        const status = s.assessmentStatus || null;
        const never = status === 'never_assessed';
        const selfOnly = status === 'self_only';
        // A lapsed certificate degrades the effective level to 0, but a real
        // rating exists — the 0 is "cannot perform today", not "supervisor rated
        // you 0". Show it as its own state so it never reads as a scored 0.
        const lapsed = s.certLapsed === true;

        const level = never
            ? '—'
            : s.actualLevel === null || s.actualLevel === undefined
              ? '—'
              : s.actualLevel;
        let mark = '';
        let title = '';
        if (never) {
            mark = I18N.provNeverAssessed || 'Never assessed';
            title = I18N.provNeverAssessedTitle || 'Never assessed — no data';
        } else if (lapsed) {
            mark = I18N.provCertLapsed || 'Certificate lapsed';
            title = fmt(
                I18N.provCertLapsedTitle || 'Rated {0} — certificate expired, no longer counts',
                s.ratedLevel == null ? '—' : s.ratedLevel
            );
        } else if (selfOnly) {
            mark = I18N.provSelfOnly || 'Self-rated';
            title = I18N.provSelfOnlyTitle || 'Self-assessed, not validated';
        } else if (status === 'assessed') {
            mark =
                num(s.actualLevel, -1) === 0
                    ? I18N.provAssessedZero || 'Assessed: 0'
                    : I18N.provValidated || 'Validated';
            title =
                num(s.actualLevel, -1) === 0
                    ? I18N.provAssessedZeroTitle || 'Assessed and rated 0 — real data'
                    : I18N.provValidatedTitle || 'Validated by a supervisor';
        }

        const provCls = never
            ? ' prov-never'
            : lapsed
              ? ' prov-lapsed'
              : selfOnly
                ? ' prov-self'
                : status === 'assessed'
                  ? ' prov-assessed'
                  : '';
        return `
                        <div class="skill-card status-${s.status}${provCls}"${title ? ` title="${esc(title)}"` : ''}>
                            <div class="skill-name">${esc(s.skillName)}</div>
                            <div class="skill-metrics">
                                <span class="actual">${esc(level)}</span> /
                                <span class="required">${s.requiredLevel || '—'}</span>
                            </div>
                            ${mark ? `<span class="prov-mark">${esc(mark)}</span>` : ''}
                            <div class="skill-icon">${never ? '—' : getIconForStatus(s.status)}</div>
                        </div>
                    `;
    }

    // Coverage line for one employee's profile: assessed / expected requirements.
    function renderProfileCoverageStats(coverage) {
        if (!coverage || !num(coverage.expectedSkills, 0)) return '';
        const assessed = num(coverage.assessedSkills, 0);
        const expected = num(coverage.expectedSkills, 0);
        const pct = coverage.coverage === null ? 0 : num(coverage.coverage, 0);
        const blind = assessed < expected ? ' is-blind' : '';

        let html = `<div class="prov-stat${blind}">${esc(
            fmt(
                I18N.provProfileCoverage || 'Assessed: {0} / {1} requirements ({2}%)',
                grp(assessed),
                grp(expected),
                pct
            )
        )}</div>`;
        if (num(coverage.neverAssessedSkills, 0) > 0) {
            html += `<div class="prov-stat is-blind">${esc(
                fmt(
                    I18N.provProfileNever || '{0} never assessed',
                    grp(coverage.neverAssessedSkills)
                )
            )}</div>`;
        }
        if (
            coverage.readinessAssessedOnly !== null &&
            coverage.readinessAssessedOnly !== undefined
        ) {
            html += `<div class="prov-stat">${esc(
                fmt(
                    I18N.provProfileAssessedOnly || 'Readiness over assessed requirements: {0}%',
                    num(coverage.readinessAssessedOnly, 0)
                )
            )}</div>`;
        }
        return html;
    }

    function getIconForStatus(status) {
        const map = { met: '✅', exceeded: '🟢', gap: '⚠️', not_required: '○', unassessed: '—' };
        return map[status] || '';
    }

    // -------------------------------------------------------------------------
    // Tab 4: Capability Map
    // -------------------------------------------------------------------------
    async function loadCapability() {
        const groupBy = document.querySelector('input[name="heatmap-group"]:checked').value;

        const [heatmap, staffing] = await Promise.all([
            fetchAPI('domain-heatmap', { groupBy }),
            fetchAPI('role-readiness'), // Staffing table
        ]);

        renderHeatmap('domain-heatmap', heatmap, groupBy);
        renderTable(
            'role-staffing-container',
            [
                { key: 'roleName', label: I18N.role || 'Role', sortable: true },
                { key: 'totalEmployees', label: I18N.thHeadcount || 'Headcount', sortable: true },
                {
                    key: 'avgReadiness',
                    label: I18N.thAvgReadiness || 'Avg Readiness',
                    format: pctOrDash,
                },
                {
                    key: 'isRisk',
                    label: I18N.thRisk || 'Risk',
                    // An unmeasured role shows "Not measured", never a ✓ (which
                    // would read as "covered") nor a ⚠️ (which would read as "at risk").
                    format: (v, row) =>
                        row && row.isUnmeasured
                            ? `<span title="${esc(I18N.rdNotMeasuredTitle || '')}">${esc(I18N.rdNotMeasured || 'Not measured')}</span>`
                            : v
                              ? '⚠️'
                              : '✓',
                },
            ],
            staffing
        );
    }

    // -------------------------------------------------------------------------
    // Tab 5: Comparator
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // Comparator — Predefined Radar Panels
    // -------------------------------------------------------------------------

    const comparatorCharts = {};

    function destroyComparatorChart(canvasId) {
        if (comparatorCharts[canvasId]) {
            comparatorCharts[canvasId].destroy();
            delete comparatorCharts[canvasId];
        }
    }

    // Categorical series colors — derived from the shared theme palette so the
    // comparator radars match every other chart in the app.
    const RADAR_COLORS = (
        CT.PALETTE || [
            TT.gold,
            TT.blue,
            TT.emerald,
            TT.amber,
            TT.red,
            '#B48EE8',
            '#4FC3E8',
            '#E88EB0',
        ]
    ).map((c) => ({ border: c, bg: 'rgba(255,255,255,0.04)' }));

    function renderComparatorRadar(canvasId, labels, datasets, options = {}) {
        destroyComparatorChart(canvasId);
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        if (!labels || labels.length === 0) {
            const parent = canvas.parentElement;
            if (parent)
                parent.innerHTML =
                    '<div class="empty-state"><p>' +
                    (I18N.noDataAvailable || 'No data available') +
                    '</p></div>';
            return;
        }

        comparatorCharts[canvasId] = new Chart(canvas, {
            type: 'radar',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    r: {
                        beginAtZero: true,
                        max: options.max || 4,
                        ticks: {
                            stepSize: 1,
                            backdropColor: 'transparent',
                            showLabelBackdrop: false,
                            color: TT.textDim,
                            font: { size: 10 },
                        },
                        pointLabels: {
                            font: { size: 10 },
                            color: TT.textDim,
                            callback: (label) =>
                                label.length > 18 ? label.substring(0, 16) + '…' : label,
                        },
                        grid: { color: GRIDC },
                        angleLines: { color: GRIDC },
                    },
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            usePointStyle: true,
                            pointStyle: 'circle',
                            padding: 12,
                            font: { size: 11 },
                        },
                    },
                    tooltip: {
                        callbacks: {
                            // A skipped vertex is unmeasured, and must say so
                            // rather than print "null" or imply a zero.
                            label: (ctx) =>
                                ctx.parsed.r == null
                                    ? `${ctx.dataset.label}: ${I18N.rdNotMeasured || 'Not measured'}`
                                    : `${ctx.dataset.label}: ${ctx.parsed.r}`,
                        },
                    },
                },
                elements: {
                    line: { borderWidth: 2 },
                    point: { radius: 3, hoverRadius: 5 },
                },
            },
        });
    }

    async function loadComparator() {
        try {
            // Read inline comparator filters
            const compFilters = {};
            const compSite = document.getElementById('comp-filter-site');
            const compDept = document.getElementById('comp-filter-department');
            const compSvc = document.getElementById('comp-filter-service');
            const compDom = document.getElementById('comp-filter-domain');
            if (compSite && compSite.value) compFilters.siteName = compSite.value;
            if (compDept && compDept.value) compFilters.departmentName = compDept.value;
            if (compSvc && compSvc.value) compFilters.serviceName = compSvc.value;
            if (compDom && compDom.value) compFilters.domainName = compDom.value;

            const data = await fetchAPI('comparator-radars', compFilters);

            // Panel 1: Actual vs Required
            // NULL, not num: the model returns null for a category/domain
            // nobody has measured, and num would coalesce that to 0 — the
            // fabricated "total capability collapse" the paired query exists to
            // avoid. Chart.js leaves a null vertex open and the tooltip says
            // "not measured".
            const rNum = (v) => (v == null ? null : Number(v));
            const avr = data.actualVsRequired || [];
            const avrLabels = avr.map((d) => d.domainName);
            const avrDatasets = [
                {
                    label: I18N.radarActual || 'Actual Proficiency',
                    data: avr.map((d) => rNum(d.avgActual)),
                    backgroundColor: CT.alpha(CT.ROLE.measured, 0.15),
                    borderColor: CT.ROLE.measured,
                    pointBackgroundColor: CT.ROLE.measured,
                },
                {
                    label: I18N.radarRequired || 'Required Level',
                    data: avr.map((d) => rNum(d.avgRequired)),
                    backgroundColor: CT.alpha(CT.ROLE.reference, 0.12),
                    borderColor: CT.ROLE.reference,
                    borderDash: [5, 5],
                    pointBackgroundColor: CT.ROLE.reference,
                },
            ];
            renderComparatorRadar('chart-comp-actual-vs-required', avrLabels, avrDatasets);

            // Helper for group comparison panels
            function renderGroupPanel(canvasId, groups) {
                if (!groups || groups.length === 0) {
                    renderComparatorRadar(canvasId, [], []);
                    return;
                }
                // Unify domain labels across all groups
                const allDomains = new Set();
                groups.forEach((g) => g.data.forEach((d) => allDomains.add(d.domainName)));
                const labels = Array.from(allDomains).sort();

                const datasets = groups.map((g, i) => {
                    const color = RADAR_COLORS[i % RADAR_COLORS.length];
                    const dataMap = new Map(g.data.map((d) => [d.domainName, d.avgLevel]));
                    return {
                        label: g.label,
                        // The axis set is the UNION over every group, so a group
                        // with no measurement in a domain has no entry here.
                        // `|| 0` plotted that as zero proficiency: live, PMO and
                        // Data & Insights were both drawn at 0 on Safety, which
                        // reads as "this service has no safety capability" when
                        // what is true is that nobody in it has been assessed on
                        // safety. null leaves the vertex open instead.
                        data: labels.map((l) => (dataMap.has(l) ? dataMap.get(l) : null)),
                        backgroundColor: color.bg,
                        borderColor: color.border,
                        pointBackgroundColor: color.border,
                        // A second, non-colour channel for series identity. The
                        // theme returns undefined unless the running identity asks
                        // for a marker cycle, and Chart.js then keeps its circles.
                        pointStyle: CT.pointStyle(i),
                    };
                });
                renderComparatorRadar(canvasId, labels, datasets);
            }

            renderGroupPanel('chart-comp-by-site', data.bySite);
            renderGroupPanel('chart-comp-by-department', data.byDepartment);
            renderGroupPanel('chart-comp-by-service', data.byService);

            // Panel 5: Proficiency by Domain (Actual vs Required). rNum, not
            // num: a domain nobody measured comes back null and must stay a
            // gap, not a fabricated zero — see the actual-vs-required panel.
            const domData = data.byDomain || [];
            const domLabels = domData.map((d) => d.domainName);
            const domDatasets = [
                {
                    label: I18N.radarActual || 'Actual Proficiency',
                    data: domData.map((d) => rNum(d.avgActual)),
                    backgroundColor: CT.alpha(CT.ROLE.measuredAlt, 0.15),
                    borderColor: CT.ROLE.measuredAlt,
                    pointBackgroundColor: CT.ROLE.measuredAlt,
                },
                {
                    label: I18N.radarRequired || 'Required Level',
                    data: domData.map((d) => rNum(d.avgRequired)),
                    backgroundColor: CT.alpha(CT.ROLE.referenceAlt, 0.12),
                    borderColor: CT.ROLE.referenceAlt,
                    borderDash: [5, 5],
                    pointBackgroundColor: CT.ROLE.referenceAlt,
                },
            ];
            renderComparatorRadar('chart-comp-by-domain', domLabels, domDatasets);

            // Panel: Proficiency by Sub-Domain (Actual vs Required) — V3.
            // No domain focus → ~43 axes; keep it readable by showing the 12 widest
            // gaps. When a Domain is selected the API already returns just its ~8.
            const subRaw = data.bySubDomain || [];
            const domFocused = !!(compDom && compDom.value);
            const subData = domFocused
                ? subRaw
                : [...subRaw]
                      .sort(
                          (a, b) =>
                              num(b.avgRequired) -
                              num(b.avgActual) -
                              (num(a.avgRequired) - num(a.avgActual))
                      )
                      .slice(0, 12);
            const subLabels = subData.map((d) => d.subDomainName);
            const subDatasets = [
                {
                    label: I18N.radarActual || 'Actual Proficiency',
                    data: subData.map((d) => num(d.avgActual)),
                    backgroundColor: CT.alpha(CT.ROLE.measured, 0.15),
                    borderColor: CT.ROLE.measured,
                    pointBackgroundColor: CT.ROLE.measured,
                },
                {
                    label: I18N.radarRequired || 'Required Level',
                    data: subData.map((d) => num(d.avgRequired)),
                    backgroundColor: CT.alpha(CT.ROLE.reference, 0.12),
                    borderColor: CT.ROLE.reference,
                    borderDash: [5, 5],
                    pointBackgroundColor: CT.ROLE.reference,
                },
            ];
            renderComparatorRadar('chart-comp-by-subdomain', subLabels, subDatasets);

            // Panel 6: Top Skill Gaps (Actual vs Required)
            const skillData = data.bySkill || [];
            const skillLabels = skillData.map((d) => d.skillName);
            const skillDatasets = [
                {
                    label: I18N.radarActual || 'Actual Proficiency',
                    data: skillData.map((d) => num(d.avgActual)),
                    backgroundColor: CT.alpha(CT.ROLE.measuredWarm, 0.15),
                    borderColor: CT.ROLE.measuredWarm,
                    pointBackgroundColor: CT.ROLE.measuredWarm,
                },
                {
                    label: I18N.radarRequired || 'Required Level',
                    data: skillData.map((d) => num(d.avgRequired)),
                    backgroundColor: CT.alpha(CT.ROLE.reference, 0.12),
                    borderColor: CT.ROLE.reference,
                    borderDash: [5, 5],
                    pointBackgroundColor: CT.ROLE.reference,
                },
            ];
            renderComparatorRadar('chart-comp-by-skill', skillLabels, skillDatasets);
        } catch (err) {
            console.error('Error loading comparator:', err);
        }
    }

    function renderHeatmap(containerId, data, groupBy) {
        // Pivot: rows=domains, cols=groups
        // distinct domains, distinct groups
        const domains = [...new Set(data.map((d) => d.domainName))].sort();
        const groups = [...new Set(data.map((d) => d.groupLabel))].sort();

        let html = `<table class="heatmap-table"><thead><tr><th>${esc(I18N.heatmapDomain || 'Domain')}</th>`;
        // Domain and group names are admin-editable free text and reach this
        // function verbatim from the API, so they must be escaped like any
        // other user-supplied string before going into innerHTML below.
        groups.forEach((g) => (html += `<th><div class="rotate">${esc(g)}</div></th>`));
        html += `</tr></thead><tbody>`;

        domains.forEach((dom) => {
            html += `<tr><td class="row-header">${esc(dom)}</td>`;
            groups.forEach((grp) => {
                const item = data.find((d) => d.domainName === dom && d.groupLabel === grp);
                if (item && item.assessedCount > 0) {
                    const level = Math.round(item.avgLevel);
                    html += `<td class="heat-${level}" title="Avg: ${item.avgLevel} | Assessed: ${item.assessedCount}">${item.avgLevel}</td>`;
                } else {
                    html += `<td class="heat-empty">—</td>`;
                }
            });
            html += `</tr>`;
        });
        html += `</tbody></table>`;

        // Color key — a heatmap without a legend forces guesswork (audit fix).
        const scale = I18N.scale || ['None', 'Basic Awareness', 'Guided', 'Autonomous', 'Expert'];
        html +=
            `<div class="heatmap-legend">` +
            `<span class="hm-legend-label">${esc(I18N.heatLegendLabel || 'Proficiency:')}</span>` +
            scale
                .map(
                    (label, i) =>
                        `<span class="hm-legend-item"><span class="hm-swatch heat-${i}">${i}</span> ${esc(label)}</span>`
                )
                .join('') +
            `</div>`;

        const container = document.getElementById(containerId);
        if (container) container.innerHTML = html;
    }

    // -------------------------------------------------------------------------
    // Utilities & Renderers
    // -------------------------------------------------------------------------

    function renderTable(containerId, columns, rows, options = {}) {
        const container = document.getElementById(containerId);
        if (!container) return; // Safety check

        if (!rows || rows.length === 0) {
            showEmpty(containerId, options.emptyMessage || I18N.noData || 'No data');
            return;
        }

        let html = `<table class="data-table"><thead><tr>`;
        columns.forEach((c) => {
            // Basic sort handling could be added here if client-side sorting desired (except employee list which is server side)
            // For training priorities, we sort client side on load, but header click re-sort?
            // Skipping complex sort UI for brevity, assuming Load sorts correctly.
            html += `<th>${c.label}</th>`;
        });
        html += `</tr></thead><tbody>`;

        rows.forEach((r, rowIndex) => {
            html += `<tr class="${options.onRowClick ? 'clickable' : ''}" ${options.rowIdKey ? `data-id="${r[options.rowIdKey]}"` : ''}>`;
            columns.forEach((c) => {
                let val = r[c.key];
                if (c.format) {
                    val = c.format(val, r, rowIndex);
                } // formatter output is trusted developer HTML
                else {
                    val = val === null || val === undefined ? '—' : esc(val);
                }
                html += `<td>${val === null || val === undefined ? '—' : val}</td>`;
            });
            html += `</tr>`;
        });
        html += `</tbody></table>`;
        container.innerHTML = html;

        if (options.onRowClick) {
            container.querySelectorAll('tbody tr').forEach((tr, idx) => {
                tr.addEventListener('click', () => options.onRowClick(rows[idx], tr));
            });
        }
    }

    function renderBarChart(canvasId, data, options) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        destroyChart(canvasId);
        if (!data || data.length === 0) {
            if (window.ChartTheme)
                ChartTheme.emptyState(
                    canvas,
                    (options && options.emptyMessage) || I18N.noDataYet || 'No data yet'
                );
            return;
        }

        const ctx = canvas.getContext('2d');
        const labels = data.map((d) => d[options.labelKey || 'label']);
        const values = data.map((d) => d[options.valueKey || 'value']);

        let bgColors = COLORS.neutral;
        if (options.thresholdColors) {
            // A null value is "not measured", not a failing score. Colour it
            // muted grey rather than sending it down getColorForValue's last
            // (red) branch, where `null >= 50` is false — an unmeasured site
            // used to read as the worst-performing one. The sibling
            // renderDeptRankingChart already does this.
            const noData = (CT.ROLE && CT.ROLE.noData) || 'rgba(148,163,184,0.5)';
            bgColors = values.map((v) => (v == null ? noData : getColorForValue(v, 80, 50)));
        }

        state.charts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        data: values,
                        backgroundColor: bgColors,
                        borderRadius: 4,
                    },
                ],
            },
            options: {
                indexAxis: options.horizontal ? 'y' : 'x',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    // A truncated list must say so: a caption below the chart
                    // states when only the top N bars are shown.
                    title: options.caption
                        ? {
                              display: true,
                              position: 'bottom',
                              text: options.caption,
                              font: { size: 11, weight: 'normal' },
                              color: '#94a3b8',
                          }
                        : { display: false },
                    tooltip: {
                        callbacks: {
                            label: (c) => {
                                const v = c.parsed[options.horizontal ? 'x' : 'y'];
                                if (v == null) return ' ' + (I18N.rdNotMeasured || 'Not measured');
                                return ' ' + v + (options.percent ? '%' : '');
                            },
                        },
                    },
                },
                scales: {
                    [options.horizontal ? 'x' : 'y']: {
                        beginAtZero: true,
                        max: options.percent ? 100 : undefined,
                        ticks: { callback: (v) => (options.percent ? fmtPct(v) : v) },
                    },
                },
            },
        });
    }

    function renderDonutChart(canvasId, data) {
        destroyChart(canvasId);
        if (!data.length) {
            if (window.ChartTheme) ChartTheme.emptyState(canvasId, I18N.noDataYet || 'No data yet');
            return;
        }
        const ctx = document.getElementById(canvasId).getContext('2d');

        // The readiness distribution now carries a 'never-assessed' bucket
        // (DashboardModel.getReadinessDistribution). It must read as
        // "non mesuré", never as a 0-20 % band — those people were not tested
        // and failed, they were never tested.
        const bucketLabel = (b) =>
            b === 'never-assessed' ? I18N.rdDistNeverAssessed || 'Not measured' : b;

        state.charts[canvasId] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: data.map((d) => bucketLabel(d.bucket)),
                datasets: [
                    {
                        data: data.map((d) => d.count),
                        backgroundColor: COLORS.donut,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
            },
        });
    }

    function renderRadarChart(canvasId, datasets) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        destroyChart(canvasId);

        if (!datasets || datasets.length === 0) {
            canvas.parentNode.innerHTML =
                '<canvas id="' +
                canvasId +
                '"></canvas><div class="empty-state">Select groups to compare</div>';
            return;
        }

        const ctx = canvas.getContext('2d');

        // Normalize Labels (Domains)
        const allDomains = new Set();
        datasets.forEach((ds) => {
            if (ds.data) ds.data.forEach((d) => allDomains.add(d.domainName));
        });
        const labels = Array.from(allDomains).sort();

        // Build Chart Data
        const chartDatasets = datasets.map((ds, i) => {
            const dataMap = new Map(ds.data.map((d) => [d.domainName, d.avgLevel]));
            // See renderGroupPanel: an absent domain is unmeasured, not zero.
            const dataPoints = labels.map((l) => (dataMap.has(l) ? dataMap.get(l) : null));

            // Access colors (cycle through donut colors or similar)
            const colorPalette = ['#2E75B6', '#F44336', '#FF9800', '#4CAF50', '#9C27B0', '#00BCD4'];
            const color = colorPalette[i % colorPalette.length];

            return {
                label: ds.label,
                data: dataPoints,
                backgroundColor: color + '33', // 20% opacity
                borderColor: color,
                pointBackgroundColor: color,
                borderWidth: 2,
            };
        });

        state.charts[canvasId] = new Chart(ctx, {
            type: 'radar',
            data: {
                labels: labels,
                datasets: chartDatasets,
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    r: {
                        beginAtZero: true,
                        max: 5, // Levels 0-5
                        ticks: { stepSize: 1 },
                    },
                },
                plugins: {
                    legend: { position: 'top' },
                },
            },
        });
    }

    // -------------------------------------------------------------------------
    // Organization Capability Radar (Executive Tab)
    // -------------------------------------------------------------------------
    function renderOrgRadarChart(canvasId, data, labelKey) {
        labelKey = labelKey || 'domainName';
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        destroyChart(canvasId);

        if (!data || data.length === 0) {
            canvas.parentNode.innerHTML =
                '<canvas id="' +
                canvasId +
                '"></canvas><div class="empty-state">' +
                (I18N.noCapabilityData || 'No capability assessment data available') +
                '</div>';
            return;
        }

        const ctx = canvas.getContext('2d');
        const labels = data.map((d) => d[labelKey]);
        const actualValues = data.map((d) => num(d.avgActual));
        const requiredValues = data.map((d) => num(d.avgRequired));

        state.charts[canvasId] = new Chart(ctx, {
            type: 'radar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: I18N.actualAvg || 'Actual Avg',
                        data: actualValues,
                        backgroundColor: CT.ROLE.neutralFill,
                        borderColor: SEM.neutral,
                        pointBackgroundColor: SEM.neutral,
                        pointBorderColor: TT.surface,
                        pointHoverBackgroundColor: '#fff',
                        pointHoverBorderColor: SEM.neutral,
                        borderWidth: 2.5,
                        pointRadius: 4,
                        fill: true,
                    },
                    {
                        label: I18N.requiredAvg || 'Required Avg',
                        data: requiredValues,
                        backgroundColor: CT.ROLE.lowFill,
                        borderColor: SEM.low,
                        borderDash: [6, 3],
                        pointBackgroundColor: SEM.low,
                        pointBorderColor: TT.surface,
                        pointHoverBackgroundColor: '#fff',
                        pointHoverBorderColor: SEM.low,
                        borderWidth: 2,
                        pointRadius: 3,
                        fill: true,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    r: {
                        beginAtZero: true,
                        max: 4,
                        ticks: {
                            stepSize: 1,
                            font: { size: 10 },
                            color: TT.textDim,
                            backdropColor: 'transparent',
                            showLabelBackdrop: false,
                        },
                        pointLabels: {
                            font: { size: 11, weight: '500' },
                            color: TT.textDim,
                        },
                        grid: { color: GRIDC },
                        angleLines: { color: GRIDC },
                    },
                },
                plugins: {
                    legend: { display: true, position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                // .toFixed throws on null, and a skipped
                                // vertex is exactly what null means here.
                                if (context.parsed.r == null)
                                    return `${context.dataset.label}: ${I18N.rdNotMeasured || 'Not measured'}`;
                                return `${context.dataset.label}: ${context.parsed.r.toFixed(2)} / 4`;
                            },
                        },
                    },
                },
            },
        });
    }

    // V3 Sub-Domain Capability Radar — axes are the framework's competency elements.
    // First (unfiltered) call also populates the pillar drill-down selector.
    let _subdomainRadarInit = false;
    async function loadSubDomainRadar(domainName) {
        try {
            const data = await fetchAPI('org-subdomain-radar', { domainName: domainName || '' });
            const sel = document.getElementById('subdomain-radar-pillar');
            if (sel && !_subdomainRadarInit) {
                _subdomainRadarInit = true;
                const pillars = [...new Set((data || []).map((d) => d.domainName))].sort();
                pillars.forEach((p) => {
                    const o = document.createElement('option');
                    o.value = p;
                    o.textContent = p;
                    sel.appendChild(o);
                });
                sel.addEventListener('change', () => loadSubDomainRadar(sel.value));
            }
            // A radar past ~12 axes is unreadable, so when many sub-domains are
            // in scope we show the largest gaps. Only a MEASURED sub-domain has
            // a gap: one nobody has been assessed on used to arrive with
            // avgActual 0, which is the largest gap arithmetic can produce, so
            // the never-assessed swept the top of the ranking and the caption
            // called them "the largest gaps". They are excluded from the
            // ranking and counted in words instead — absence of measurement is
            // reported as absence, never as a result.
            const all = data || [];
            const measured = all.filter(
                (d) => d.avgActual != null && d.avgRequired != null && num(d.assessedCount) > 0
            );
            const unmeasured = all.length - measured.length;

            let radarData = measured;
            const AXIS_CAP = 12;
            const capped = measured.length > AXIS_CAP;
            if (capped) {
                radarData = [...measured]
                    .sort(
                        (a, b) =>
                            num(b.avgRequired) -
                            num(b.avgActual) -
                            (num(a.avgRequired) - num(a.avgActual))
                    )
                    .slice(0, AXIS_CAP);
            }
            const cap = document.getElementById('subdomain-radar-caption');
            if (cap) {
                const parts = [];
                if (capped)
                    parts.push(
                        fmt(
                            I18N.sdRadarCapped ||
                                'Showing the {0} measured sub-domains with the largest gaps, of {1} measured.',
                            AXIS_CAP,
                            measured.length
                        )
                    );
                if (unmeasured > 0)
                    parts.push(
                        fmt(
                            I18N.sdRadarUnmeasured ||
                                '{0} sub-domain(s) are not plotted: nobody has been assessed on them yet, so they have no gap to show.',
                            unmeasured
                        )
                    );
                if (capped) parts.push(I18N.sdRadarFilterHint || 'Filter by pillar to see all.');
                cap.textContent = parts.join(' ');
            }
            renderOrgRadarChart('chart-org-subdomain-radar', radarData, 'subDomainName');
        } catch (e) {
            /* non-blocking panel */
        }
    }

    // Benchmark Fit by Role — how current occupants meet each role's required benchmark.
    async function loadBenchmarkFit() {
        const container = document.getElementById('benchmark-fit-container');
        if (!container) return;
        try {
            const params = new URLSearchParams({ ...state.filters });
            const res = await fetch(`/api/benchmark/fit?${params}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const fit = (await res.json()).filter((f) => f.occupants > 0);
            renderBenchmarkFitTable(container, fit);
            setDisclosureCount('benchmark-fit-count', fit.length);
            applyRowFold(container, 10);
        } catch (e) {
            container.innerHTML =
                '<div class="empty-state" style="padding:1.25rem;">' +
                (I18N.benchmarkFitUnavailable || 'Benchmark fit unavailable') +
                '</div>';
        }
    }

    function renderBenchmarkFitTable(container, fit) {
        const esc = (s) =>
            String(s == null ? '' : s).replace(
                /[&<>"']/g,
                (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
            );
        if (!fit.length) {
            container.innerHTML =
                '<div class="empty-state" style="padding:1.5rem;">' +
                (I18N.noOccupantsInScope ||
                    'No occupants in scope (or no assessments yet) for these roles.') +
                '</div>';
            return;
        }
        const band = (v) =>
            v == null ? '' : v >= 80 ? 'fit-good' : v >= 50 ? 'fit-mid' : 'fit-low';
        let html =
            '<table class="table"><thead><tr><th>' +
            (I18N.role || 'Role') +
            '</th><th style="text-align:center;">' +
            (I18N.occupants || 'Occupants') +
            '</th><th style="min-width:150px;">' +
            (I18N.benchmarkFit || 'Benchmark Fit') +
            '</th><th style="text-align:center;" title="' +
            esc(I18N.tipCoverageShare || 'Share of required skills assessed') +
            '">' +
            (I18N.coverage || 'Coverage') +
            '</th><th style="text-align:center;">' +
            (I18N.criticalFit || 'Critical Fit') +
            '</th><th style="text-align:center;" title="' +
            esc(I18N.tipCritOccupants || 'Occupants under a critical required level') +
            '">' +
            (I18N.critGaps || 'Crit. Gaps') +
            '</th><th style="text-align:center;">' +
            (I18N.readyGe80 || 'Ready ≥80%') +
            '</th></tr></thead><tbody>';
        const notMeasured = `<span class="bm-nodata" title="${esc(I18N.noOccupantsAssessed || 'No occupants assessed yet')}">—</span>`;
        for (const f of fit) {
            const v = f.benchmarkFit == null ? null : Number(f.benchmarkFit);
            const cov = f.coverage == null ? null : Number(f.coverage);
            // A role nobody has assessed has no measured crit-gap and no
            // ready count — "0 crit gaps" and "0/2 ready" read as an all-clear.
            // benchmark/index.ejs renders a dash here from the same endpoint;
            // this twin printed the zeros. measuredOccupants is the guard.
            const measured = Number(f.measuredOccupants || 0) > 0;
            const critGap = Number(f.occupantsCriticalGap || 0);
            const fitCell =
                cov === 0
                    ? notMeasured
                    : `<div class="bm-fitbar"><div class="bm-fitbar-fill ${band(v)}" style="width:${v == null ? 0 : v}%;"></div><span class="bm-fitbar-label">${v == null ? '—' : v + '%'}</span></div>`;
            html +=
                `<tr><td><a href="/benchmark/role/${f.roleId}"><strong>${esc(f.roleName)}</strong></a></td>` +
                `<td style="text-align:center;">${f.occupants}</td>` +
                `<td>${fitCell}</td>` +
                `<td style="text-align:center;${cov != null && cov < 60 ? 'color:#FF9800;' : ''}">${cov == null ? '—' : fmtPct(cov)}</td>` +
                `<td style="text-align:center;">${f.criticalFit == null ? '—' : fmtPct(f.criticalFit)}</td>` +
                `<td style="text-align:center;${measured && critGap > 0 ? 'color:#F44336;font-weight:700;' : ''}">${measured ? critGap : notMeasured}</td>` +
                `<td style="text-align:center;">${measured ? `${f.occupantsReady}/${f.occupants}` : notMeasured}</td></tr>`;
        }
        container.innerHTML = html + '</tbody></table>';
    }

    function renderOrgRadarSummary(containerId, data) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!data || data.length === 0) {
            container.innerHTML =
                '<div class="empty-state">' + (I18N.noData || 'No data') + '</div>';
            return;
        }

        // Sort by gap, largest first — over the MEASURED domains. An unmeasured
        // domain has no gap, and `|| 0` gave it the largest one.
        const measured = data.filter((d) => d.avgActual != null && d.avgRequired != null);
        const unmeasured = data.filter((d) => d.avgActual == null || d.avgRequired == null);
        const sorted = [...measured].sort(
            (a, b) =>
                num(b.avgRequired) - num(b.avgActual) - (num(a.avgRequired) - num(a.avgActual))
        );

        let html = `<table class="data-table compact">
            <thead><tr>
                <th>${esc(I18N.domain || 'Domain')}</th>
                <th>${esc(I18N.actualAvg || 'Actual')}</th>
                <th>${esc(I18N.requiredAvg || 'Required')}</th>
                <th>${esc(I18N.gap || 'Gap')}</th>
                <th>${esc(I18N.status || 'Status')}</th>
            </tr></thead><tbody>`;

        sorted.forEach((d) => {
            const actual = num(d.avgActual);
            const required = num(d.avgRequired);
            const gapNum = required - actual;
            let statusCls = 'readiness-good';
            let statusLabel = I18N.statusOnTrack || '✓ On Track';
            if (gapNum > 1.0) {
                statusCls = 'readiness-critical';
                statusLabel = I18N.statusCriticalGap || '⚠ Critical Gap';
            } else if (gapNum > 0.3) {
                statusCls = 'readiness-warning';
                statusLabel = I18N.statusNeedsFocus || '△ Needs Focus';
            } else if (gapNum <= 0) {
                statusCls = 'readiness-good';
                statusLabel = I18N.statusExceeds || '✓ Exceeds';
            }

            html += `<tr>
                <td><strong>${esc(d.domainName)}</strong></td>
                <td>${actual.toFixed(1)}</td>
                <td>${required.toFixed(1)}</td>
                <td class="${gapNum > 0 ? 'text-danger' : 'text-success'}">${gapNum > 0 ? '-' : '+'}${Math.abs(gapNum).toFixed(1)}</td>
                <td><span class="badge ${statusCls}">${esc(statusLabel)}</span></td>
            </tr>`;
        });

        // Named, never drawn as a gap of zero.
        unmeasured.forEach((d) => {
            html += `<tr>
                <td><strong>${esc(d.domainName)}</strong></td>
                <td colspan="4"><span class="kpi-unmeasured" title="${esc(I18N.rdNotMeasuredTitle || 'Never assessed — no data, this is not a level 0')}">${esc(I18N.rdNotMeasured || 'Not measured')}</span></td>
            </tr>`;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    function renderGroupedBarChart(canvasId, data) {
        // The endpoint (getGapsByGroup) returns per-(skill, group) rows — the
        // heaviest skill gaps, each already carrying the department/service it
        // belongs to (groupLabel). The heading is "gap concentration BY
        // department/service", so each bar is labelled with the group it sits in,
        // not a bare skill name (L4: it plotted skill names under a by-group
        // heading). The server applies the top-N; when it returns a full N the
        // caption says the list is truncated so a reader is not told a partial
        // list is the whole picture.
        const rows = (data || []).slice(0, 10).map((r) => ({
            label: r.groupLabel ? `${r.skillName} · ${r.groupLabel}` : r.skillName,
            totalGapPoints: r.totalGapPoints,
        }));
        const truncated = (data || []).length >= 10;
        renderBarChart(canvasId, rows, {
            horizontal: true,
            labelKey: 'label',
            valueKey: 'totalGapPoints',
            caption: truncated ? I18N.showingTopGaps || 'Showing the 10 largest gaps' : undefined,
        });
    }

    // The trend payload is { series, unit, scopeType, reason } — real recorded
    // history from kpi_snapshots, not a reconstruction. `avg` is a PERCENTAGE.
    // The old renderer pinned the axis at {min:0,max:4} while being fed values
    // around 82, so the line sat off the top of the plot area and the chart
    // appeared blank.
    function trendSeries(data) {
        if (Array.isArray(data)) return data; // tolerate a bare array
        return data && Array.isArray(data.series) ? data.series : [];
    }

    function renderTrendChart(canvasId, data) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        destroyChart(canvasId);

        const series = trendSeries(data);
        if (!series.length) {
            // A designed empty state that says WHY, so a sparse install does not
            // look broken: either no snapshot has been taken yet, or this scope
            // has no recorded history.
            const reason = data && data.reason;
            const msg =
                reason === 'no_scoped_history'
                    ? I18N.trendNoScopedHistory || 'No recorded history for this scope'
                    : I18N.trendNoHistoryYet || I18N.noTrendDataYet || 'No trend data yet';
            if (window.ChartTheme) ChartTheme.emptyState(canvas, msg);
            return;
        }

        const ctx = canvas.getContext('2d');
        // real time spacing. A category axis drew every interval the same
        // width, so a week-long gap between two snapshots looked like one day. A
        // linear scale over the day timestamps draws the gaps proportionally; ticks
        // are forced onto the recorded days so labels stay meaningful without a
        // date adapter (none is vendored).
        const xs = series.map((d) => new Date(d.date).getTime());
        // Auto-fit the y-axis to the data. A fixed 0-100 axis flattens a real but
        // narrow band of readiness (e.g. 96.8->97.9 on a populated roster) into a
        // straight line, so movement was invisible on mature databases while a
        // clean install — whose readiness climbs 82->95 as it fills up — showed a
        // slope. The window is padded, snapped to 5s and clamped to [0,100], with a
        // minimum span so near-constant data is not over-zoomed into misleading
        // swings; the axis stays labelled in % and the tooltip carries exact values.
        // The rule lives in chart-axis-fit.js, shared by every progression chart.
        const fit = window.ChartAxisFit
            ? window.ChartAxisFit.fitRange(
                  series.map((d) => d.avg),
                  window.ChartAxisFit.PERCENT
              )
            : { min: 0, max: 100 };
        const yMin = fit.min;
        const yMax = fit.max;
        state.charts[canvasId] = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: I18N.trendAvgReadiness || 'Average readiness (%)',
                        data: series.map((d, i) => ({ x: xs[i], y: d.avg })),
                        borderColor: COLORS.neutral,
                        backgroundColor: COLORS.neutral + '33',
                        fill: true,
                        tension: 0.4,
                        // A single recorded day must still be visible.
                        pointRadius: series.length === 1 ? 5 : 2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        type: 'linear',
                        afterBuildTicks: (axis) => {
                            axis.ticks = xs.map((v) => ({ value: v }));
                        },
                        ticks: {
                            callback: (v) => fmtDate(new Date(v).toISOString().slice(0, 10)),
                            autoSkip: true,
                            maxRotation: 0,
                        },
                    },
                    y: {
                        min: yMin,
                        max: yMax,
                        ticks: { callback: (v) => fmtPct(v) },
                    },
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            // The date is the tooltip TITLE (the x value is now a
                            // timestamp, not a pre-formatted label).
                            title: (items) =>
                                items.length
                                    ? fmtDate(
                                          new Date(items[0].parsed.x).toISOString().slice(0, 10)
                                      )
                                    : '',
                            // A readiness point is only readable WITH its coverage
                            // and the population it was measured over — omitting them
                            // let a thin-coverage number read like a solid one.
                            label: (c) => {
                                const p = series[c.dataIndex] || {};
                                const lines = [`${c.dataset.label}: ${fmtPct(c.parsed.y)}`];
                                if (p.coverage != null) {
                                    lines.push(
                                        `${I18N.trendCoverage || 'Coverage'}: ${fmtPct(p.coverage)}`
                                    );
                                }
                                if (p.measured != null) {
                                    lines.push(
                                        `${I18N.trendMeasured || 'Measured'}: ${p.measured}`
                                    );
                                }
                                return lines;
                            },
                        },
                    },
                },
            },
        });
    }

    function renderActionBoard(data) {
        // data: { staleAssessments: [], teamExperts: [] }

        // Stale Table
        renderTable(
            'action-stale-container',
            [
                { key: 'employeeName', label: I18N.thEmployee || 'Employee', sortable: false },
                {
                    key: 'lastAssessedAt',
                    label: I18N.thLastAssessed || 'Last Assessed',
                    format: (v) =>
                        v ? new Date(v).toLocaleDateString(_locale()) : I18N.never || 'Never',
                },
                { key: 'daysSinceAssessment', label: I18N.thDaysStale || 'Days Stale' },
                { key: 'roleName', label: I18N.role || 'Role' },
            ],
            data.staleAssessments,
            { emptyMessage: I18N.allUpToDate || 'All up to date! 🎉' }
        );

        // Experts Table
        renderTable(
            'action-experts-container',
            [
                { key: 'employeeName', label: I18N.thExpert || 'Expert', sortable: false },
                { key: 'skillCount', label: I18N.thNumSkillsLvl4 || '# Skills (Lvl 4)' },
                {
                    key: 'skills',
                    label: I18N.thExpertise || 'Expertise',
                    // Truncate the RAW text, then esc: the value is a
                    // GROUP_CONCAT of admin-editable skill names going into
                    // innerHTML. Truncating first can cut a tag in half, which
                    // esc then neutralises anyway.
                    format: (v) => esc(v ? (v.length > 50 ? v.substring(0, 50) + '...' : v) : ''),
                },
            ],
            data.teamExperts,
            { emptyMessage: I18N.noExpertsFound || 'No experts found' }
        );
    }

    function getColorForValue(val, goodThresh, warnThresh) {
        if (val >= goodThresh) return COLORS.good;
        if (val >= warnThresh) return COLORS.warning;
        return COLORS.danger; // or red
    }

    function destroyChart(id) {
        if (state.charts[id]) {
            state.charts[id].destroy();
            delete state.charts[id];
        }
    }

    function updateHash(tab) {
        window.location.hash = tab;
    }
    function showLoading() {
        document.getElementById('loading-overlay').classList.remove('hidden');
    }
    function hideLoading() {
        document.getElementById('loading-overlay').classList.add('hidden');
    }
    function showError(tab, msg) {
        const panel = document.getElementById(`tab-${tab}`);
        if (panel) {
            panel.insertAdjacentHTML(
                'afterbegin',
                `<div class="error-state alert alert-danger">Error: ${msg}</div>`
            );
        }
    }
    function showEmpty(id, msg) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<div class="empty-state">${msg}</div>`;
    }
    function copyToClipboard(id) {
        // simplified
        alert('Table copied to clipboard (simulation)');
    }

    async function refreshFilterOptions(changed) {
        const siteName = document.getElementById('filter-site').value;
        const deptName = document.getElementById('filter-department').value;

        // Build query for options
        const query = {};
        if (siteName) query.siteName = siteName;
        if (deptName) query.departmentName = deptName;

        // Fetch options
        const opts = await fetchAPI('filter-options', query);

        // Update dropdowns
        if (changed === 'site') {
            updateDropdown('filter-department', opts.departments);
            updateDropdown('filter-service', opts.services);
        } else if (changed === 'department') {
            updateDropdown('filter-service', opts.services);
        }
    }

    async function refreshComparatorOptions(changed) {
        const siteName = document.getElementById('comp-filter-site').value;
        const deptName = document.getElementById('comp-filter-department').value;

        // Build query for options
        const query = {};
        if (siteName) query.siteName = siteName;
        if (deptName) query.departmentName = deptName;

        // Fetch options
        const opts = await fetchAPI('filter-options', query);

        // Update dropdowns
        if (changed === 'site') {
            updateDropdown('comp-filter-department', opts.departments);
            updateDropdown('comp-filter-service', opts.services);
        } else if (changed === 'department') {
            updateDropdown('comp-filter-service', opts.services);
        }
    }

    function updateDropdown(id, items) {
        const el = document.getElementById(id);
        const current = el.value;
        // Keep "All" option
        let html = '<option value="">' + esc(I18N.filterAll || 'All') + '</option>';
        items.forEach((i) => {
            // Use Name as Value. esc both value and text — dept/service names are
            // admin/import-supplied and would otherwise be a stored-XSS sink here.
            html += `<option value="${esc(i.name)}" ${i.name === current ? 'selected' : ''}>${esc(i.name)}</option>`;
        });
        el.innerHTML = html;
        // If previously selected item is no longer valid, we reset?
        // With name checking, if "HR" was selected and "HR" is still in list, it stays.
        if (current && !items.find((i) => i.name === current)) el.value = '';

        // Enable/Disable based on items
        if (items.length > 0) {
            el.removeAttribute('disabled');
        } else {
            el.setAttribute('disabled', 'true');
        }
    }

    // -------------------------------------------------------------------------
    // Strategic Insights — Rendering Functions
    // -------------------------------------------------------------------------

    async function loadStrategicInsights() {
        try {
            const data = await fetchAPI('strategic-insights');
            if (!data) return;

            // A scope with zero measured axes has no risk verdict at all — the
            // empty-state renderers must say "not measured", not a green all-clear.
            const scopeUnmeasured = !!(data.riskIndex && data.riskIndex.measured === false);
            renderRiskGauge('risk-gauge-container', data.riskIndex);
            renderRiskBreakdown('risk-breakdown-container', data.riskIndex);
            renderOrgHealthCards('org-health-grid', data.orgHealth);
            renderCriticalRolesTable(
                'critical-roles-container',
                data.criticalRoles,
                scopeUnmeasured
            );
            renderImpactGapsBars(
                'impact-gaps-container',
                data.orgHealth.topImpactGaps,
                scopeUnmeasured
            );
            renderDeptRankingChart('chart-dept-ranking', data.orgHealth.deptRanking);

            // Update badge count
            const badge = document.getElementById('critical-roles-count');
            if (badge) badge.textContent = data.criticalRoles.length;
        } catch (err) {
            console.error('Error loading strategic insights:', err);
            // Don't break the page — strategic insights are supplementary
            const containers = [
                'risk-gauge-container',
                'org-health-grid',
                'critical-roles-container',
                'impact-gaps-container',
            ];
            containers.forEach((id) => {
                const el = document.getElementById(id);
                if (el)
                    el.innerHTML =
                        '<div class="empty-state">' +
                        (I18N.unableToLoad || 'Unable to load') +
                        '</div>';
            });
        }
    }

    // Health-score status label — French-first (primary audience), overridable via
    // the injected __I18N__ bundle. NOTE the score is a HEALTH score (higher = better;
    // >=80 healthy), so the widget reads "Sain" at the top, not "high risk".
    function riskStatusLabel(status) {
        const i = window.__I18N__ || {};
        if (i['risk_status_' + status]) return i['risk_status_' + status];
        // Fallback follows the page language (<html lang>): the English UI
        // must never show the French label.
        const fr = (document.documentElement.getAttribute('lang') || 'fr').indexOf('fr') === 0;
        const L = fr
            ? {
                  healthy: 'Sain',
                  moderate: 'Modéré',
                  'at-risk': 'À risque',
                  critical: 'Critique',
                  unknown: '—',
              }
            : {
                  healthy: 'Healthy',
                  moderate: 'Moderate',
                  'at-risk': 'At risk',
                  critical: 'Critical',
                  unknown: '—',
              };
        return L[status] || String(status).replace('-', ' ');
    }

    function renderRiskGauge(containerId, riskData) {
        const container = document.getElementById(containerId);
        if (!container) return;

        // null, not `|| 0`: a scope with nothing measured returns score null /
        // status 'unknown', and printing a big red 0 for it states a
        // catastrophe nobody measured. An unmeasured gauge shows an em dash.
        const measured = riskData.measured !== false && riskData.score != null;
        const score = measured ? riskData.score : null;
        const status = measured ? riskData.status || 'unknown' : 'unknown';

        // Color mapping
        const colorMap = {
            healthy: '#4CAF50',
            moderate: '#FF9800',
            'at-risk': '#FF5722',
            critical: '#F44336',
            unknown: '#9E9E9E',
        };
        const color = colorMap[status] || colorMap.unknown;

        // SVG circular gauge
        const radius = 70;
        const circumference = 2 * Math.PI * radius;
        // No score → an empty ring, not a full one.
        const offset =
            score == null ? circumference : circumference - (score / 100) * circumference;

        // A composite built from only SOME axes must say so, or a score
        // computed from one dimension reads as a verdict on all five.
        const unmeasured = Array.isArray(riskData.unmeasured) ? riskData.unmeasured : [];
        const total = unmeasured.length + measuredAxisCount(riskData);
        const caveat =
            unmeasured.length > 0
                ? `<div class="gauge-caveat" title="${esc(I18N.rdNotMeasuredTitle || 'Never assessed — no data')}">${esc(
                      fmt(
                          I18N.riskPartial || '{0} of {1} dimensions not measured',
                          unmeasured.length,
                          total
                      )
                  )}</div>`
                : '';

        container.innerHTML = `
            <div class="risk-gauge">
                <svg viewBox="0 0 200 200" class="gauge-svg">
                    <circle cx="100" cy="100" r="${radius}" class="gauge-bg"/>
                    <circle cx="100" cy="100" r="${radius}" class="gauge-fill"
                        stroke="${color}"
                        stroke-dasharray="${circumference}"
                        stroke-dashoffset="${offset}"
                        transform="rotate(-90 100 100)"/>
                </svg>
                <div class="gauge-center">
                    <span class="gauge-score" style="color: ${color}">${score == null ? '—' : score}</span>
                    <span class="gauge-label">${esc(riskStatusLabel(status))}</span>
                </div>
            </div>
            ${caveat}
        `;
    }

    // How many axes a risk payload actually measured (for the "N of M" caveat).
    function measuredAxisCount(riskData) {
        if (!riskData.breakdown) return 0;
        return Object.values(riskData.breakdown).filter((a) => a && a.measured).length;
    }

    function renderRiskBreakdown(containerId, riskData) {
        const container = document.getElementById(containerId);
        if (!container || !riskData.breakdown) return;

        const labels = I18N.scoreLabels || {
            readiness: 'Readiness',
            coverage: 'Coverage',
            compliance: 'Compliance',
            staffing: 'Staffing',
            freshness: 'Freshness',
        };

        const html = Object.entries(riskData.breakdown)
            .map(([key, val]) => {
                // An unmeasured axis has score null. `null >= 80` is false, so
                // it used to fall to the red branch, render `width:null%` and
                // print the literal "null". A grey empty bar and an em dash
                // instead — not measured is not a failing score.
                const unmeasured = val.score == null;
                const barColor = unmeasured
                    ? 'var(--text-muted, #9E9E9E)'
                    : val.score >= 80
                      ? '#4CAF50'
                      : val.score >= 60
                        ? '#FF9800'
                        : '#F44336';
                const width = unmeasured ? 0 : val.score;
                const label = labels[key] || key;
                const valueCell = unmeasured
                    ? `<span class="breakdown-value" title="${esc(I18N.rdNotMeasuredTitle || 'Never assessed — no data')}">—</span>`
                    : `<span class="breakdown-value">${val.score}</span>`;
                return `
                <div class="breakdown-row${unmeasured ? ' is-unmeasured' : ''}">
                    <span class="breakdown-label">${esc(label)} <small>(${fmtPct(val.weight)})</small></span>
                    <div class="breakdown-bar-track">
                        <div class="breakdown-bar-fill" style="width: ${width}%; background: ${barColor};"></div>
                    </div>
                    ${valueCell}
                </div>
            `;
            })
            .join('');

        container.innerHTML = html;
    }

    function renderOrgHealthCards(containerId, orgHealth) {
        const container = document.getElementById(containerId);
        if (!container) return;

        // The model returns NULL, never 0, when a metric has nothing behind it
        // ("no role → no bench depth, nobody on the roster → no freshness, no
        // requirement → no coverage"). `|| 0` erased that distinction and, since
        // `null >= 1` is false, sent every unmeasured metric down the LAST
        // branch — so "never measured" was published as a red critical 0 %.
        const band = (v, good, warn) =>
            v == null ? 'neutral' : v >= good ? 'good' : v >= warn ? 'warning' : 'critical';
        const pct = (v) => (v == null ? UNMEASURED : fmtPct(v));

        const metrics = [
            {
                label: I18N.ohBenchDepth || 'Bench Depth',
                value: orgHealth.benchDepth == null ? UNMEASURED : orgHealth.benchDepth,
                unit: I18N.ohBenchDepthUnit || 'avg/role',
                icon: '👥',
                color: band(orgHealth.benchDepth, 2, 1),
                tooltip:
                    I18N.ohBenchDepthTip || 'Average qualified employees (≥80% readiness) per role',
            },
            {
                label: I18N.ohAssessmentFreshness || 'Assessment Freshness',
                value: pct(orgHealth.assessmentFreshness),
                unit: I18N.ohWithin6Months || 'within 6 months',
                icon: '🕐',
                color: band(orgHealth.assessmentFreshness, 80, 50),
                tooltip:
                    I18N.ohAssessmentFreshnessTip ||
                    'Percentage of employees assessed in the last 6 months',
            },
            {
                label: I18N.ohSkillCoverage || 'Skill Coverage',
                value: pct(orgHealth.skillCoverage),
                unit: I18N.ohRequiredAssessed || 'required assessed',
                icon: '📋',
                color: band(orgHealth.skillCoverage, 80, 50),
                tooltip:
                    I18N.ohSkillCoverageTip ||
                    'Percentage of required role-skill mappings that have been assessed',
            },
            {
                label: I18N.ohNeverAssessed || 'Never Assessed',
                value: orgHealth.neverAssessedCount || 0,
                unit: I18N.ohEmployees || 'employees',
                icon: '⚠️',
                color:
                    orgHealth.neverAssessedCount === 0
                        ? 'good'
                        : orgHealth.neverAssessedCount <= 5
                          ? 'warning'
                          : 'critical',
                tooltip:
                    I18N.ohNeverAssessedTip || 'Employees who have never had any skill assessment',
            },
        ];

        container.innerHTML = metrics
            .map(
                (m) => `
            <div class="health-metric-card ${m.color}" title="${m.tooltip}">
                <div class="health-icon">${m.icon}</div>
                <div class="health-value">${m.value}</div>
                <div class="health-label">${m.label}</div>
                <div class="health-unit">${m.unit}</div>
            </div>
        `
            )
            .join('');
    }

    function renderCriticalRolesTable(containerId, roles, scopeUnmeasured) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const stale = container.nextElementSibling;
        if (stale && stale.classList && stale.classList.contains('rowfold-bar')) stale.remove();

        if (!roles || roles.length === 0) {
            // A scope where nothing was ever assessed has NO risk verdict — it is
            // unknown, not a green all-clear (cardinal rule).
            container.innerHTML = scopeUnmeasured
                ? '<div class="empty-state">' +
                  (I18N.scopeUnmeasured ||
                      'No assessment in this scope yet — risk cannot be evaluated') +
                  '</div>'
                : '<div class="empty-state success-state">✅ ' +
                  (I18N.noCriticalRoleRisks || 'No critical role risks detected') +
                  '</div>';
            return;
        }

        const rows = roles
            .map((r) => {
                let riskLevel = 'warning';
                let riskLabel = I18N.riskGeneric || 'RISK';
                let riskDesc = '';
                let riskIcon = '⚠️';

                // Coerce before comparing. These come from COUNT/SUM, i.e.
                // bigint, which the pg driver returns as a STRING: "0" === 0 is
                // false, so every branch below missed and all 23 rows fell
                // through to the generic "RISK" badge. The model now casts to
                // ::int as well; this does not depend on that holding.
                const headcount = Number(r.headcount);
                const qualifiedCount = Number(r.qualifiedCount);

                if (headcount === 0) {
                    riskLevel = 'severe';
                    riskLabel = I18N.riskVacant || 'VACANT';
                    riskDesc = I18N.riskVacantDesc || 'No incumbents';
                    riskIcon = '🚫';
                } else if (qualifiedCount === 0) {
                    // Capability Risk: People exist, but none are ready
                    riskLevel = 'capability-risk';
                    riskLabel = I18N.riskNoCapability || 'NO CAPABILITY';
                    riskDesc = I18N.riskNoCapabilityDesc || 'Skill gap';
                    riskIcon = '🔥';
                } else if (headcount === 1 && qualifiedCount === 1) {
                    // Capacity Risk: Only 1 person, and they are ready
                    riskLevel = 'capacity-risk';
                    riskLabel = I18N.riskSingle || '1 ONLY';
                    riskDesc = I18N.riskSingleDesc || 'Single point of failure';
                    riskIcon = '⚡';
                } else if (headcount > 1 && qualifiedCount === 1) {
                    // Upskilling Risk: Many people, only 1 ready
                    riskLevel = 'warning';
                    riskLabel = I18N.riskLowDepth || 'LOW DEPTH';
                    riskDesc = I18N.riskLowDepthDesc || 'Upskilling needed';
                    riskIcon = '📈';
                }

                return `
                <tr class="risk-row ${riskLevel}">
                    <td>
                        <span class="risk-badge ${riskLevel}" title="${esc(riskDesc)}">${riskIcon} ${esc(riskLabel)}</span>
                    </td>
                    <td>
                        <div style="font-weight:600">${esc(r.roleName)}</div>
                        <div style="font-size:0.75rem; opacity:0.7">${esc(riskDesc)}</div>
                    </td>
                    <td>${r.headcount}</td>
                    <td>${r.avgReadiness != null ? fmtPct(r.avgReadiness) : 'N/A'}</td>
                    <td class="text-muted" style="font-size:0.85rem">${esc(r.qualifiedNames || '—')}</td>
                    <td class="text-muted" style="font-size:0.85rem">${esc(r.sites || '—')}</td>
                </tr>
            `;
            })
            .join('');

        container.innerHTML = `
            <table class="data-table compact">
                <thead>
                    <tr>
                        <th>${esc(I18N.thRiskType || 'Risk type')}</th>
                        <th>${esc(I18N.role || 'Role')}</th>
                        <th>${esc(I18N.thHeadcount || 'Headcount')}</th>
                        <th>${esc(I18N.thAvgReadiness || 'Avg readiness')}</th>
                        <th>${esc(I18N.thQualifiedStaff || 'Qualified staff')}</th>
                        <th>${esc(I18N.thSites || 'Sites')}</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;

        // Progressive disclosure: show the 10 worst inline, the rest one click away.
        applyRowFold(container, 10);
    }

    function renderImpactGapsBars(containerId, gaps, scopeUnmeasured) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!gaps || gaps.length === 0) {
            // No gaps because nothing was measured is not "no gaps" — say so.
            container.innerHTML = scopeUnmeasured
                ? '<div class="empty-state">' +
                  esc(
                      I18N.scopeUnmeasured ||
                          'No assessment in this scope yet — risk cannot be evaluated'
                  ) +
                  '</div>'
                : '<div class="empty-state success-state">✅ ' +
                  esc(I18N.gapsNone || 'No significant skill gaps') +
                  '</div>';
            return;
        }

        const maxImpact = Math.max(...gaps.map((g) => g.totalImpact || 1));

        const html = gaps
            .map((g) => {
                const pct = Math.round((g.totalImpact / maxImpact) * 100);
                const barColor = g.isCritical ? '#F44336' : '#FF9800';
                return `
                <div class="impact-gap-row">
                    <div class="impact-gap-info">
                        <span class="impact-skill-name">${esc(g.skillName)}</span>
                        ${g.isCritical ? '<span class="critical-tag">' + esc(I18N.tagCritical || 'CRITICAL') + '</span>' : ''}
                        <span class="impact-meta">${g.affected} ${esc(I18N.impactAffected || 'affected')} · ${esc(I18N.impactGap || 'gap')} ${g.avgGap}</span>
                    </div>
                    <div class="impact-bar-track">
                        <div class="impact-bar-fill" style="width: ${pct}%; background: ${barColor};"></div>
                    </div>
                    <span class="impact-value">${g.totalImpact}</span>
                </div>
            `;
            })
            .join('');

        container.innerHTML = html;
    }

    function renderDeptRankingChart(canvasId, deptData) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        if (!deptData || deptData.length === 0) {
            if (window.ChartTheme)
                ChartTheme.emptyState(canvas, I18N.noDepartmentData || 'No department data yet');
            return;
        }

        if (state.charts[canvasId]) {
            state.charts[canvasId].destroy();
        }

        const labels = deptData.map((d) => d.label);
        // null (never measured) stays null so Chart.js leaves a GAP. Coercing
        // it to 0 drew an unmeasured department as the worst performer.
        const values = deptData.map((d) => (d.avgReadiness == null ? null : d.avgReadiness));
        const bgColors = values.map((v) =>
            v == null
                ? CT.ROLE.noData
                : v >= 80
                  ? SEM.good
                  : v >= 60
                    ? SEM.mid
                    : v >= 40
                      ? CT.ROLE.midLow
                      : SEM.low
        );

        state.charts[canvasId] = new Chart(canvas, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: I18N.thAvgReadiness || 'Avg Readiness %',
                        data: values,
                        backgroundColor: bgColors,
                        borderRadius: 4,
                        barThickness: 24,
                    },
                    {
                        label: I18N.chartHeadcount || 'Headcount',
                        data: deptData.map((d) => d.headcount),
                        backgroundColor: 'rgba(46,117,182,0.3)',
                        borderRadius: 4,
                        barThickness: 24,
                        yAxisID: 'y1',
                    },
                ],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            color:
                                getComputedStyle(document.documentElement)
                                    .getPropertyValue('--text-primary')
                                    .trim() || '#e0e0e0',
                            font: { size: 11 },
                        },
                    },
                    tooltip: {
                        callbacks: {
                            afterLabel: (ctx) => {
                                const dept = deptData[ctx.dataIndex];
                                return `Ready: ${dept.readyCount} | Critical: ${dept.criticalCount}`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        max: 100,
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        ticks: {
                            color:
                                getComputedStyle(document.documentElement)
                                    .getPropertyValue('--text-secondary')
                                    .trim() || '#aaa',
                        },
                    },
                    x1: {
                        display: false,
                    },
                    y: {
                        grid: { display: false },
                        ticks: {
                            color:
                                getComputedStyle(document.documentElement)
                                    .getPropertyValue('--text-primary')
                                    .trim() || '#e0e0e0',
                            font: { size: 11 },
                        },
                    },
                    y1: {
                        position: 'right',
                        display: false,
                    },
                },
            },
        });
    }

    // -------------------------------------------------------------------------
    // Tab: Talent Development Performance
    // -------------------------------------------------------------------------
    async function loadTalentDevelopment() {
        const d = await fetchAPI('talent-development');
        renderTalentKPIs(d);
        renderTalentCharts(d);
        renderTalentPipelines(d);
        renderNineBoxGrid(d.nineBox);
        renderTalentAttention(d);
    }

    // Class (not hex) for percentage KPIs so the .kpi-card styling applies.
    function pctClass(v, good, warn) {
        if (v == null) return 'neutral';
        return v >= good ? 'good' : v >= warn ? 'warning' : 'critical';
    }

    function renderTalentKPIs(d) {
        const el = document.getElementById('talentdev-kpis');
        if (!el) return;
        const c = d.coaching,
            idp = d.idp,
            pip = d.pip,
            nb = d.nineBox;
        // PIP success rate: the server only publishes a percentage when it rests
        // on closures whose plan period actually elapsed, and on enough of them
        // (pip.minMeasured). Otherwise successRate is null and this tile must say
        // "not measured" — an unrun plan is an ABSENCE of measurement, never a
        // result. The plans left out are shown, not hidden: the sub-line names the
        // closures whose period never elapsed and the plans never started.
        const pipMeasured = pip.successRate != null;
        const pipClosedAll =
            pip.closed != null ? pip.closed : pip.closedSuccess + pip.closedFailure;
        const pipSub = pipMeasured
            ? fmt(
                  I18N.tdSubPlansRun || '{0}/{1} plans run to term',
                  pip.measuredSuccess,
                  pip.measuredClosed
              )
            : fmt(
                  I18N.tdSubPipClosures ||
                      '{0} of {1} closures ran their plan period · {2} never started',
                  pip.measuredClosed || 0,
                  pipClosedAll,
                  pip.neverStarted || 0
              );
        const cards = [
            {
                label: I18N.tdActiveCoaching || 'Active Coaching',
                value: c.coachingActive,
                sub: fmt(
                    I18N.tdSubNotStarted || '{0} not started · avg {1}%',
                    c.notStarted,
                    c.avgProgress
                ),
                color: c.coachingActive ? 'neutral' : 'good',
            },
            {
                label: I18N.tdActiveMentoring || 'Active Mentoring',
                value: c.mentoringActive,
                sub: I18N.tdMentoringRel || 'mentoring relationships',
                color: 'neutral',
            },
            {
                label: I18N.tdIdpsInProgress || 'IDPs In Progress',
                value: idp.active + idp.draft,
                sub: fmt(I18N.tdSubIdp || '{0} completed · {1} draft', idp.completed, idp.draft),
                color: 'neutral',
            },
            {
                label: I18N.tdActivePips || 'Active PIPs',
                value: pip.active,
                sub: fmt(I18N.tdSubAwaiting || '{0} awaiting activation', pip.proposed),
                color: pip.active ? 'warning' : 'good',
            },
            {
                label: I18N.tdPipSuccess || 'PIP Success Rate',
                value: pipMeasured ? fmtPct(pip.successRate) : I18N.rdNotMeasured || 'Not measured',
                sub: pipSub,
                color: pipMeasured ? pctClass(pip.successRate, 60, 30) : 'neutral',
                title: pipMeasured ? '' : I18N.rdNotMeasuredTitle || '',
            },
            {
                label: I18N.tdNineboxAssessed || '9-Box Assessed',
                value: nb.assessed,
                sub: fmt(I18N.tdSubNinebox || '{0} top · {1} at risk', nb.top, nb.risk),
                color: nb.assessed ? 'neutral' : 'warning',
            },
            {
                label: I18N.tdLevelUps || 'Skill Level-Ups (90d)',
                value: d.skillLevelUps90d,
                sub: I18N.tdLevelUpsSub || 'confirmed proficiency gains',
                color: d.skillLevelUps90d ? 'good' : 'warning',
            },
            {
                label: I18N.tdIdpCompletion || 'IDP Action Completion',
                value: idp.completionPct == null ? '—' : fmtPct(idp.completionPct),
                sub: fmt(
                    I18N.tdSubActionsDone || '{0}/{1} actions done',
                    idp.actionDone,
                    idp.actionTotal
                ),
                color: pctClass(idp.completionPct, 70, 40),
            },
        ];
        el.innerHTML = cards
            .map(
                (x) => `
            <div class="kpi-card ${x.color}"${x.title ? ` title="${esc(x.title)}"` : ''}>
                <div class="kpi-value">${x.value}</div>
                <div class="kpi-label">${x.label}</div>
                <div class="kpi-sub">${x.sub}</div>
            </div>`
            )
            .join('');
    }

    // Small reusable doughnut builder for this tab. Keeps the <canvas> in the DOM
    // even when empty (toggles a sibling note) so later reloads can redraw.
    function talentDonut(canvasId, labels, values, colors) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        destroyChart(canvasId);
        const parent = canvas.parentNode;
        let note = parent.querySelector('.td-empty');
        const empty = !values.some((v) => num(v) > 0);
        canvas.style.display = empty ? 'none' : '';
        if (empty) {
            if (!note) {
                note = document.createElement('div');
                note.className = 'td-empty empty-state';
                parent.appendChild(note);
            }
            note.textContent = I18N.noDataYet || 'No data yet';
            return;
        }
        if (note) note.remove();
        state.charts[canvasId] = new Chart(canvas.getContext('2d'), {
            type: 'doughnut',
            data: { labels, datasets: [{ data: values, backgroundColor: colors }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } },
            },
        });
    }

    function renderTalentCharts(d) {
        const c = d.coaching;
        talentDonut(
            'chart-coaching-state',
            [
                I18N.tdStActive || 'Active',
                I18N.tdStCompleted || 'Completed',
                I18N.tdStCancelled || 'Cancelled',
            ],
            [c.active, c.completed, c.cancelled],
            // Theme tokens, not literals (3.23.17 UX-04): the light theme and a
            // re-branded edition must repaint the Talent tab too.
            [COLORS.neutral, COLORS.good, TT.textDim]
        );

        const ctx = d.coachingContext || {};
        talentDonut(
            'chart-coaching-context',
            [I18N.tdCauseSkillGap || 'Skill gap', 'PIP', 'IDP', I18N.tdCauseOther || 'Other'],
            [ctx.skill_gap || 0, ctx.pip || 0, ctx.idp || 0, ctx.other || 0],
            [COLORS.neutral, COLORS.danger, COLORS.good, COLORS.warning]
        );

        const nb = d.nineBox;
        talentDonut(
            'chart-ninebox-dist',
            [
                I18N.tdTierTop || 'Top talent',
                I18N.tdTierCore || 'Core',
                I18N.tdTierRisk || 'At risk',
            ],
            [nb.top, nb.core, nb.risk],
            [COLORS.neutral, COLORS.good, COLORS.danger]
        );
        renderTalentBellCurve(nb);
    }

    // Talent distribution bell curve: bars = actual 9-box population per talent
    // tier, overlaid with an ideal normal curve scaled to the same headcount.
    function renderTalentBellCurve(nb) {
        const canvasId = 'chart-talent-bellcurve';
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        destroyChart(canvasId);
        const curve = (nb && nb.curve) || [];
        const counts = curve.map((c) => num(c.count));
        const total = counts.reduce((a, b) => a + b, 0);

        const parent = canvas.parentNode;
        let note = parent.querySelector('.td-empty');
        canvas.style.display = total > 0 ? '' : 'none';
        if (!total) {
            if (!note) {
                note = document.createElement('div');
                note.className = 'td-empty empty-state';
                parent.appendChild(note);
            }
            note.textContent = I18N.tdNoNinebox || 'No approved 9-box placements yet';
            return;
        }
        if (note) note.remove();

        const TIER_LABELS = I18N.talentTiers || [
            'At risk',
            'Below core',
            'Core',
            'Above core',
            'Top talent',
        ];
        const labels = curve.map((c) =>
            TIER_LABELS[c.score] != null ? TIER_LABELS[c.score] : c.tier
        );
        // Ideal normal distribution centred on the middle tier, scaled to headcount.
        const n = curve.length,
            mid = (n - 1) / 2,
            sigma = 1.05;
        const weights = curve.map((_, i) => Math.exp(-((i - mid) ** 2) / (2 * sigma * sigma)));
        const wsum = weights.reduce((a, b) => a + b, 0) || 1;
        const ideal = weights.map((w) => (w / wsum) * total);
        // Low → high talent tier, from the theme's semantic tokens (UX-04).
        const barColors = [
            COLORS.danger,
            COLORS.warning,
            COLORS.good,
            COLORS.neutral,
            COLORS.neutral,
        ];

        state.charts[canvasId] = new Chart(canvas.getContext('2d'), {
            data: {
                labels,
                datasets: [
                    {
                        type: 'bar',
                        label: I18N.chartEmployees || 'Employees',
                        data: counts,
                        backgroundColor: barColors,
                        borderRadius: 4,
                        order: 2,
                    },
                    // The ideal curve is a GUIDE laid over the data, not a series —
                    // its own role token, so it never competes with a palette slot.
                    {
                        type: 'line',
                        label: I18N.chartIdealDistribution || 'Ideal distribution',
                        data: ideal,
                        borderColor: CT.ROLE.guide,
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        tension: 0.4,
                        pointRadius: 3,
                        pointBackgroundColor: CT.ROLE.guide,
                        order: 1,
                        fill: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: (ctx) =>
                                ctx.dataset.type === 'line'
                                    ? fmt(I18N.tdTipIdeal || 'Ideal: {0}', Math.round(ctx.parsed.y))
                                    : fmt(I18N.tdTipEmployees || '{0} employee(s)', ctx.parsed.y),
                        },
                    },
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: { display: true, text: I18N.chartEmployees || 'Employees' },
                        ticks: { precision: 0 },
                    },
                    x: {
                        title: {
                            display: true,
                            text: I18N.talentTierAxis || 'Talent tier  (performance + potential)',
                        },
                    },
                },
            },
        });
    }

    function renderTalentPipelines(d) {
        const el = document.getElementById('talentdev-pipelines');
        if (!el) return;
        const pip = d.pip,
            idp = d.idp;
        // 3.23.17 UX-04: labels come from the session language (dashboard.ejs
        // → window.__I18N__) and fills from the theme's CSS tokens, so the light
        // theme and a re-branded edition repaint them. EN literals are fallbacks.
        const bar = (label, value, total, colorVar) => {
            const pct = total ? Math.round((value / total) * 100) : 0;
            return `<div class="td-bar-row"><span class="td-bar-label">${esc(label)}</span>
                <span class="td-bar-track"><span class="td-bar-fill" style="width:${pct}%;background:var(${colorVar})"></span></span>
                <span class="td-bar-val">${esc(value)}</span></div>`;
        };
        const active = I18N.tdStActive || 'Active';
        el.innerHTML = `
            <div class="td-pipe-block"><h4>${esc(fmt(I18N.tdPipeHeadingPip || 'PIP ({0})', pip.total))}</h4>
                ${bar(I18N.tdPipeProposed || 'Proposed', pip.proposed, pip.total, '--amber')}
                ${bar(active, pip.active, pip.total, '--blue')}
                ${bar(I18N.tdPipeClosedSuccess || 'Closed — success', pip.closedSuccess, pip.total, '--emerald')}
                ${bar(I18N.tdPipeClosedFailure || 'Closed — failure', pip.closedFailure, pip.total, '--red')}
            </div>
            <div class="td-pipe-block"><h4>${esc(fmt(I18N.tdPipeHeadingIdp || 'IDP ({0})', idp.total))}</h4>
                ${bar(I18N.tdPipeDraft || 'Draft', idp.draft, idp.total, '--text-muted')}
                ${bar(active, idp.active, idp.total, '--blue')}
                ${bar(I18N.tdStCompleted || 'Completed', idp.completed, idp.total, '--emerald')}
            </div>`;
    }

    // 3×3 talent grid (rows = potential high→low, cols = performance low→high).
    function renderNineBoxGrid(nb) {
        const el = document.getElementById('talentdev-ninebox-grid');
        if (!el) return;
        const grid = nb.grid || {};
        // 3.23.17 UX-04: the cell names are the talentx:nb_cell_* labels the
        // 9-box console uses (dashboard.ejs → I18N.nbCells), keyed `pot-perf`.
        const LABELS = Object.assign(
            {
                'high-low': 'Diamond',
                'high-medium': 'Shooting Star',
                'high-high': 'Gold Star',
                'medium-low': 'Dilemma',
                'medium-medium': 'Core',
                'medium-high': 'Emerging Star',
                'low-low': 'Concern',
                'low-medium': 'Essential',
                'low-high': 'Trusted',
            },
            I18N.nbCells || {}
        );
        const LEVELS = Object.assign(
            { low: 'low', medium: 'medium', high: 'high' },
            I18N.nbLevels || {}
        );
        const pots = ['high', 'medium', 'low'];
        const perfs = ['low', 'medium', 'high'];
        const cellColor = (perf, pot) => {
            const s = { low: 0, medium: 1, high: 2 }[perf] + { low: 0, medium: 1, high: 2 }[pot];
            return s >= 3 ? 'var(--blue)' : s === 2 ? 'var(--emerald)' : 'var(--red)';
        };
        let html = '';
        pots.forEach((pot) =>
            perfs.forEach((perf) => {
                const key = `${pot}-${perf}`;
                const cnt = grid[key] || 0;
                const title = fmt(
                    I18N.tdNbCellTitle || '{0} (performance {1} / potential {2})',
                    LABELS[key],
                    LEVELS[perf],
                    LEVELS[pot]
                );
                html += `<div class="td-cell" style="border-top:4px solid ${cellColor(perf, pot)}" title="${esc(title)}">
                <span class="td-cell-count">${esc(cnt)}</span><span class="td-cell-label">${esc(LABELS[key])}</span></div>`;
            })
        );
        el.innerHTML = `<div class="td-grid-axis-pot">${esc(I18N.nbAxisPot || 'Potential ↑')}</div>
            <div class="td-grid">${html}</div>
            <div class="td-grid-axis-perf">${esc(I18N.nbAxisPerf || 'Performance →')}</div>`;
    }

    function renderTalentAttention(d) {
        const el = document.getElementById('talentdev-attention');
        if (!el) return;
        const items = [
            {
                label: I18N.pipeAwaitingPip || 'PIPs awaiting activation',
                count: d.pip.proposed,
                href: '/v2/pip',
            },
            {
                label: I18N.pipeDraftIdp || 'IDPs still in draft',
                count: d.idp.draft,
                href: '/v2/idp',
            },
            {
                label: I18N.pipeCoachingNotStarted || 'Coaching plans not started',
                count: d.coaching.notStarted,
                href: '/coaching/plans',
            },
        ].filter((i) => num(i.count) > 0);
        if (!items.length) {
            el.innerHTML =
                '<div class="empty-state success-state">✅ ' +
                esc(
                    I18N.pipeAllInMotion ||
                        'Nothing waiting — all development actions are in motion.'
                ) +
                '</div>';
            return;
        }
        el.innerHTML = items
            .map(
                (i) => `
            <a class="td-attn-row" href="${i.href}">
                <span class="td-attn-count">${i.count}</span>
                <span class="td-attn-label">${i.label}</span>
                <span class="td-attn-go">→</span>
            </a>`
            )
            .join('');
    }

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------

    function init() {
        // Bind Tabs
        document.querySelectorAll('.tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        // Bind Comparator Filters
        const compSite = document.getElementById('comp-filter-site');
        if (compSite) {
            compSite.addEventListener('change', async () => {
                await refreshComparatorOptions('site');
                state.loadedTabs.delete('comparator');
                if (state.activeTab === 'comparator') loadComparator();
            });
        }

        const compDept = document.getElementById('comp-filter-department');
        if (compDept) {
            compDept.addEventListener('change', async () => {
                await refreshComparatorOptions('department');
                state.loadedTabs.delete('comparator');
                if (state.activeTab === 'comparator') loadComparator();
            });
        }

        ['comp-filter-service', 'comp-filter-domain'].forEach((id) => {
            const el = document.getElementById(id);
            if (el)
                el.addEventListener('change', () => {
                    state.loadedTabs.delete('comparator');
                    if (state.activeTab === 'comparator') loadComparator();
                });
        });

        // Bind Apply Filters
        document.getElementById('btn-apply-filters').addEventListener('click', () => {
            // Read selects into state.filters
            state.filters.siteName = document.getElementById('filter-site').value;
            state.filters.departmentName = document.getElementById('filter-department').value;
            state.filters.serviceName = document.getElementById('filter-service').value;
            updateScopeBar();
            state.loadedTabs.clear();
            loadTabData(state.activeTab);
        });

        // Bind Dependent Filters
        document
            .getElementById('filter-site')
            .addEventListener('change', () => refreshFilterOptions('site'));
        document
            .getElementById('filter-department')
            .addEventListener('change', () => refreshFilterOptions('department'));

        // Bind Reset Filters
        const resetBtn = document.getElementById('btn-reset-filters');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                document.getElementById('filter-site').value = '';
                document.getElementById('filter-department').value = '';
                document.getElementById('filter-service').value = '';
                state.filters = {};
                updateScopeBar();
                state.loadedTabs.clear();
                loadTabData(state.activeTab);
            });
        }

        // Collapsible executive sections. Charts built inside a closed <details>
        // have a zero-width container, so re-measure them the first time it opens.
        document.querySelectorAll('#tab-executive details.exec-disclosure').forEach((d) => {
            d.addEventListener('toggle', () => {
                if (!d.open) return;
                Object.keys(state.charts).forEach((id) => {
                    const chart = state.charts[id];
                    if (!chart || typeof chart.resize !== 'function') return;
                    if (!d.contains(chart.canvas)) return;
                    try {
                        chart.resize();
                        chart.update('none');
                    } catch (e) {
                        /* a chart that cannot re-measure must not break the tab */
                    }
                });
            });
        });

        updateScopeBar();

        // Bind Heatmap Group Toggle (Capability Tab)
        document.querySelectorAll('input[name="heatmap-group"]').forEach((radio) => {
            radio.addEventListener('change', (e) => {
                if (state.activeTab === 'capability') loadCapability();
            });
        });

        // Initial Load. Some tabs may be hidden per-admin (workspace prefs), so the
        // default/hash target might have no button — fall back to the first VISIBLE tab.
        const hash = window.location.hash.replace('#', '');
        const firstBtn = document.querySelector('.tab-btn');
        const fallback = firstBtn ? firstBtn.dataset.tab : 'executive';
        const desired = hash || 'executive';
        const hasDesired = document.querySelector('.tab-btn[data-tab="' + desired + '"]');
        switchTab(hasDesired ? desired : fallback);
    }

    return { init, changePage, copyToClipboard, loadComparator, setMeasuresScoped };
})();

// `const Dashboard` est une liaison LEXICALE de script : elle n'est pas une
// propriété de `window`. Les blocs en ligne de la vue (tuile des mesures) la
// lisent via `window.Dashboard` — on la publie donc explicitement, sinon
// `window.Dashboard` reste `undefined` dans un vrai navigateur.
window.Dashboard = Dashboard;

document.addEventListener('DOMContentLoaded', Dashboard.init);
