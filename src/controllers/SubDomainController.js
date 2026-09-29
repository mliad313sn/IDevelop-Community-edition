'use strict';

const db = require('../config/database');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');

/**
 * Sub-Domain (Competency Element) management — the middle tier of the V3 capability
 * framework: Domain (Pillar) → Sub-Domain → Skill. Skills hang off a sub-domain, and a
 * sub-domain belongs to a pillar (domains). Editing is gated by `manage_domains_skills`.
 */
// Module-level (not a method): Express invokes the route handlers unbound, so `this`
// is not the controller instance — keep the permission guard `this`-free.
function denied(req, res) {
    if (!RBACService.hasPermission(req.user, 'manage_domains_skills')) {
        req.flash(
            'error',
            req.t
                ? req.t('flash:subdomain_manage_superadmin')
                : 'Only SuperAdmins can manage sub-domains'
        );
        res.redirect('/dashboard');
        return true;
    }
    return false;
}

class SubDomainController {
    async create(req, res) {
        try {
            if (denied(req, res)) return;
            const domainId = parseInt(req.body.domainId, 10);
            const name = (req.body.name || '').trim();
            const definition = (req.body.definition || '').trim() || null;
            if (!domainId || !name) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:subdomain_fields_required')
                        : 'A pillar (domain) and a sub-domain name are required'
                );
                return res.redirect('/domains-skills?tab=subdomains');
            }
            // Reactivate a soft-deleted one of the same (domain, name); else insert.
            const existing = await db.get(
                'SELECT id, is_active FROM sub_domains WHERE domain_id = ? AND lower(name) = lower(?) LIMIT 1',
                [domainId, name]
            );
            if (existing) {
                if (existing.isActive) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:subdomain_name_exists', { name })
                            : `A sub-domain "${name}" already exists in this pillar`
                    );
                    return res.redirect('/domains-skills?tab=subdomains');
                }
                await db.run(
                    'UPDATE sub_domains SET is_active = true, definition = ?, updated_at = now() WHERE id = ?',
                    [definition, existing.id]
                );
                req.flash(
                    'success',
                    req.t ? req.t('flash:subdomain_reactivated') : 'Sub-domain reactivated'
                );
            } else {
                const pos = await db.get(
                    'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM sub_domains WHERE domain_id = ?',
                    [domainId]
                );
                await db.run(
                    'INSERT INTO sub_domains (domain_id, name, definition, position, is_active) VALUES (?, ?, ?, ?, true)',
                    [domainId, name, definition, Number(pos.p) || 0]
                );
                req.flash(
                    'success',
                    req.t ? req.t('flash:subdomain_created') : 'Sub-domain created'
                );
            }
            await LogService.log({
                adminId: req.user.id,
                action: 'SUBDOMAIN_CREATED',
                entityType: 'sub_domain',
                details: `Created sub-domain: ${name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            res.redirect('/domains-skills?tab=subdomains');
        } catch (e) {
            console.error('Sub-domain create error:', e);
            req.flash(
                'error',
                req.t ? req.t('flash:subdomain_create_error') : 'Error creating sub-domain'
            );
            res.redirect('/domains-skills?tab=subdomains');
        }
    }

    async update(req, res) {
        try {
            if (denied(req, res)) return;
            const id = parseInt(req.params.id, 10);
            const domainId = parseInt(req.body.domainId, 10);
            const name = (req.body.name || '').trim();
            const definition = (req.body.definition || '').trim() || null;
            if (!id || !domainId || !name) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:subdomain_pillar_name_required')
                        : 'Pillar and name are required'
                );
                return res.redirect('/domains-skills?tab=subdomains');
            }
            // Moving a sub-domain to another pillar must also repoint its skills' domain_id
            // (a skill's domain_id mirrors its sub-domain's pillar), so do it atomically.
            await db.runTransaction(async () => {
                await db.run(
                    'UPDATE sub_domains SET domain_id = ?, name = ?, definition = ?, updated_at = now() WHERE id = ?',
                    [domainId, name, definition, id]
                );
                await db.run(
                    'UPDATE skills SET domain_id = ?, updated_at = now() WHERE sub_domain_id = ?',
                    [domainId, id]
                );
            });
            await LogService.log({
                adminId: req.user.id,
                action: 'SUBDOMAIN_UPDATED',
                entityType: 'sub_domain',
                entityId: id,
                details: `Updated sub-domain: ${name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash('success', req.t ? req.t('flash:subdomain_updated') : 'Sub-domain updated');
            res.redirect('/domains-skills?tab=subdomains');
        } catch (e) {
            console.error('Sub-domain update error:', e);
            req.flash(
                'error',
                req.t ? req.t('flash:subdomain_update_error') : 'Error updating sub-domain'
            );
            res.redirect('/domains-skills?tab=subdomains');
        }
    }

    async delete(req, res) {
        try {
            if (denied(req, res)) return;
            const id = parseInt(req.params.id, 10);
            // Refuse to orphan skills — require them reassigned/removed first.
            const cnt = await db.get(
                'SELECT COUNT(*)::int AS n FROM skills WHERE sub_domain_id = ? AND is_active = true',
                [id]
            );
            if (Number(cnt.n) > 0) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:subdomain_has_skills', { n: cnt.n })
                        : `This sub-domain has ${cnt.n} active skill(s). Move or remove them before deleting it.`
                );
                return res.redirect('/domains-skills?tab=subdomains');
            }
            await db.run(
                'UPDATE sub_domains SET is_active = false, updated_at = now() WHERE id = ?',
                [id]
            );
            await LogService.log({
                adminId: req.user.id,
                action: 'SUBDOMAIN_DELETED',
                entityType: 'sub_domain',
                entityId: id,
                details: 'Deleted sub-domain',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash('success', req.t ? req.t('flash:subdomain_deleted') : 'Sub-domain deleted');
            res.redirect('/domains-skills?tab=subdomains');
        } catch (e) {
            console.error('Sub-domain delete error:', e);
            req.flash(
                'error',
                req.t ? req.t('flash:subdomain_delete_error') : 'Error deleting sub-domain'
            );
            res.redirect('/domains-skills?tab=subdomains');
        }
    }
}

module.exports = new SubDomainController();
