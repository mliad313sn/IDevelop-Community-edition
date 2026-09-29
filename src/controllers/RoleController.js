const RoleModel = require('../models/RoleModel');
const RoleSkillRequirementModel = require('../models/RoleSkillRequirementModel');
const SkillModel = require('../models/SkillModel');
const EmployeeModel = require('../models/EmployeeModel');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');
const ReadinessService = require('../services/ReadinessService');
const db = require('../config/database');
const { roleValidation } = require('../utils/validators');
const { bc } = require('../utils/breadcrumbLabel');

// Largest department-designed requirement set seen is ~161 skills for one role;
// this cap only exists to bound a single request, never to trim the set.
const MAX_BULK_REQUIREMENTS = 1000;
const MAX_REQUIRED_LEVEL = 4;

const toCriticalBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/**
 * Bulk re-levelling of a role's skill requirements — ONE request for the whole
 * table instead of one modal + one full page reload per row (161 of them on the
 * largest role). Reached through the collection endpoint with a `bulk` array; the
 * per-requirement endpoint below is unchanged for single edits.
 *
 * Every id is checked to belong to THIS role before anything is written (an IDOR
 * guard: the ids come from the client), levels are range-checked against the 0-4
 * scale, and the whole batch commits or rolls back as one transaction so a role
 * can never end up half re-levelled.
 */
