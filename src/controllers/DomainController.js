const DomainModel = require('../models/DomainModel');
const SkillModel = require('../models/SkillModel');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');
const { domainValidation } = require('../utils/validators');
const db = require('../config/database');

class DomainController {
    // Unified Domains & Skills Index
    async index(req, res) {
        try {
            // Read page: view_domains_skills may SEE the catalog (manage implies it).
            if (!RBACService.hasPermission(req.user, 'view_domains_skills')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:domain_manage_superadmin')
                        : 'You do not have permission to view domains and skills.'
                );
                return res.redirect('/dashboard');
            }

            const domains = await DomainModel.findAll({ isActive: 1 }, 'name ASC');
            const allDomains = await DomainModel.findAll({ isActive: 1 }, 'name ASC');

            // the Skills tab used to render EVERY active skill in one
            // table - 1 181 rows, 3.5 MB of HTML, 1 181 inline forms, 10-30 s on a
            // mine-site link. It is now rendered ONE SUB-DOMAIN AT A TIME: the picker
            // below is the filter, and `?subDomainId=` is the server-side selection.
            // No skill is hidden - every sub-domain is listed with its exact count.
            const subDomainFilter = /^\d+$/.test(String(req.query.subDomainId || ''))
                ? Number(req.query.subDomainId)
                : null;
            const skills = subDomainFilter
                ? await db.all(
                      `SELECT s.*, s.category, d.name AS "domainName", sd.name AS "subDomainName"
                       FROM skills s
                       INNER JOIN domains d ON d.id = s.domain_id
                       LEFT JOIN sub_domains sd ON sd.id = s.sub_domain_id
                      WHERE s.is_active = true AND d.is_active = true AND s.sub_domain_id = ?
                      ORDER BY s.name`,
                      [subDomainFilter]
                  )
                : [];
            // 3.23.21: the edit dialog shows the skill's own level anchors (FR/EN).
            if (skills.length) {
                try {
                    const own = await require('../services/SkillDescriptionService').ownAnchors(
                        skills.map((s) => s.id)
                    );
                    for (const s of skills) s.anchors = own.get(String(s.id)) || {};
                } catch (e) {
                    console.error('Skill anchors for the edit dialog:', e.message);
                }
            }

            // V3 capability framework tree: Pillar (Domain) -> Sub-Domain -> Skill.
            // Built from the standardized capability taxonomy so admins can browse the full
            // hierarchy (the Domains/Skills tabs are flat; this one shows sub-domains).
            const fwRows = await db.all(`
                SELECT d.id AS domain_id, d.name AS domain_name,
                       sd.id AS sub_id, sd.name AS sub_name, sd.definition AS sub_def, sd.position AS sub_pos,
                       s.id AS skill_id, s.name AS skill_name, s.category AS skill_category, s.source AS skill_source
                FROM domains d
                JOIN sub_domains sd ON sd.domain_id = d.id
                LEFT JOIN skills s ON s.sub_domain_id = sd.id AND s.is_active = true
                WHERE d.is_active = true
                ORDER BY d.name, sd.position, s.name
            `);
            const framework = [];
            const dMap = new Map();
            for (const r of fwRows) {
                let d = dMap.get(r.domainId);
                if (!d) {
                    d = {
                        id: r.domainId,
                        name: r.domainName,
                        subs: [],
                        _subMap: new Map(),
                        skillCount: 0,
                    };
                    dMap.set(r.domainId, d);
                    framework.push(d);
                }
                let sd = d._subMap.get(r.subId);
                if (!sd) {
                    sd = { id: r.subId, name: r.subName, definition: r.subDef, skills: [] };
                    d._subMap.set(r.subId, sd);
                    d.subs.push(sd);
                }
                if (r.skillId) {
                    sd.skills.push({
                        id: r.skillId,
                        name: r.skillName,
                        category: r.skillCategory,
                        source: r.skillSource,
                    });
                    d.skillCount++;
                }
            }

            // Sub-domains (with their pillar + live skill count) for the Sub-Domains tab
            // and the skill modal's sub-domain selector.
            const subDomains = await db.all(`
                SELECT sd.id, sd.name, sd.definition, sd.position, sd.is_active AS is_active,
                       d.id AS domain_id, d.name AS domain_name,
                       (SELECT COUNT(*) FROM skills s WHERE s.sub_domain_id = sd.id AND s.is_active = true) AS skill_count
                FROM sub_domains sd
                JOIN domains d ON d.id = sd.domain_id
                WHERE sd.is_active = true AND d.is_active = true
                ORDER BY d.name, sd.position, sd.name
            `);

            // Weight of a sub-domain inside its pillar: how much of the pillar's
            // capability it carries. Measured (skills in the sub-domain / skills in
            // the pillar), never estimated; a pillar with no skill yet has no weight.
            const pillarTotals = new Map();
            for (const d of framework) {
                pillarTotals.set(String(d.id), d.skillCount);
                for (const sd of d.subs) {
                    sd.weightPct =
                        d.skillCount > 0
                            ? Math.round((sd.skills.length / d.skillCount) * 100)
                            : null;
                }
            }
            for (const sd of subDomains) {
                const total = pillarTotals.get(String(sd.domainId)) || 0;
                sd.weightPct = total > 0 ? Math.round((Number(sd.skillCount) / total) * 100) : null;
            }

            res.render('pages/domains-skills/index', {
                title: req.t ? req.t('chrome:pt_domains_skills') : 'Domains & Skills',
                domains,
                skills,
                allDomains,
                framework,
                subDomains,
                subDomainFilter,
                activeTab: req.query.tab || 'framework',
            });
        } catch (error) {
            console.error('Domains & Skills index error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:domain_page_load_error') : 'Error loading domains and skills'
            );
            res.redirect('/dashboard');
        }
    }

    // Legacy index for backward compatibility
    async domainsIndex(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'view_domains_skills')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:domain_manage_only')
                        : 'You do not have permission to view domains.'
                );
                return res.redirect('/dashboard');
            }

            const domains = await DomainModel.findAll({ isActive: 1 }, 'name ASC');
            res.render('pages/domains/index', {
                title: req.t ? req.t('chrome:pt_domains') : 'Domains',
                domains,
            });
        } catch (error) {
            console.error('Domain index error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:domain_list_load_error') : 'Error loading domains'
            );
            res.redirect('/dashboard');
        }
    }

    async create(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'manage_domains_skills')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:domain_create_superadmin')
                        : 'Only SuperAdmins can create domains'
                );
                return res.redirect('/domains');
            }

            const name = req.body.name?.trim();
            if (!name) {
                req.flash(
                    'error',
                    req.t ? req.t('flash:domain_name_required') : 'Domain name is required'
                );
                return res.redirect('/domains-skills?tab=domains');
            }

            // Check if domain with same name already exists (active or inactive)
            // Use raw SQL to find by name
            const existing = await db.get('SELECT * FROM domains WHERE name = ? LIMIT 1', [name]);

            if (existing) {
                // Active domains use a real PG boolean.
                if (existing.isActive) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:domain_name_exists', { name })
                            : `A domain with the name "${name}" already exists`
                    );
                    return res.redirect('/domains-skills?tab=domains');
                } else {
                    // Domain exists but is inactive - reactivate it
                    await DomainModel.update(existing.id, {
                        description: req.body.description?.trim() || null,
                        isActive: 1,
                    });

                    await LogService.log({
                        adminId: req.user.id,
                        action: 'DOMAIN_CREATED',
                        entityType: 'domain',
                        entityId: existing.id,
                        details: `Reactivated domain: ${name}`,
                        ipAddress: req.ip,
                        userAgent: req.get('user-agent'),
                    });

                    req.flash(
                        'success',
                        req.t
                            ? req.t('flash:domain_reactivated')
                            : 'Domain reactivated successfully'
                    );
                    return res.redirect('/domains-skills?tab=domains');
                }
            }

            // No existing domain - create new one
            await DomainModel.create({
                name,
                description: req.body.description?.trim() || null,
                isActive: 1,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'DOMAIN_CREATED',
                entityType: 'domain',
                details: `Created domain: ${name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:domain_created') : 'Domain created successfully'
            );
            res.redirect('/domains-skills?tab=domains');
        } catch (error) {
            console.error('Domain create error:', error);
            let errorMessage = 'Error creating domain';
            // `name` is block-scoped to the try above; re-derive it here so the
            // 23505 reactivation path below doesn't throw ReferenceError.
            const name = req.body.name?.trim();

            // Handle PostgreSQL unique constraint violation (SQLSTATE 23505).
            // This can happen if the domain exists but wasn't found in the check above
            if (
                error.code === '23505' ||
                (error.message && /duplicate key|unique constraint/i.test(error.message))
            ) {
                // Try to find and reactivate the domain
                try {
                    const existing = await db.get('SELECT * FROM domains WHERE name = ? LIMIT 1', [
                        name,
                    ]);

                    if (existing && !existing.isActive) {
                        // Domain exists but is inactive - reactivate it
                        await DomainModel.update(existing.id, {
                            description: req.body.description?.trim() || null,
                            isActive: 1,
                        });

                        await LogService.log({
                            adminId: req.user.id,
                            action: 'DOMAIN_CREATED',
                            entityType: 'domain',
                            entityId: existing.id,
                            details: `Reactivated domain: ${name}`,
                            ipAddress: req.ip,
                            userAgent: req.get('user-agent'),
                        });

                        req.flash(
                            'success',
                            req.t
                                ? req.t('flash:domain_reactivated')
                                : 'Domain reactivated successfully'
                        );
                        return res.redirect('/domains-skills?tab=domains');
                    } else if (existing && existing.isActive) {
                        errorMessage = `A domain with the name "${name}" already exists`;
                    } else {
                        errorMessage = `A domain with this name already exists`;
                    }
                } catch (reactivateError) {
                    console.error('Error during reactivation attempt:', reactivateError);
                    errorMessage = `A domain with this name already exists`;
                }
            } else if (error.message) {
                errorMessage = `Error: ${error.message}`;
            }

            req.flash('error', errorMessage);
            res.redirect('/domains-skills?tab=domains');
        }
    }

    async update(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_domains_skills')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:domain_update_superadmin')
                        : 'Only SuperAdmins can update domains'
                );
                return res.redirect('/domains');
            }

            await DomainModel.update(id, {
                name: req.body.name.trim(),
                description: req.body.description?.trim() || null,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'DOMAIN_UPDATED',
                entityType: 'domain',
                entityId: id,
                details: `Updated domain: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:domain_updated') : 'Domain updated successfully'
            );
            res.redirect('/domains-skills?tab=domains');
        } catch (error) {
            console.error('Domain update error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:domain_update_error') : 'Error updating domain'
            );
            res.redirect('/domains-skills?tab=domains');
        }
    }

    async delete(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_domains_skills')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:domain_delete_superadmin')
                        : 'Only SuperAdmins can delete domains'
                );
                return res.redirect('/domains');
            }

            await DomainModel.update(id, { isActive: 0 });

            await LogService.log({
                adminId: req.user.id,
                action: 'DOMAIN_DELETED',
                entityType: 'domain',
                entityId: id,
                details: 'Deleted domain',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:domain_deleted') : 'Domain deleted successfully'
            );
            res.redirect('/domains-skills?tab=domains');
        } catch (error) {
            console.error('Domain delete error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:domain_delete_error') : 'Error deleting domain'
            );
            res.redirect('/domains-skills?tab=domains');
        }
    }
}

module.exports = new DomainController();
