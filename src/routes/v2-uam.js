'use strict';

/**
 *   Phase-2 UAM routes mounted at /v2/uam by src/routes/index.js (Phase-2
 *   wiring step). Kept in a separate file so V1 routes stay untouched.
 */

const express = require('express');
const router = express.Router();

const MfaService = require('../services/MfaService');
const MakerCheckerService = require('../services/MakerCheckerService');
const LogService = require('../services/LogService');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');

// ----- MFA (opt-in for every account; recommended for privileged roles) -----

// Status / management page: activate or deactivate two-factor auth.
router.get(
    '/mfa/manage',
    requireAuth,
    ah(async (req, res) => {
        const userType = MfaService.mfaUserType(req.user);
        const status = await MfaService.status({ userType, userId: req.user.id });
        res.render('pages/auth/mfa-manage', {
            title: req.t ? req.t('chrome:pt_two_factor_verification') : 'Two-Factor Authentication',
            status,
            recommended: MfaService.isPrivileged(req.user.role),
        });
    })
);

// Enrolment page. SAFE on a second visit: if two-factor is already active this
// renders nothing and rotates nothing — see MfaService.beginSetup for why a GET
// that cleared `confirmed_at` was a way to switch off someone else's second
// factor from a plain link.
router.get(
    '/mfa/setup',
    requireAuth,
    ah(async (req, res) => {
        const userType = MfaService.mfaUserType(req.user);
        const accountLabel = req.user.username || req.user.employeeNumber || `user-${req.user.id}`;
        const { started, secret, otpauthUrl } = await MfaService.beginSetup({
            userType,
            userId: req.user.id,
            accountLabel,
        });
        if (!started) {
            // Already enrolled. Say so, and send the reader to the page that can
            // deactivate it — which asks for a current code first.
            req.flash(
                'warning',
                req.t
                    ? req.t('flash:mfa_already_active')
                    : 'Two-factor authentication is already active on this account. To use a different authenticator, deactivate it first — you will be asked for a current code.'
            );
            return res.redirect('/v2/uam/mfa/manage');
        }
        const qrDataUrl = await require('qrcode').toDataURL(otpauthUrl, { margin: 1, width: 220 });
        res.render('pages/auth/mfa-setup', {
            title: req.t ? req.t('chrome:pt_mfa_activate') : 'Activate two-factor authentication',
            secret,
            otpauthUrl,
            qrDataUrl,
        });
    })
);

router.post(
    '/mfa/verify',
    requireAuth,
    ah(async (req, res) => {
        const userType = MfaService.mfaUserType(req.user);
        const ok = await MfaService.verifyAndConfirm({
            userType,
            userId: req.user.id,
            code: String(req.body.code || '').trim(),
        });
        if (!ok) {
            req.flash(
                'error',
                req.t
                    ? req.t('flash:mfa_invalid_code_setup')
                    : 'Invalid code — scan the QR again and enter the current 6-digit code.'
            );
            return res.redirect('/v2/uam/mfa/setup');
        }
        // 3.23.19: the enrolment hold of THIS session is released here, and
        // only here — by a code verified in this very session.
        if (req.session) {
            req.session.mfaVerifiedInSession = true;
            delete req.session.mfaEnrolRequired;
        }
        const codes = await MfaService.issueBackupCodes({ userType, userId: req.user.id });
        await LogService.log({
            adminId: userType === 'admin' ? req.user.id : null,
            action: 'MFA_ENABLED',
            entityType: userType,
            entityId: req.user.id,
            details: `Two-factor auth activated for ${userType} ${req.user.username || req.user.id}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        }).catch(() => {});
        // C2f (3.23.20): every SuperAdmin hears of a SuperAdmin MFA change.
        if (require('../services/AdminSsoService').isActiveSuperadmin(req.user))
            require('../services/SuperadminAlertService')
                .alert('security.superadmin_mfa_changed', {
                    targetAdminId: req.user.id,
                    username: req.user.username,
                    detail: 'two-factor authentication enrolled (new authenticator)',
                })
                .catch(() => {});
        res.render('pages/auth/mfa-backup-codes', {
            title: req.t ? req.t('chrome:pt_backup_codes') : 'Backup codes',
            codes,
        });
    })
);

// Deactivation requires a current TOTP (or backup) code so a borrowed session
// can't silently remove the second factor.
router.post(
    '/mfa/disable',
    requireAuth,
    ah(async (req, res) => {
        const userType = MfaService.mfaUserType(req.user);
        // C2 (3.23.20): a SuperAdmin's MFA is ALWAYS mandatory — it cannot be
        // switched off (a lost authenticator is reset by ANOTHER SuperAdmin or by
        // the OS-admin recovery CLI, which re-holds the next sign-in on enrolment).
        const AdminSso = require('../services/AdminSsoService');
        if (AdminSso.isActiveSuperadmin(req.user)) {
            await LogService.log({
                adminId: req.user.id,
                action: 'MFA_DISABLE_REFUSED',
                entityType: 'admin',
                entityId: req.user.id,
                details:
                    'superadmin_mfa_mandatory: a SuperAdmin cannot deactivate two-factor authentication',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            }).catch(() => {});
            req.flash(
                'error',
                req.t
                    ? req.t('flash:mfa_superadmin_disable_blocked')
                    : 'La double authentification d’un super administrateur est obligatoire : elle ne peut pas être désactivée.'
            );
            return res.redirect('/v2/uam/mfa/manage');
        }
        const code = String(req.body.code || '').trim();
        const ok =
            (await MfaService.verifyAtLogin({ userType, userId: req.user.id, code })) ||
            (await MfaService.consumeBackupCode({ userType, userId: req.user.id, code }));
        if (!ok) {
            req.flash(
                'error',
                req.t
                    ? req.t('flash:mfa_invalid_code_deactivate')
                    : 'Invalid code — enter a current authenticator code (or a backup code) to deactivate.'
            );
            return res.redirect('/v2/uam/mfa/manage');
        }
        await MfaService.disable({ userType, userId: req.user.id });
        await LogService.log({
            adminId: userType === 'admin' ? req.user.id : null,
            action: 'MFA_DISABLED',
            entityType: userType,
            entityId: req.user.id,
            details: `Two-factor auth deactivated for ${userType} ${req.user.username || req.user.id}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        }).catch(() => {});
        req.flash(
            'success',
            req.t
                ? req.t('flash:mfa_deactivated')
                : 'Two-factor authentication has been deactivated.'
        );
        res.redirect('/v2/uam/mfa/manage');
    })
);

