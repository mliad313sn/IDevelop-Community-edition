'use strict';
const db = require('../config/database');
const RBACService = require('../services/RBACService');
const EmployeeModel = require('../models/EmployeeModel');

// Slim org-chart projection. Raw snake_case SQL (the compat layer maps result
// keys back to camelCase); we read both forms defensively.
const BASE_SQL = `
    SELECT e.id, e.first_name, e.last_name, e.employee_number,
           e.manager_id, e.supervisor_id, e.manager_type, e.is_org_root,
           r.name AS role_name, s.name AS site_name,
           d.name AS department_name, sv.name AS service_name
    FROM employees e
    LEFT JOIN roles r        ON r.id  = e.role_id
    LEFT JOIN sites s        ON s.id  = e.site_id
    LEFT JOIN departments d  ON d.id  = e.department_id
    LEFT JOIN services sv    ON sv.id = e.service_id
    WHERE e.is_active`;

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchByIds(ids) {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return db.all(`${BASE_SQL} AND e.id IN (${ph}) ORDER BY e.last_name, e.first_name`, ids);
}

class OrgChartController {
    page(req, res) {
        res.render('pages/org-chart/index', {
            title: req.t ? req.t('chrome:pt_org_chart') : 'Org Chart',
        });
    }

    // Scoped flat node list; the client builds the manager- or supervisor-line tree.
    async data(req, res) {
        try {
            const user = req.user;
            let rows;
            let scope;
            if (RBACService.isSuperAdmin(user)) {
                rows = await db.all(`${BASE_SQL} ORDER BY e.last_name, e.first_name`);
                scope = 'all';
            } else if (user && user.userType === 'admin') {
                const scoped = await RBACService.getFilteredEmployees(user);
                const ids = new Set((scoped || []).map((e) => num(e.id)).filter(Boolean));
                // 3.23.18: the clearance PLUS the reporting line of the person
                // behind the account (admins.linked_employee_id) and of anyone this
                // account is named manager of — the union RBACService.scopeFilter
                // gives the review console. The chart used to draw the clearance
                // alone, so a manager signed in on their admin account saw a chart
                // without their own team while the console listed it. The person
                // themselves is drawn too (as on the governed branch) so their team
                // hangs from them instead of floating as "outside the scope".
                const GovernanceService = require('../services/GovernanceService');
                for (const id of await GovernanceService.lineAuthorityEmployeeIds(user)) {
                    const n = num(id);
                    if (n) ids.add(n);
                }
                const personId = num(await GovernanceService.actingPersonId(user));
                if (personId) ids.add(personId);
                rows = await fetchByIds([...ids]);
                scope = 'admin-scope';
            } else {
                // manager / employee: their own governed sub-tree plus themselves
                if (!user) return res.status(401).json({ error: 'Not authenticated' });
                const ids = await EmployeeModel.findGovernedIds(user.id);
                ids.push(num(user.id));
                rows = await fetchByIds([...new Set(ids.filter(Boolean))]);
                scope = 'governed';
            }

            // Who is reading. Only meaningful for the governed perimeter: there the
            // reader is one of the nodes (the apex of their own sub-tree) and the
            // client needs to know which one — a report whose manager sits just
            // ABOVE the perimeter is still attached to the reader by the other
            // line, not "unassigned". An admin is not a node (admin ids live in
            // another id-space that overlaps employee ids), so viewerId is null
            // for 'all' and 'admin-scope'. It reveals nothing beyond the list
            // itself: the reader's own row is already in it.
            const viewerId = scope === 'governed' ? num(user.id) : null;

            const nodes = rows.map((e) => {
                const mtype = e.managerType || e.manager_type;
                const id = num(e.id);
                return {
                    id,
                    // The flag travels WITH the node so a consumer that only has the
                    // node list (a test, a probe) draws the same chart as the page.
                    ...(viewerId != null && id === viewerId ? { isViewer: true } : {}),
                    name:
                        `${e.firstName || e.first_name || ''} ${e.lastName || e.last_name || ''}`.trim() ||
                        '(unnamed)',
                    number: e.employeeNumber || e.employee_number || '',
                    role: e.roleName || e.role_name || '',
                    site: e.siteName || e.site_name || '—',
                    department: e.departmentName || e.department_name || '—',
                    service: e.serviceName || e.service_name || '—',
                    org: [
                        e.serviceName || e.service_name,
                        e.departmentName || e.department_name,
                        e.siteName || e.site_name,
                    ]
                        .filter(Boolean)
                        .join(' · '),
                    // Manager line only links employee→employee (manager_type='employee');
                    // an admin-typed manager is not an org-chart node.
                    managerId: mtype === 'employee' ? num(e.managerId ?? e.manager_id) : null,
                    supervisorId: num(e.supervisorId ?? e.supervisor_id),
                    isRoot: Boolean(e.isOrgRoot ?? e.is_org_root),
                };
            });

            res.json({ nodes, scope, count: nodes.length, viewerId });
        } catch (err) {
            console.error('Org chart data error:', err);
            res.status(500).json({ error: 'Failed to load org chart' });
        }
    }
}

module.exports = new OrgChartController();
