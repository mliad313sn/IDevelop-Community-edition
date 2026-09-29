'use strict';
const BenchmarkModel = require('../models/BenchmarkModel');
const db = require('../config/database');
const { csvCell } = require('../utils/csvSafe');

/**
 * Benchmark module — role×skill required-level matrix (how the benchmark varies
 * role-to-role) and per-role "benchmark fit" (how current occupants meet it).
 */
class BenchmarkController {
    // Merge query filters + RBAC scope (req.scope from rbacMiddleware).
    _buildFilters(req) {
        const q = req.query;
        const f = {};
        const take = (k) => {
            const v = q[k];
            if (v && v !== 'null' && v !== '') f[k] = v;
        };
        [
            'domainName',
            'roleName',
            'category',
            'siteName',
            'departmentName',
            'serviceName',
            'skillQuery',
        ].forEach(take);
        if (q.subDomainId && q.subDomainId !== 'null' && q.subDomainId !== '')
            f.subDomainId = q.subDomainId;
        if (q.roleFamilyId && q.roleFamilyId !== 'null' && q.roleFamilyId !== '')
            f.roleFamilyId = q.roleFamilyId;
        if (q.minLevel && q.minLevel !== 'null' && q.minLevel !== '' && q.minLevel !== '0')
            f.minLevel = Number(q.minLevel);
        if (q.criticalOnly === 'true' || q.criticalOnly === '1') f.criticalOnly = true;
        const s = req.scope || {};
        if (s.siteIds && s.siteIds.length) f.siteIds = s.siteIds;
        if (s.departmentIds && s.departmentIds.length) f.departmentIds = s.departmentIds;
        if (s.serviceIds && s.serviceIds.length) f.serviceIds = s.serviceIds;
        if (s.employeeIds && s.employeeIds.length) f.employeeIds = s.employeeIds;
        return f;
    }

    async index(req, res) {
        try {
            const filters = this._buildFilters(req);

            // Filter options for the toolbar.
            const [pillars, subDomains, roleFamilies, roles, sites, departments, services] =
                await Promise.all([
                    db.all('SELECT name FROM domains WHERE is_active = true ORDER BY name'),
                    db.all(
                        'SELECT sd.id, sd.name, d.name AS domain_name FROM sub_domains sd JOIN domains d ON d.id = sd.domain_id WHERE sd.is_active = true AND d.is_active = true ORDER BY d.name, sd.position'
                    ),
                    // Only families that actually contain an active role with requirements —
                    // empty families would just render an empty matrix when selected.
                    db.all(`SELECT DISTINCT rf.id, rf.name, rf.origin FROM role_families rf
                        JOIN roles r ON r.role_family_id = rf.id AND r.is_active = true
                        JOIN role_skill_requirements x ON x.role_id = r.id
                        ORDER BY rf.origin, rf.name`),
                    db.all(
                        'SELECT DISTINCT r.id, r.name FROM roles r JOIN role_skill_requirements x ON x.role_id = r.id WHERE r.is_active = true ORDER BY r.name'
                    ),
                    // Filter dropdowns match employees by NAME, and the same department/
                    // service name legitimately exists under many sites — so list each
                    // name once (DISTINCT) instead of once per parent (was showing e.g.
                    // "IT" 9x and "IT Operations" 6x).
                    db.all('SELECT DISTINCT name FROM sites WHERE is_active = true ORDER BY name'),
                    db.all(
                        'SELECT DISTINCT name FROM departments WHERE is_active = true ORDER BY name'
                    ),
                    db.all(
                        'SELECT DISTINCT name FROM services WHERE is_active = true ORDER BY name'
                    ),
                ]);

            // The FIT table measures occupants against their FULL role benchmark, so it
            // uses the user's real filters unchanged. The MATRIX can be huge (roles×skills),
            // so it gets a bounding default pillar ONLY on a fresh visit (no explicit
            // pillar choice in the query) — kept in a SEPARATE object so it never narrows
            // the fit table. Once the user submits the form, "All pillars" (domainName
            // present but empty) is an explicit choice and the matrix spans every pillar.
            const matrixFilters = { ...filters };
            let matrixDefaultPillar = null;
            const explicitAllPillars = req.query.domainName !== undefined;
            if (
                !explicitAllPillars &&
                !filters.domainName &&
                !filters.roleFamilyId &&
                !filters.roleName &&
                !filters.subDomainId &&
                !filters.skillQuery
            ) {
                matrixDefaultPillar = pillars[0] && pillars[0].name;
                matrixFilters.domainName = matrixDefaultPillar;
            }

            const [matrix, fit] = await Promise.all([
                BenchmarkModel.getMatrix(matrixFilters),
                BenchmarkModel.getFit(filters),
            ]);

            // CSV export of the benchmark matrix (Pillar, Sub-Domain, Skill, Category, Δ, then one column per role).
            if (req.query.format === 'csv') {
                // csvCell also neutralizes leading =,+,-,@ (formula injection) — the old
                // local esc only quoted commas/quotes, so a crafted skill/role name
                // (e.g. from Skill-Matrix import) executed on open in Excel.
                const header = [
                    'Pillar',
                    'Sub-Domain',
                    'Skill',
                    'Category',
                    'Variation',
                    ...matrix.roles.map((r) => r.name),
                ];
                const lines = [header.map(csvCell).join(',')];
                for (const d of matrix.domains)
                    for (const sd of d.subs)
                        for (const sk of sd.skills) {
                            const row = [
                                d.name,
                                sd.name,
                                sk.name,
                                sk.category,
                                sk.variation,
                                ...matrix.roles.map((r) =>
                                    sk.cells[r.id] ? sk.cells[r.id].level : ''
                                ),
                            ];
                            lines.push(row.map(csvCell).join(','));
                        }
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', 'attachment; filename="benchmark-matrix.csv"');
                // UTF-8 BOM so Excel opens accented names correctly instead of
                // mojibake (e.g. "Morèn" → "KonÃ©"), like every other CSV export.
                return res.send('﻿' + lines.join('\r\n'));
            }

            res.render('pages/benchmark/index', {
                matrixFilters,
                matrixDefaultPillar,
                title: req.t ? req.t('chrome:pt_benchmark') : 'Benchmark',
                filters,
                query: req.query,
                pillars,
                subDomains,
                roleFamilies,
                roles,
                sites,
                departments,
                services,
                matrix,
                fit,
            });
        } catch (err) {
            console.error('Benchmark index error:', err);
            req.flash('error', req.t ? req.t('flash:bench_load_error') : 'Error loading benchmark');
            res.redirect('/dashboard');
        }
    }