// ----- Maker-Checker -----
// the read path moved to MakerCheckerController — filters
// (state / kind / site), paging, translated states and kinds, maker names.
const MakerCheckerController = require('../controllers/MakerCheckerController');
router.get(
    '/maker-checker/queue',
    requireAuth,
    requireSuperAdmin,
    ah(MakerCheckerController.queue)
);

/**
 * la phrase du refus, dans la langue de la session.
 *
 * `MakerCheckerService.decide` timbre le statut et un code stable ; ici on lui
 * donne sa PHRASE. Sans `userMessage`, `asyncHandler` afficherait le message
 * technique anglais du service (« Maker cannot be checker ») sur une session
 * française : la parité FR/EN vaut aussi pour un refus. Une erreur sans `code`
 * ni `status` (panne du gestionnaire, type inconnu) traverse INTACTE et reste
 * un 500 — c'en est un.
 */
const MC_REFUSAL_KEY = {
    mc_not_found: 'admin:mcq_err_not_found',
    mc_maker_is_checker: 'admin:mcq_err_maker_is_checker',
    mc_already_decided: 'admin:mcq_err_already_decided',
};

function mcRefusal(req, e) {
    const key = e && e.code ? MC_REFUSAL_KEY[e.code] : null;
    if (!key || !e.status) return e;
    const state = e.mcState
        ? req.t
            ? req.t(`admin:mcq_state_${e.mcState}`, { defaultValue: e.mcState })
            : e.mcState
        : '';
    e.userMessage = req.t ? req.t(key, { defaultValue: e.message, state }) : e.message;
    return e;
}

router.post(
    '/maker-checker/:id/decide',
    requireAuth,
    requireSuperAdmin,
    ah(async (req, res) => {
        let result;
        try {
            result = await MakerCheckerService.decide({
                id: Number(req.params.id),
                checkerId: req.user.id,
                approve: req.body.decision === 'approve',
                reason: req.body.reason,
            });
        } catch (e) {
            throw mcRefusal(req, e);
        }
        // the resulting state is a translated word, never the raw enum.
        const stateLabel = req.t
            ? req.t(`admin:mcq_state_${result.state}`, { defaultValue: result.state })
            : result.state;
        req.flash(
            'success',
            req.t ? req.t('flash:mc_decision', { state: stateLabel }) : `Decision: ${result.state}`
        );
        res.redirect('/v2/uam/maker-checker/queue');
    })
);

module.exports = router;
