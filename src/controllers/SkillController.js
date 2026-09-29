const SkillModel = require('../models/SkillModel');
const DomainModel = require('../models/DomainModel');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');
const { skillValidation } = require('../utils/validators');
const db = require('../config/database');

class SkillController {
    async index(req, res) {
        try {
            // Read page: view_domains_skills may SEE the skill list (manage implies it).
            if (!RBACService.hasPermission(req.user, 'view_domains_skills')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:skill_manage_superadmin')
                        : 'You do not have permission to view skills.'
                );
                return res.redirect('/dashboard');
            }

            const skills = await SkillModel.findWithDomain();
            const domains = await DomainModel.findAll({ isActive: 1 }, 'name ASC');

            res.render('pages/skills/index', {
                title: req.t ? req.t('chrome:pt_skills') : 'Skills',
                skills,
                domains,
            });
        } catch (error) {
            console.error('Skill index error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:skill_list_load_error') : 'Error loading skills'
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
                        ? req.t('flash:skill_create_superadmin')
                        : 'Only SuperAdmins can create skills'
                );
                return res.redirect('/skills');
            }

            // a skill is placed by SUB-DOMAIN; the pillar (domainId) is derived from it.
            const subDomainId = parseInt(req.body.subDomainId, 10) || null;
            let domainId = parseInt(req.body.domainId, 10) || null;
            const name = req.body.name?.trim();

            if (!name) {
                req.flash(
                    'error',
                    req.t ? req.t('flash:skill_name_required') : 'Skill name is required'
                );
                return res.redirect('/domains-skills?tab=skills');
            }
            if (subDomainId) {
                const sd = await db.get('SELECT domainId FROM subDomains WHERE id = ?', [
                    subDomainId,
                ]);
                if (!sd) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:skill_subdomain_required')
                            : 'Valid sub-domain is required'
                    );
                    return res.redirect('/domains-skills?tab=skills');
                }
                domainId = Number(sd.domainId);
            }
            if (!domainId || isNaN(domainId)) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:skill_subdomain_or_domain_required')
                        : 'Valid sub-domain (or domain) is required'
                );
                return res.redirect('/domains-skills?tab=skills');
            }

            // Dedup against an existing skill of the same name in the same sub-domain
            // (or pillar when no sub-domain is given).
            const existing = subDomainId
                ? await db.get(
                      'SELECT * FROM skills WHERE subDomainId = ? AND lower(name) = lower(?) LIMIT 1',
                      [subDomainId, name]
                  )
                : await db.get(
                      'SELECT * FROM skills WHERE domainId = ? AND lower(name) = lower(?) LIMIT 1',
                      [domainId, name]
                  );

            if (existing) {
                // Active skills use a real PG boolean.
                if (existing.isActive) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:skill_name_exists', { name })
                            : `A skill with the name "${name}" already exists in this domain`
                    );
                    return res.redirect('/domains-skills?tab=skills');
                } else {
                    // Skill exists but is inactive - reactivate it (re-place it too)
                    await SkillModel.update(existing.id, {
                        domainId,
                        subDomainId,
                        description: req.body.description?.trim() || null,
                        category: req.body.category || 'Technical',
                        isActive: 1,
                    });

                    await LogService.log({
                        adminId: req.user.id,
                        action: 'SKILL_CREATED',
                        entityType: 'skill',
                        entityId: existing.id,
                        details: `Reactivated skill: ${name}`,
                        ipAddress: req.ip,
                        userAgent: req.get('user-agent'),
                    });

                    req.flash(
                        'success',
                        req.t ? req.t('flash:skill_reactivated') : 'Skill reactivated successfully'
                    );
                    return res.redirect('/domains-skills?tab=skills');
                }
            }

            // No existing skill - create new one
            await SkillModel.create({
                domainId,
                subDomainId,
                name,
                description: req.body.description?.trim() || null,
                category: req.body.category || 'Technical',
                isActive: 1,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'SKILL_CREATED',
                entityType: 'skill',
                details: `Created skill: ${name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:skill_created') : 'Skill created successfully'
            );
            res.redirect('/domains-skills?tab=skills');
        } catch (error) {
            console.error('Skill create error:', error);
            let errorMessage = 'Error creating skill';

            // Handle PostgreSQL unique constraint violation (SQLSTATE 23505).
            // This can happen if the skill exists but wasn't found in the check above
            if (
                error.code === '23505' ||
                (error.message && /duplicate key|unique constraint/i.test(error.message))
            ) {
                // Try to find and reactivate the skill
                try {
                    const domainId = parseInt(req.body.domainId);
                    const name = req.body.name?.trim();

                    if (domainId && name) {
                        const existing = await db.get(
                            'SELECT * FROM skills WHERE domainId = ? AND name = ? LIMIT 1',
                            [domainId, name]
                        );

                        if (existing && !existing.isActive) {
                            // Skill exists but is inactive - reactivate it
                            await SkillModel.update(existing.id, {
                                description: req.body.description?.trim() || null,
                                isActive: 1,
                            });

                            await LogService.log({
                                adminId: req.user.id,
                                action: 'SKILL_CREATED',
                                entityType: 'skill',
                                entityId: existing.id,
                                details: `Reactivated skill: ${name}`,
                                ipAddress: req.ip,
                                userAgent: req.get('user-agent'),
                            });

                            req.flash(
                                'success',
                                req.t
                                    ? req.t('flash:skill_reactivated')
                                    : 'Skill reactivated successfully'
                            );
                            return res.redirect('/domains-skills?tab=skills');
                        } else if (existing && existing.isActive) {
                            errorMessage = `A skill with the name "${name}" already exists in this domain`;
                        } else {
                            errorMessage = `A skill with this name already exists in this domain`;
                        }
                    } else {
                        errorMessage = `A skill with this name already exists in this domain`;
                    }
                } catch (reactivateError) {
                    console.error('Error during reactivation attempt:', reactivateError);
                    errorMessage = `A skill with this name already exists in this domain`;
                }
            } else if (error.message) {
                errorMessage = `Error: ${error.message}`;
            }

            req.flash('error', errorMessage);
            res.redirect('/domains-skills?tab=skills');
        }
    }

    async update(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_domains_skills')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:skill_update_superadmin')
                        : 'Only SuperAdmins can update skills'
                );
                return res.redirect('/skills');
            }

            // placement is by sub-domain; derive the pillar (domainId) from it.
            const subDomainId = parseInt(req.body.subDomainId, 10) || null;
            let domainId = parseInt(req.body.domainId, 10) || null;
            if (subDomainId) {
                const sd = await db.get('SELECT domainId FROM subDomains WHERE id = ?', [
                    subDomainId,
                ]);
                if (sd) domainId = Number(sd.domainId);
            }
            await SkillModel.update(id, {
                domainId,
                subDomainId,
                name: req.body.name.trim(),
                description: req.body.description?.trim() || null,
                category: req.body.category || 'Technical',
            });

            // 3.23.21: the English description and the five level anchors
            // (FR/EN) of the edit dialog. Only fields the form actually sent are
            // touched; an emptied field clears that text (the level then falls
            // back to its category anchor).
            const texts = {};
            for (const k of [
                'descriptionEn',
                'fr0',
                'fr1',
                'fr2',
                'fr3',
                'fr4',
                'en0',
                'en1',
                'en2',
                'en3',
                'en4',
            ]) {
                if (req.body[k] !== undefined)
                    texts[k === 'descriptionEn' ? 'descEn' : k] = req.body[k];
            }
            if (Object.keys(texts).length) {
                await require('../services/SkillDescriptionService').saveSkillTexts(id, texts, {
                    eraseEmpty: true,
                    actor: req.user,
                });
            }

            await LogService.log({
                adminId: req.user.id,
                action: 'SKILL_UPDATED',
                entityType: 'skill',
                entityId: id,
                details: `Updated skill: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:skill_updated') : 'Skill updated successfully'
            );
            res.redirect('/domains-skills?tab=skills');
        } catch (error) {
            console.error('Skill update error:', error);
            req.flash('error', req.t ? req.t('flash:skill_update_error') : 'Error updating skill');
            res.redirect('/domains-skills?tab=skills');
        }
    }

    async delete(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_domains_skills')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:skill_delete_superadmin')
                        : 'Only SuperAdmins can delete skills'
                );
                return res.redirect('/skills');
            }

            await SkillModel.update(id, { isActive: 0 });

            await LogService.log({
                adminId: req.user.id,
                action: 'SKILL_DELETED',
                entityType: 'skill',
                entityId: id,
                details: 'Deleted skill',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:skill_deleted') : 'Skill deleted successfully'
            );
            res.redirect('/domains-skills?tab=skills');
        } catch (error) {
            console.error('Skill delete error:', error);
            req.flash('error', req.t ? req.t('flash:skill_delete_error') : 'Error deleting skill');
            res.redirect('/domains-skills?tab=skills');
        }
    }
}

module.exports = new SkillController();