    // Role drill-through: occupant×skill breakdown + succession candidates.
    async roleDetail(req, res) {
        try {
            const roleId = parseInt(req.params.id, 10);
            if (!roleId) return res.redirect('/benchmark');
            const role = await db.get('SELECT id, name, role_family_id FROM roles WHERE id = ?', [
                roleId,
            ]);
            if (!role) {
                req.flash('error', req.t ? req.t('flash:role_not_found') : 'Role not found');
                return res.redirect('/benchmark');
            }
            const filters = this._buildFilters(req);
            const [occ, candidates, fit, history] = await Promise.all([
                BenchmarkModel.getRoleOccupants(roleId, filters),
                BenchmarkModel.getRoleCandidates(roleId, filters, 25),
                BenchmarkModel.getFit({ ...filters, roleName: role.name }),
                // The MOST RECENT 180 days, then chronological for the chart.
                // `ORDER BY snapshot_date ASC LIMIT 180` took the OLDEST 180, so
                // once a role had more than 180 daily snapshots the trend froze on
                // its first six months and never showed a recent point again.
                db
                    .all(
                        `SELECT day, fit, coverage, critical_fit FROM (
                         SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS day, fit, coverage, critical_fit, snapshot_date
                           FROM benchmark_fit_history WHERE role_id = ?
                          ORDER BY snapshot_date DESC LIMIT 180
                     ) t ORDER BY snapshot_date ASC`,
                        [roleId]
                    )
                    .catch(() => []),
            ]);
            const summary = (fit || []).find((f) => String(f.roleId) === String(roleId)) || null;
            res.render('pages/benchmark/role', {
                title: (req.t ? req.t('chrome:pt_benchmark') : 'Benchmark') + ' · ' + role.name,
                role,
                summary,
                occupants: occ.occupants,
                domains: occ.domains,
                candidates,
                fitHistory: history,
            });
        } catch (err) {
            console.error('Benchmark role detail error:', err);
            req.flash(
                'error',
                req.t ? req.t('flash:bench_role_load_error') : 'Error loading role benchmark'
            );
            res.redirect('/benchmark');
        }
    }

    // JSON fit — used by the dashboard "Benchmark Fit by Role" table.
    async getFit(req, res) {
        try {
            const fit = await BenchmarkModel.getFit(this._buildFilters(req));
            res.json(fit);
        } catch (err) {
            console.error('Benchmark fit error:', err);
            res.status(500).json({ error: 'Error loading benchmark fit' });
        }
    }
}

module.exports = new BenchmarkController();
