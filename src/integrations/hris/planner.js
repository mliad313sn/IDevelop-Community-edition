'use strict';

/**
 * HRIS planner — PURE functions (no database): value mapping and plan
 * computation over a context snapshot loaded by HrisSyncService.loadContext.
 * Kept free of I/O so the joiner / mover / leaver rules and the mass-leaver
 * guard are unit-tested directly.
 *
 * MAPPING RULES (the same for every connector and for SCIM placement):
 *   1. an explicit value mapping (hris_value_mappings) wins;
 *   2. otherwise, when matchByName is on (default), a UNIQUE active local unit
 *      whose name or code equals the value (case-, accent- and
 *      space-insensitive) — a department is only searched inside the mapped
 *      site when the site is known;
 *   3. a service may also be found through the DEPARTMENT value (explicit
 *      service mapping keyed on the department name), and a department with
 *      exactly ONE active service takes that service;
 *   4. anything else is UNMAPPED: reported with its count, never invented.
 *
 * PLAN (per record, keyed on the external id):
 *   linked (hris_links) ........ compared: mover (site / department / service /
 *                                role / supervisor changed), profile update
 *                                (name / e-mail), leaver (ended), or unchanged;
 *   not linked, matching ....... an existing employee with the same employee
 *                                number (or the only one with that e-mail) is
 *                                LINKED, then compared like a linked one;
 *   not linked, new, active .... joiner (blocked when a value does not map);
 *   linked, absent (full mode) . leaver (reason 'missing').
 *   A person whose start date is in the future is 'upcoming', not a joiner yet.
 *
 * GUARD: leavers / active population > guardPct (10 % by default), or a FULL
 * export with no record at all while people are linked → the plan is marked
 * tripped and must not be applied.
 */

