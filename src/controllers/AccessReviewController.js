'use strict';

const AccessReviewService = require('../services/AccessReviewService');
const accessProfiles = require('../config/accessProfiles');
const { csvResponse } = require('../utils/listTools');

/** Translate a permission slug to its localized label (falls back to the slug). */
function permLabel(req, slug) {
    if (!req || typeof req.t !== 'function') return slug;
    return req.t(`admin:perm.${slug}.label`, { defaultValue: slug });
}

function permList(req, row) {
    if (row.superadmin) return null;
    return (row.permissionSlugs || []).map((s) => permLabel(req, s));
}

/** Display language for the access-profile labels (i18next attaches req.language). */
function lngOf(req) {
    const l = (req && (req.language || (req.i18n && req.i18n.language))) || 'fr';
    return String(l).toLowerCase().startsWith('en') ? 'en' : 'fr';
}

/** Localized profile name for a derived profile key, or null when hand-built. */
function profileLabel(req, key) {
    const p = accessProfiles.byKey(key);
    return p ? p.label[lngOf(req)] : null;
}

class AccessReviewController {
    async page(req, res) {
        const { rows, summary } = await AccessReviewService.buildReport();
        res.render('pages/admin/access-review', {
            title: req.t ? req.t('chrome:pt_access_review') : 'Access Review',
            rows,
            summary,
            permLabels: (row) => permList(req, row),
            profileName: (key) => profileLabel(req, key),
        });
    }

    /**
     * CSV of the review with the attestation columns and every named
     * exception — through the shared list toolkit (BOM, `sep=,`, formula guard).
     */
    async exportCsv(req, res) {
        const { rows } = await AccessReviewService.buildReport();
        const T = (k, fallback) =>
            req.t ? req.t(`admin:${k}`, { defaultValue: fallback }) : fallback;
        // French-first headers (the UI is French-first; EN mirrors via the locale).
        const headers = [
            T('tri_csv_account', 'Compte'),
            T('tri_csv_email', 'E-mail'),
            T('tri_csv_role', 'Rôle'),
            T('tri_csv_profile', 'Profil d’accès'),
            T('tri_csv_active', 'Actif'),
            T('adm_csv_locked', 'Verrouillé'),
            T('tri_csv_mfa', 'MFA activée'),
            T('tri_csv_perm_count', 'Nb capacités'),
            T('tri_csv_perms', 'Capacités'),
            T('tri_csv_scope_count', 'Nb périmètres'),
            T('tri_csv_scope', 'Périmètre'),
            T('tri_csv_expires', 'Expire le'),
            T('adm_csv_expired_on', 'Expiré le'),
            T('adm_csv_last_login', 'Dernière connexion'),
            T('tri_csv_last', 'Dernière activité'),
            T('ar_csv_attested_at', 'Attesté le'),
            T('ar_csv_attested_by', 'Attesté par'),
            T('ar_csv_decision', 'Décision'),
            T('tri_csv_exc_powerless', 'Exception : périmètre sans capacité'),
            T('tri_csv_exc_nomfa', 'Exception : sans MFA'),
            T('tri_csv_exc_expiring', 'Exception : expire bientôt'),
            T('ar_csv_exc_expired', 'Exception : expiré'),
            T('ar_csv_exc_locked', 'Exception : verrouillé'),
            T('ar_csv_exc_site_inactive', 'Exception : unité désactivée'),
            T('tri_csv_exc_stale', 'Exception : compte dormant'),
        ];
        const yes = T('tri_yes', 'oui');
        const no = T('tri_no', 'non');
        const never = T('tri_never', 'jamais');
        const allPerms = T('tri_all_perms', 'TOUTES (super-admin)');
        const custom = T('tri_profile_custom', 'Personnalisé');
        const bool = (v) => (v ? yes : no);
        const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
        const decisionLabel = (d) => (d ? T(`ar_decision_${d}`, d) : '');

        const orgWide = T('tri_scope_org', 'Toute l’organisation');
        const body = rows.map((r) => {
            const labels = permList(req, r);
            return [
                r.username,
                r.email || '',
                req.t ? req.t(`admin:enum_admin_role_${r.role}`, { defaultValue: r.role }) : r.role,
                r.superadmin ? '' : profileLabel(req, r.accessProfile) || custom,
                bool(r.isActive),
                bool(r.locked),
                bool(r.mfaEnrolled),
                r.superadmin ? '' : String(r.permCount == null ? 0 : r.permCount),
                r.superadmin ? allPerms : (labels || []).join(' | '),
                r.superadmin ? '' : String(r.scopeCount == null ? 0 : r.scopeCount),
                r.orgWide ? orgWide : r.scopeSummary || '',
                day(r.expiresAt),
                day(r.lastExpiredAt),
                r.lastLoginAt ? new Date(r.lastLoginAt).toISOString() : never,
                r.lastActivity ? new Date(r.lastActivity).toISOString() : never,
                r.attestedAt ? new Date(r.attestedAt).toISOString() : '',
                r.attestedBy || '',
                decisionLabel(r.attestDecision),
                bool(r.scopedButPowerless),
                bool(r.noMfa),
                bool(r.expiringSoon),
                bool(r.expired),
                bool(r.locked),
                bool(r.siteInactive),
                bool(r.stale),
            ];
        });
        return csvResponse(res, 'access-review.csv', headers, body);
    }

    async attest(req, res) {
        try {
            const out = await AccessReviewService.attest(
                req.user,
                Number(req.params.id),
                req.body.decision || 'appropriate',
                (req.body.note || '').toString().slice(0, 500) || null
            );
            res.json({ ok: true, ...out });
        } catch (e) {
            res.status(400).json({
                ok: false,
                error: e && e.message ? e.message : 'attest failed',
            });
        }
    }
}

module.exports = new AccessReviewController();