async function bulkUpdateRequirements(req, res) {
    const roleId = parseInt(req.params.id, 10);
    const items = req.body.bulk;
    const t = (key, fallback, vars) => (req.t ? req.t(key, vars) : fallback);

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: t('admin:org_req_no_changes', 'No change to save.') });
    }
    if (items.length > MAX_BULK_REQUIREMENTS) {
        return res.status(413).json({
            error: t('admin:org_req_bulk_too_many', 'Too many requirements in a single request.'),
        });
    }

    const parsed = [];
    for (const raw of items) {
        const id = Number(raw && raw.id);
        const level = Number(raw && raw.requiredLevel);
        if (
            !Number.isInteger(id) ||
            id <= 0 ||
            !Number.isInteger(level) ||
            level < 0 ||
            level > MAX_REQUIRED_LEVEL
        ) {
            return res.status(400).json({
                error: t(
                    'admin:org_req_bulk_invalid',
                    'Invalid change: the required level must be between 0 and 4.'
                ),
            });
        }
        parsed.push({ id, level, critical: toCriticalBool(raw.isCritical) });
    }

    const existing = await RoleSkillRequirementModel.findByRoleId(roleId);
    const owned = new Map(existing.map((r) => [Number(r.id), r]));
    if (parsed.some((p) => !owned.has(p.id))) {
        return res.status(400).json({
            error: t(
                'admin:org_req_bulk_foreign',
                'One of the requirements does not belong to this role.'
            ),
        });
    }

    // Only rows that actually differ are written — a no-op save must not churn
    // the table (or the audit trail) with 161 identical updates.
    const changed = parsed.filter((p) => {
        const cur = owned.get(p.id);
        return (
            Number(cur.requiredLevel) !== p.level || toCriticalBool(cur.isCritical) !== p.critical
        );
    });

    if (changed.length > 0) {
        await db.runTransaction(async () => {
            for (const p of changed) {
                await db.run(
                    `UPDATE role_skill_requirements
                        SET required_level = ?, is_critical = ?
                      WHERE id = ? AND role_id = ?`,
                    [p.level, p.critical, p.id, roleId]
                );
            }
        });

        const sample = changed
            .slice(0, 5)
            .map((p) => `${owned.get(p.id).skillName}→${p.level}${p.critical ? '*' : ''}`)
            .join(', ');
        await LogService.log({
            adminId: req.user.id,
            action: 'ROLE_REQUIREMENTS_BULK_UPDATED',
            entityType: 'role',
            entityId: roleId,
            details:
                `Bulk re-levelled ${changed.length} of ${existing.length} requirements` +
                (sample ? ` (e.g. ${sample}${changed.length > 5 ? ', …' : ''})` : ''),
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
    }

    return res.json({ success: true, updated: changed.length, submitted: parsed.length });
}

class RoleController {
    async index(req, res) {
        try {
            // Read page: a view-only delegate (view_roles) may SEE the catalog;
            // manage_roles implies view_roles so managers/superadmins still pass.
            // Write actions below keep their manage_roles guard.
            if (!RBACService.hasPermission(req.user, 'view_roles')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:role_manage_superadmin')
                        : 'You do not have permission to view roles.'
                );
                return res.redirect('/dashboard');
            }

            const roles = await RoleModel.findAll({ isActive: 1 }, 'name ASC');
            const families = await db.all('SELECT id, name FROM role_families ORDER BY name');
            const familyById = new Map(families.map((f) => [Number(f.id), f.name]));

            // Employee + requirement counts for ALL roles in two grouped queries
            // (was 2 queries per role — an N+1 that scaled with the catalog).
            const empCounts = new Map(
                (
                    await db.all(
                        'SELECT role_id, COUNT(*)::int AS n FROM employees WHERE is_active = true AND role_id IS NOT NULL GROUP BY role_id'
                    )
                ).map((r) => [Number(r.roleId ?? r.role_id), Number(r.n)])
            );
            const reqCounts = new Map(
                (
                    await db.all(
                        'SELECT role_id, COUNT(*)::int AS n FROM role_skill_requirements GROUP BY role_id'
                    )
                ).map((r) => [Number(r.roleId ?? r.role_id), Number(r.n)])
            );
            const rolesWithStats = roles.map((role) => ({
                ...role,
                familyName: role.roleFamilyId
                    ? familyById.get(Number(role.roleFamilyId)) || null
                    : null,
                employeeCount: empCounts.get(Number(role.id)) || 0,
                requirementCount: reqCounts.get(Number(role.id)) || 0,
            }));

            res.render('pages/roles/index', {
                title: req.t ? req.t('chrome:pt_roles') : 'Roles',
                roles: rolesWithStats,
                families,
                // the crumbs were English literals on a page whose <title> and
                // <h1> already said « Postes ». views/partials/breadcrumbs.ejs prints the
                // label as-is, so a crumb is only translated if the controller translates it.
                breadcrumbs: [
                    {
                        label: bc(req, 'admin:set_bc_configuration', 'Configuration'),
                        url: '/organization',
                    },
                    { label: bc(req, 'chrome:pt_roles', 'Roles') },
                ],
            });
        } catch (error) {
            console.error('Role index error:', error);
            req.flash('error', req.t ? req.t('flash:role_list_load_error') : 'Error loading roles');
            res.redirect('/dashboard');
        }
    }

    async show(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'view_roles')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:role_view_superadmin')
                        : 'You do not have permission to view role details.'
                );
                return res.redirect('/dashboard');
            }

            const role = await RoleModel.findById(id);
            if (!role) {
                req.flash('error', req.t ? req.t('flash:role_not_found') : 'Role not found');
                return res.redirect('/roles');
            }

            const requirements = await RoleSkillRequirementModel.findByRoleId(id);
            const allSkills = await SkillModel.findWithDomain();

            // Get employee count
            const employeeCount = await db.get(
                'SELECT COUNT(*) as count FROM employees WHERE roleId = ? AND isActive = 1',
                [id]
            );

            // Get employees with this role for statistics
            const employees = await EmployeeModel.findWithOrganization({
                roleId: parseInt(id),
                isActive: 1,
            });

            // Calculate readiness statistics for this role
            let roleReadinessStats = {
                totalEmployees: employees.length,
                readyCount: 0,
                notReadyCount: 0,
                averageReadiness: 0,
            };

            if (employees.length > 0) {
                // One bulk pass instead of 3 queries per employee (N+1).
                const readinessMap = await ReadinessService.calculateReadinessMap(employees);
                let totalReadiness = 0;
                for (const employee of employees) {
                    const readiness = readinessMap[employee.id];
                    if (readiness) {
                        totalReadiness += readiness.readinessPercent;
                        if (readiness.isReady) {
                            roleReadinessStats.readyCount++;
                        } else {
                            roleReadinessStats.notReadyCount++;
                        }
                    }
                }
                roleReadinessStats.averageReadiness = Math.round(totalReadiness / employees.length);
            }

            res.render('pages/roles/show', {
                title: req.t
                    ? req.t('chrome:pt_role_detail', { name: role.name })
                    : `Role: ${role.name}`,
                role,
                requirements,
                allSkills,
                employeeCount: employeeCount?.count || 0,
                roleReadinessStats,
                // same class as the list page above.
                breadcrumbs: [
                    {
                        label: bc(req, 'admin:set_bc_configuration', 'Configuration'),
                        url: '/organization',
                    },
                    { label: bc(req, 'chrome:pt_roles', 'Roles'), url: '/roles' },
                    { label: role.name },
                ],
            });
        } catch (error) {
            console.error('Role show error:', error);
            req.flash('error', req.t ? req.t('flash:role_load_error') : 'Error loading role');
            res.redirect('/roles');
        }
    }

    async create(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'manage_roles')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:role_create_superadmin')
                        : 'Only SuperAdmins can create roles'
                );
                return res.redirect('/roles');
            }

            await RoleModel.create({
                name: req.body.name.trim(),
                description: req.body.description?.trim() || null,
                roleFamilyId: req.body.roleFamilyId ? parseInt(req.body.roleFamilyId) : null,
                isActive: 1,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'ROLE_CREATED',
                entityType: 'role',
                details: `Created role: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash('success', req.t ? req.t('flash:role_created') : 'Role created successfully');
            res.redirect('/roles');
        } catch (error) {
            console.error('Role create error:', error);
            req.flash('error', req.t ? req.t('flash:role_create_error') : 'Error creating role');
            res.redirect('/roles');
        }
    }

    /**
     * Duplicate an existing role: copies name (uniquified), description, role
     * family AND every skill requirement (level + critical flag), then lands on
     * the new role's page so the admin only has to adjust the levels that differ
     * instead of rebuilding the whole role from scratch.
     */
    async duplicate(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_roles')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:role_create_superadmin')
                        : 'Only SuperAdmins can create roles'
                );
                return res.redirect('/roles');
            }

            const source = await RoleModel.findById(parseInt(id));
            if (!source) {
                req.flash('error', req.t ? req.t('flash:role_not_found') : 'Role not found');
                return res.redirect('/roles');
            }

            // Pick a unique name: "X (copy)", then "X (copy 2)", ...
            let newName = `${source.name} (copy)`;
            let n = 2;
            while (await db.get('SELECT id FROM roles WHERE LOWER(name) = LOWER(?)', [newName])) {
                newName = `${source.name} (copy ${n++})`;
            }

            let newRole = null;
            await db.runTransaction(async () => {
                newRole = await RoleModel.create({
                    name: newName,
                    description: source.description || null,
                    roleFamilyId: source.roleFamilyId || null,
                    isActive: 1,
                });
                // Copy every requirement in one INSERT…SELECT (level + critical flag).
                await db.run(
                    `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
                     SELECT ?, skill_id, required_level, is_critical FROM role_skill_requirements WHERE role_id = ?`,
                    [newRole.id, parseInt(id)]
                );
            });

            const copied = await db.get(
                'SELECT COUNT(*)::int AS n FROM role_skill_requirements WHERE role_id = ?',
                [newRole.id]
            );

            await LogService.log({
                adminId: req.user.id,
                action: 'ROLE_DUPLICATED',
                entityType: 'role',
                entityId: newRole.id,
                details: `Duplicated role "${source.name}" -> "${newName}" (${copied ? copied.n : 0} requirements copied)`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t
                    ? req.t('flash:role_duplicated', {
                          name: newName,
                          count: copied ? copied.n : 0,
                      })
                    : `Role duplicated as "${newName}" with ${copied ? copied.n : 0} skill requirements — adjust the levels that differ.`
            );
            res.redirect(`/roles/${newRole.id}`);
        } catch (error) {
            console.error('Role duplicate error:', error);
            req.flash('error', req.t ? req.t('flash:role_create_error') : 'Error creating role');
            res.redirect('/roles');
        }
    }

    async update(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_roles')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:role_update_superadmin')
                        : 'Only SuperAdmins can update roles'
                );
                return res.redirect('/roles');
            }

            await RoleModel.update(id, {
                name: req.body.name.trim(),
                description: req.body.description?.trim() || null,
                roleFamilyId: req.body.roleFamilyId ? parseInt(req.body.roleFamilyId) : null,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'ROLE_UPDATED',
                entityType: 'role',
                entityId: id,
                details: `Updated role: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash('success', req.t ? req.t('flash:role_updated') : 'Role updated successfully');
            res.redirect('/roles');
        } catch (error) {
            console.error('Role update error:', error);
            req.flash('error', req.t ? req.t('flash:role_update_error') : 'Error updating role');
            res.redirect('/roles');
        }
    }

    async delete(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_roles')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:role_delete_superadmin')
                        : 'Only SuperAdmins can delete roles'
                );
                return res.redirect('/roles');
            }

            await RoleModel.update(id, { isActive: 0 });

            await LogService.log({
                adminId: req.user.id,
                action: 'ROLE_DELETED',
                entityType: 'role',
                entityId: id,
                details: 'Deleted role',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash('success', req.t ? req.t('flash:role_deleted') : 'Role deleted successfully');
            res.redirect('/roles');
        } catch (error) {
            console.error('Role delete error:', error);
            req.flash('error', req.t ? req.t('flash:role_delete_error') : 'Error deleting role');
            res.redirect('/roles');
        }
    }

    async addRequirement(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_roles')) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Collection POST carrying a `bulk` array = re-level many requirements in
            // one round-trip (see bulkUpdateRequirements). Same route, same guard.
            if (Array.isArray(req.body.bulk)) {
                return await bulkUpdateRequirements(req, res);
            }

            const { skillId, requiredLevel, isCritical } = req.body;

            // Check if requirement already exists
            const existing = await RoleSkillRequirementModel.findByRoleIdAndSkillId(
                id,
                parseInt(skillId)
            );
            if (existing) {
                return res.status(400).json({ error: 'Requirement already exists for this skill' });
            }

            const requirement = await RoleSkillRequirementModel.create({
                roleId: parseInt(id),
                skillId: parseInt(skillId),
                requiredLevel: parseInt(requiredLevel),
                isCritical:
                    isCritical === 'true' || isCritical === true || isCritical === 1 ? 1 : 0,
            });

            // Get skill name for logging
            const skill = await SkillModel.findById(parseInt(skillId));

            await LogService.log({
                adminId: req.user.id,
                action: 'ROLE_REQUIREMENT_ADDED',
                entityType: 'roleSkillRequirement',
                entityId: requirement.id,
                details: `Added requirement: ${skill?.name || 'Unknown'} (Level ${requiredLevel}${isCritical ? ', Critical' : ''})`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            // Hand the new row back (with its domain/skill labels) so the editor can
            // insert it in place instead of reloading the whole page.
            const created =
                (await RoleSkillRequirementModel.findByRoleId(id)).find(
                    (r) => Number(r.id) === Number(requirement.id)
                ) || null;

            res.json({
                success: true,
                message: 'Requirement added successfully',
                requirement: created && {
                    id: Number(created.id),
                    skillId: Number(created.skillId),
                    skillName: created.skillName,
                    domainName: created.domainName,
                    requiredLevel: Number(created.requiredLevel),
                    isCritical: toCriticalBool(created.isCritical) ? 1 : 0,
                },
            });
        } catch (error) {
            console.error('Add requirement error:', error);
            res.status(500).json({ error: 'Error adding requirement' });
        }
    }

    async updateRequirement(req, res) {
        try {
            const { id, requirementId } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_roles')) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const { requiredLevel, isCritical } = req.body;

            // Get existing requirement
            const existing = await RoleSkillRequirementModel.findById(requirementId);
            if (!existing || Number(existing.roleId) !== Number(id)) {
                return res.status(404).json({ error: 'Requirement not found' });
            }

            await RoleSkillRequirementModel.update(requirementId, {
                requiredLevel: parseInt(requiredLevel),
                isCritical:
                    isCritical === 'true' || isCritical === true || isCritical === 1 ? 1 : 0,
            });

            // Get skill name for logging
            const skill = await SkillModel.findById(existing.skillId);

            await LogService.log({
                adminId: req.user.id,
                action: 'ROLE_REQUIREMENT_UPDATED',
                entityType: 'roleSkillRequirement',
                entityId: requirementId,
                details: `Updated requirement: ${skill?.name || 'Unknown'} (Level ${requiredLevel}${isCritical ? ', Critical' : ''})`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, message: 'Requirement updated successfully' });
        } catch (error) {
            console.error('Update requirement error:', error);
            res.status(500).json({ error: 'Error updating requirement' });
        }
    }

    async removeRequirement(req, res) {
        try {
            const { id, requirementId } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_roles')) {
                if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
                    return res.status(403).json({ error: 'Access denied' });
                }
                req.flash('error', req.t ? req.t('flash:access_denied') : 'Access denied');
                return res.redirect('/roles');
            }

            await RoleSkillRequirementModel.delete(parseInt(requirementId));

            await LogService.log({
                adminId: req.user.id,
                action: 'ROLE_REQUIREMENT_REMOVED',
                entityType: 'roleSkillRequirement',
                entityId: requirementId,
                details: `Removed requirement from role ${id}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
                return res.json({ success: true, message: 'Requirement removed successfully' });
            }
            req.flash(
                'success',
                req.t ? req.t('flash:role_req_removed') : 'Requirement removed successfully'
            );
            res.redirect(`/roles/${id}`);
        } catch (error) {
            console.error('Remove requirement error:', error);
            if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
                return res.status(500).json({ error: 'Error removing requirement' });
            }
            req.flash(
                'error',
                req.t ? req.t('flash:role_req_remove_error') : 'Error removing requirement'
            );
            res.redirect(`/roles/${req.params.id}`);
        }
    }
}

module.exports = new RoleController();