function norm(v) {
    return String(v == null ? '' : v)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Index the reference data once. */
function buildContext(raw = {}) {
    const byId = (list) => new Map((list || []).map((x) => [Number(x.id), x]));
    const active = (x) => x && x.isActive !== false;
    const ctx = {
        provider: raw.provider || 'csv',
        options: {
            matchByName: true,
            mode: 'full',
            guardPct: 10,
            now: new Date(),
            ...(raw.options || {}),
        },
        sites: byId(raw.sites),
        departments: byId(raw.departments),
        services: byId(raw.services),
        roles: byId(raw.roles),
        employees: byId(raw.employees),
        mappings: { site: new Map(), department: new Map(), service: new Map(), role: new Map() },
        linkByExt: new Map(),
        linkByEmp: new Map(),
    };
    for (const m of raw.mappings || []) {
        const kind = m.kind;
        if (!ctx.mappings[kind]) continue;
        ctx.mappings[kind].set(norm(m.externalKey || m.externalValue), Number(m.targetId));
    }
    for (const l of raw.links || []) {
        ctx.linkByExt.set(String(l.externalId), Number(l.employeeId));
        ctx.linkByEmp.set(Number(l.employeeId), String(l.externalId));
    }
    ctx.activeOf = active;
    ctx.servicesOfDept = new Map();
    for (const s of ctx.services.values()) {
        if (!active(s)) continue;
        const k = Number(s.departmentId);
        if (!ctx.servicesOfDept.has(k)) ctx.servicesOfDept.set(k, []);
        ctx.servicesOfDept.get(k).push(s);
    }
    ctx.byNumber = new Map();
    ctx.byEmail = new Map();
    for (const e of ctx.employees.values()) {
        if (e.employeeNumber) ctx.byNumber.set(String(e.employeeNumber), e);
        if (e.email) {
            const k = String(e.email).toLowerCase();
            if (!ctx.byEmail.has(k)) ctx.byEmail.set(k, []);
            ctx.byEmail.get(k).push(e);
        }
    }
    return ctx;
}

const LISTS = { site: 'sites', department: 'departments', service: 'services', role: 'roles' };

/**
 * One external value → a local unit id, or null. `filter` narrows the
 * name-match candidates (e.g. departments of the known site).
 */
function lookup(ctx, kind, value, filter = null) {
    if (value == null || String(value).trim() === '') return null;
    const key = norm(value);
    const table = ctx[LISTS[kind]];
    const mapped = ctx.mappings[kind] && ctx.mappings[kind].get(key);
    if (mapped != null) {
        const t = table.get(Number(mapped));
        return t && ctx.activeOf(t) ? Number(t.id) : null;
    }
    if (!ctx.options.matchByName) return null;
    const hits = [...table.values()].filter(
        (t) =>
            ctx.activeOf(t) &&
            (norm(t.name) === key || (t.code && norm(t.code) === key)) &&
            (!filter || filter(t))
    );
    return hits.length === 1 ? Number(hits[0].id) : null;
}

/**
 * Resolve site / department / service / role for one normalised record.
 * @returns {{siteId, departmentId, serviceId, roleId, complete:boolean,
 *            unmapped:Array<{field,value}>, errors:string[]}}
 */
function resolvePlacement(rec, ctx) {
    const unmapped = [];
    const errors = [];
    const siteId = rec.site ? lookup(ctx, 'site', rec.site) : null;
    const deptOf = (svcId) => {
        const s = ctx.services.get(Number(svcId));
        return s ? Number(s.departmentId) : null;
    };
    const siteOfDept = (deptId) => {
        const d = ctx.departments.get(Number(deptId));
        return d ? Number(d.siteId) : null;
    };

    let serviceId = rec.service
        ? lookup(
              ctx,
              'service',
              rec.service,
              (s) => !siteId || siteOfDept(s.departmentId) === siteId
          )
        : null;
    if (!serviceId && rec.department) {
        // An explicit service mapping keyed on the department value.
        const viaDept = ctx.mappings.service.get(norm(rec.department));
        const t = viaDept != null ? ctx.services.get(Number(viaDept)) : null;
        if (t && ctx.activeOf(t)) serviceId = Number(t.id);
    }
    let departmentId = serviceId
        ? deptOf(serviceId)
        : rec.department
          ? lookup(ctx, 'department', rec.department, (d) => !siteId || Number(d.siteId) === siteId)
          : null;
    if (!serviceId && departmentId) {
        const only = ctx.servicesOfDept.get(Number(departmentId)) || [];
        if (only.length === 1) serviceId = Number(only[0].id);
    }
    const placedSite = departmentId ? siteOfDept(departmentId) : siteId;

    if (!departmentId) {
        if (rec.department) unmapped.push({ field: 'department', value: rec.department });
        else errors.push('department_missing');
        if (rec.site && !siteId) unmapped.push({ field: 'site', value: rec.site });
    }
    if (departmentId && !serviceId) {
        if (rec.service) unmapped.push({ field: 'service', value: rec.service });
        else unmapped.push({ field: 'service', value: rec.department });
    }
    if (rec.service && !serviceId && !departmentId)
        unmapped.push({ field: 'service', value: rec.service });
    if (siteId && departmentId && placedSite !== siteId) {
        errors.push('site_mismatch');
        departmentId = null;
        serviceId = null;
    }
    const roleId = rec.jobTitle ? lookup(ctx, 'role', rec.jobTitle) : null;
    if (rec.jobTitle && !roleId) unmapped.push({ field: 'role', value: rec.jobTitle });
    if (!rec.jobTitle) errors.push('role_missing');

    const orgComplete = Boolean(departmentId && serviceId && placedSite);
    return {
        siteId: orgComplete ? placedSite : null,
        departmentId: orgComplete ? departmentId : null,
        serviceId: orgComplete ? serviceId : null,
        roleId,
        orgComplete,
        complete: orgComplete && Boolean(roleId),
        unmapped: dedupeUnmapped(unmapped),
        errors,
    };
}

function dedupeUnmapped(list) {
    const seen = new Set();
    return list.filter((u) => {
        const k = `${u.field}|${norm(u.value)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function displayName(r) {
    return [r.firstName, r.lastName].filter(Boolean).join(' ') || r.externalId;
}

/** The plan. Pure: same records + same context → same plan. */
function computePlan(records, ctx) {
    const today = ctx.options.now.toISOString().slice(0, 10);
    const plan = {
        joiners: [],
        movers: [],
        updates: [],
        leavers: [],
        links: [],
        blocked: [],
        upcoming: [],
        review: [],
        errors: [],
        unmappedIndex: new Map(),
        unchanged: 0,
        ignored: 0,
    };
    const noteUnmapped = (u, who) => {
        const k = `${u.field}|${norm(u.value)}`;
        const cur = plan.unmappedIndex.get(k) || {
            field: u.field,
            value: u.value,
            count: 0,
            people: [],
        };
        cur.count++;
        if (cur.people.length < 5) cur.people.push(who);
        plan.unmappedIndex.set(k, cur);
    };

    // 1) de-duplicate the export on the external id.
    const seen = new Set();
    const recs = [];
    for (const r of records || []) {
        if (!r || !r.externalId) {
            plan.errors.push({ row: r && r.row, code: 'external_id_missing' });
            continue;
        }
        if (seen.has(r.externalId)) {
            plan.errors.push({
                row: r.row,
                externalId: r.externalId,
                code: 'duplicate_external_id',
            });
            continue;
        }
        seen.add(r.externalId);
        recs.push(r);
    }

    // 2) link: existing link, else employee number, else a unique e-mail.
    const linkOf = new Map(); // externalId -> employeeId
    const claimed = new Set(ctx.linkByEmp.keys());
    for (const r of recs) {
        const linked = ctx.linkByExt.get(r.externalId);
        if (linked != null && ctx.employees.has(linked)) {
            linkOf.set(r.externalId, linked);
            continue;
        }
        let match = null;
        let by = null;
        if (r.employeeNumber) {
            const e = ctx.byNumber.get(String(r.employeeNumber));
            if (e && !claimed.has(Number(e.id))) {
                match = e;
                by = 'employee_number';
            }
        }
        if (!match && r.email) {
            const list = (ctx.byEmail.get(r.email) || []).filter(
                (e) => !claimed.has(Number(e.id)) && !e.cancelledAt && !e.erasedAt
            );
            if (list.length === 1) {
                match = list[0];
                by = 'email';
            } else if (list.length > 1) {
                plan.review.push({
                    externalId: r.externalId,
                    name: displayName(r),
                    reason: 'email_ambiguous',
                });
                continue;
            }
        }
        if (match) {
            claimed.add(Number(match.id));
            linkOf.set(r.externalId, Number(match.id));
            plan.links.push({
                externalId: r.externalId,
                employeeId: Number(match.id),
                name: displayName(r),
                by,
            });
        }
    }

    // External id → employee id, including the joiners of this batch (resolved
    // at apply time) — the manager of a joiner may be another joiner.
    const joinerIds = new Set();
    const managerOf = (r) => {
        const m = r.managerExternalId;
        if (!m || m === r.externalId) return { none: true };
        if (linkOf.has(m)) return { employeeId: linkOf.get(m) };
        const l = ctx.linkByExt.get(m);
        if (l != null && ctx.employees.has(l)) return { employeeId: l };
        if (seen.has(m)) return { pendingExternalId: m };
        return { unmapped: true };
    };

    for (const r of recs) {
        const who = displayName(r);
        const empId = linkOf.get(r.externalId);
        if (empId == null) {
            if (r.status !== 'active') {
                plan.ignored++;
                continue;
            }
            if (r.startDate && r.startDate > today) {
                plan.upcoming.push({ externalId: r.externalId, name: who, startDate: r.startDate });
                continue;
            }
            const pl = resolvePlacement(r, ctx);
            pl.unmapped.forEach((u) => noteUnmapped(u, who));
            const reasons = [...pl.errors];
            if (!r.firstName || !r.lastName) reasons.push('name_missing');
            if (!pl.complete) pl.unmapped.forEach((u) => reasons.push(`unmapped_${u.field}`));
            if (!pl.complete && !reasons.length) reasons.push('placement_incomplete');
            const mgr = managerOf(r);
            if (mgr.unmapped) noteUnmapped({ field: 'manager', value: r.managerExternalId }, who);
            if (reasons.length) {
                plan.blocked.push({
                    externalId: r.externalId,
                    name: who,
                    reasons: [...new Set(reasons)],
                });
                continue;
            }
            joinerIds.add(r.externalId);
            plan.joiners.push({
                externalId: r.externalId,
                employeeNumber: r.employeeNumber,
                firstName: r.firstName,
                lastName: r.lastName,
                email: r.email && EMAIL_RE.test(r.email) ? r.email : null,
                emailRejected: Boolean(r.email && !EMAIL_RE.test(r.email)),
                siteId: pl.siteId,
                departmentId: pl.departmentId,
                serviceId: pl.serviceId,
                roleId: pl.roleId,
                supervisorId: mgr.employeeId || null,
                managerPendingExternalId: mgr.pendingExternalId || null,
                name: who,
            });
            continue;
        }

        const emp = ctx.employees.get(empId);
        if (!emp || emp.cancelledAt || emp.erasedAt) {
            plan.ignored++;
            continue;
        }
        if (r.status !== 'active') {
            if (emp.isActive) {
                plan.leavers.push({
                    externalId: r.externalId,
                    employeeId: empId,
                    name: who,
                    reason: 'ended',
                    endDate: r.endDate,
                });
            } else plan.unchanged++;
            continue;
        }
        if (!emp.isActive) {
            plan.review.push({
                externalId: r.externalId,
                employeeId: empId,
                name: who,
                reason: 'inactive_here',
            });
            continue;
        }

        const pl = resolvePlacement(r, ctx);
        pl.unmapped.forEach((u) => noteUnmapped(u, who));
        const changes = {};
        const set = (field, to) => {
            const from = emp[field] == null ? null : Number(emp[field]);
            if (to != null && from !== Number(to)) changes[field] = { from, to: Number(to) };
        };
        if (pl.orgComplete) {
            set('siteId', pl.siteId);
            set('departmentId', pl.departmentId);
            set('serviceId', pl.serviceId);
        }
        if (pl.roleId) set('roleId', pl.roleId);
        const mgr = managerOf(r);
        let managerPendingExternalId = null;
        if (mgr.employeeId && mgr.employeeId !== empId) set('supervisorId', mgr.employeeId);
        else if (mgr.pendingExternalId) managerPendingExternalId = mgr.pendingExternalId;
        else if (mgr.unmapped) noteUnmapped({ field: 'manager', value: r.managerExternalId }, who);

        const profile = {};
        if (r.firstName && r.firstName !== emp.firstName) profile.firstName = r.firstName;
        if (r.lastName && r.lastName !== emp.lastName) profile.lastName = r.lastName;
        if (r.email && EMAIL_RE.test(r.email) && String(emp.email || '').toLowerCase() !== r.email)
            profile.email = r.email;

        if (Object.keys(changes).length || managerPendingExternalId) {
            plan.movers.push({
                externalId: r.externalId,
                employeeId: empId,
                name: who,
                changes,
                managerPendingExternalId,
                profile,
            });
        } else if (Object.keys(profile).length) {
            plan.updates.push({ externalId: r.externalId, employeeId: empId, name: who, profile });
        } else plan.unchanged++;
    }

    // A manager who is a joiner of THIS batch is set after the joiner exists;
    // one that is not a joiner after all (blocked, upcoming) changes nothing.
    plan.movers = plan.movers.filter((m) => {
        if (m.managerPendingExternalId && !joinerIds.has(m.managerPendingExternalId))
            m.managerPendingExternalId = null;
        if (Object.keys(m.changes).length || m.managerPendingExternalId) return true;
        if (Object.keys(m.profile).length) plan.updates.push({ ...m, changes: undefined });
        else plan.unchanged++;
        return false;
    });

    // 3) linked people absent from a FULL export.
    if (ctx.options.mode !== 'delta') {
        for (const [ext, empId] of ctx.linkByExt) {
            if (seen.has(ext)) continue;
            const emp = ctx.employees.get(empId);
            if (!emp || !emp.isActive || emp.cancelledAt || emp.erasedAt) continue;
            plan.leavers.push({
                externalId: ext,
                employeeId: empId,
                name: [emp.firstName, emp.lastName].filter(Boolean).join(' '),
                reason: 'missing',
                endDate: null,
            });
        }
    }

    plan.guard = evaluateGuard(plan.leavers.length, recs.length, ctx);
    plan.unmapped = [...plan.unmappedIndex.values()].sort(
        (a, b) => b.count - a.count || a.field.localeCompare(b.field)
    );
    delete plan.unmappedIndex;
    plan.counts = {
        fetched: (records || []).length,
        joiners: plan.joiners.length,
        movers: plan.movers.length,
        updates: plan.updates.length,
        leavers: plan.leavers.length,
        links: plan.links.length,
        blocked: plan.blocked.length,
        upcoming: plan.upcoming.length,
        review: plan.review.length,
        unmapped: plan.unmapped.length,
        errors: plan.errors.length,
        unchanged: plan.unchanged,
        ignored: plan.ignored,
    };
    return plan;
}

/**
 * The mass-leaver guard. Population = active, non-voided employees. Tripped
 * when the share of leavers exceeds guardPct, or when a FULL export is empty
 * while people are linked (an empty file is a broken export, not a layoff).
 */
function evaluateGuard(leavers, recordCount, ctx) {
    const population = [...ctx.employees.values()].filter(
        (e) => e.isActive && !e.cancelledAt && !e.erasedAt
    ).length;
    const limitPct = Number(ctx.options.guardPct) > 0 ? Number(ctx.options.guardPct) : 10;
    const pct = population ? Math.round((leavers / population) * 1000) / 10 : 0;
    let reason = null;
    if (ctx.options.mode !== 'delta' && recordCount === 0 && ctx.linkByExt.size > 0)
        reason = 'empty_export';
    else if (population && (leavers / population) * 100 > limitPct) reason = 'too_many_leavers';
    return { leavers, population, pct, limitPct, tripped: Boolean(reason), reason };
}

module.exports = {
    norm,
    buildContext,
    lookup,
    resolvePlacement,
    computePlan,
    evaluateGuard,
    EMAIL_RE,
};
