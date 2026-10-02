const PRODUCT = require('../config/product');
const AuthService = require('../services/AuthService');
const EmployeeAuthService = require('../services/EmployeeAuthService');
const passwordValidator = require('../utils/passwordValidator');
const passport = require('passport');
const MfaService = require('../services/MfaService');
const LogService = require('../services/LogService');
const EmployeeModel = require('../models/EmployeeModel');

// Build a queryable actor reference for a non-admin (employee/manager) actor, e.g.
// "employee#12 J. Doe" / "manager#5 EMP0007". Returns null for admins (tracked via
// admin_id) or when there is no identifiable user.
function actorRefOf(u) {
    if (!u || !u.id || u.userType === 'admin') return null;
    const label = u.username || u.employeeNumber || '';
    return `${u.userType || 'user'}#${u.id}${label ? ' ' + label : ''}`;
}

// Audit an authentication/security event to system_logs (best-effort; never throws).
// Records WHO acted: admin_id for admins, actor_ref for employees/managers (explicit
// actorRef wins; otherwise derived from req.user when it is already established).
function authAudit(req, action, details, adminId = null, actorRef = null) {
    try {
        LogService.log({
            adminId,
            actorRef: actorRef || (adminId ? null : actorRefOf(req.user)),
            action,
            entityType: 'auth',
            details,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
    } catch (_) {
        /* logging must never break auth */
    }
}

/** An admin principal whose role is SuperAdmin (C2, 3.23.20). */
function isSuperadminUser(u) {
    return !!u && u.userType === 'admin' && u.role === 'superadmin';
}

/** C2f: security alert to every SuperAdmin — fire-and-forget, never blocks auth. */
function superadminAlert(kind, user, { detail = null, hourly = false } = {}) {
    try {
        require('../services/SuperadminAlertService')
            .alert(kind, {
                targetAdminId: user && user.id,
                username: user && user.username,
                detail,
                hourly,
            })
            .catch(() => {});
    } catch (_) {
        /* alerts never break auth */
    }
}

/**
 * Re-authentication for a self-service e-mail change (3.23.17, S-08). The
 * address is where the password-reset link goes: changing it from an unlocked
 * session (a borrowed laptop, a hijacked cookie) is an account takeover in two
 * steps. Returns 'ok' | 'missing' | 'bad' | 'no_local_password'.
 */
async function ownPasswordCheck(record, supplied) {
    const noLocal =
        !record ||
        !record.passwordHash ||
        record.passwordDisabled === true ||
        record.password_disabled === true;
    if (noLocal) return 'no_local_password';
    if (!supplied) return 'missing';
    const ok = await require('bcrypt')
        .compare(String(supplied), record.passwordHash)
        .catch(() => false);
    return ok ? 'ok' : 'bad';
}

/** Flash + redirect for a refused self e-mail change; null when allowed. */
function emailChangeRefusal(verdict, T) {
    if (verdict === 'ok') return null;
    if (verdict === 'no_local_password')
        return T(
            'auth:profile_email_no_local_password',
            'Votre compte se connecte uniquement par SSO : il n’a pas de mot de passe local pour confirmer ce changement. Demandez à un administrateur de modifier votre adresse e-mail.'
        );
    if (verdict === 'bad')
        return T(
            'auth:profile_email_bad_password',
            'Mot de passe actuel incorrect : votre adresse e-mail n’a pas été modifiée.'
        );
    return T(
        'auth:profile_email_needs_password',
        'Pour changer votre adresse e-mail, saisissez votre mot de passe actuel.'
    );
}

// How long a password-verified login may sit on the MFA code screen.
const MFA_PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * Localize the password policy.
 *
 * `utils/passwordValidator` returns ENGLISH prose ("Password must be at least 12
 * characters long"), and every caller used to splice that straight into a flash
 * message — so a French-first UI refused a French user's password in English,
 * while the hint above the very same field promised "8 caractères". Two defects
 * in one sentence: the wrong number, and the wrong language.
 *
 * The validator lives outside this lot, so the mapping is done HERE, on the
 * stable, distinctive part of each rule. Anything unrecognised falls back to a
 * localized generic line — an unmapped rule must never leak English prose.
 */
const PW_RULE_KEYS = [
    [/at least \d+ characters/i, 'flash:pw_rule_min_length'],
    [/not exceed \d+ characters/i, 'flash:pw_rule_max_length'],
    [/lowercase/i, 'flash:pw_rule_lowercase'],
    [/uppercase/i, 'flash:pw_rule_uppercase'],
    [/one number/i, 'flash:pw_rule_number'],
    [/special character/i, 'flash:pw_rule_special'],
    [/too common/i, 'flash:pw_rule_common'],
    [/repeated characters/i, 'flash:pw_rule_repeats'],
    [/sequential characters/i, 'flash:pw_rule_sequential'],
    [/keyboard patterns/i, 'flash:pw_rule_keyboard'],
    [/substitutions/i, 'flash:pw_rule_substitutions'],
    [/is required/i, 'flash:pw_rule_required'],
];
const PW_RULE_FALLBACKS = {
    'flash:pw_rule_min_length': 'Le mot de passe doit contenir au moins 12 caractères.',
    'flash:pw_rule_max_length': 'Le mot de passe ne doit pas dépasser 128 caractères.',
    'flash:pw_rule_lowercase': 'Le mot de passe doit contenir au moins une minuscule.',
    'flash:pw_rule_uppercase': 'Le mot de passe doit contenir au moins une majuscule.',
    'flash:pw_rule_number': 'Le mot de passe doit contenir au moins un chiffre.',
    'flash:pw_rule_special': 'Le mot de passe doit contenir au moins un caractère spécial.',
    'flash:pw_rule_common': 'Ce mot de passe est trop courant. Choisissez-en un plus robuste.',
    'flash:pw_rule_repeats':
        'Le mot de passe ne doit pas répéter le même caractère plus de 3 fois de suite.',
    'flash:pw_rule_sequential':
        'Le mot de passe ne doit pas contenir de suite de caractères (« abcd », « 1234 »).',
    'flash:pw_rule_keyboard': 'Le mot de passe ne doit pas contenir de motif clavier courant.',
    'flash:pw_rule_substitutions':
        'Le mot de passe contient une substitution de lettres trop connue.',
    'flash:pw_rule_required': 'Le mot de passe est obligatoire.',
    'flash:pw_rule_other': 'Le mot de passe ne respecte pas la politique de sécurité.',
};

/** Translate one validator error string into the request's language. */
function localizePasswordError(req, message) {
    const hit = PW_RULE_KEYS.find(([re]) => re.test(String(message || '')));
    const key = hit ? hit[1] : 'flash:pw_rule_other';
    return req && req.t
        ? req.t(key, { defaultValue: PW_RULE_FALLBACKS[key] })
        : PW_RULE_FALLBACKS[key];
}

/** Translate a whole `validate.errors` array into one localized sentence. */
function localizePasswordErrors(req, errors) {
    const seen = new Set();
    return (errors || [])
        .map((e) => localizePasswordError(req, e))
        .filter((m) => (seen.has(m) ? false : seen.add(m)))
        .join(' ');
}

/**
 * Localize an auth SERVICE result message.
 *
 * AuthService/EmployeeAuthService return English sentences ("Current password is
 * incorrect"), and the controller used to flash them verbatim onto a French
 * page. Same treatment as the policy above: map the stable phrase, and fall back
 * to a localized generic rather than the raw English.
 */
const AUTH_MSG_KEYS = [
    [/current password is incorrect/i, 'flash:pw_current_incorrect'],
    [/not activated|not found/i, 'flash:pw_account_not_activated'],
    [/recently used|password history/i, 'flash:pw_recently_used'],
    [/^password:/i, null], // policy text — handled by localizePasswordErrors
];
function localizeAuthMessage(req, message, fallbackKey = 'flash:pw_change_error') {
    const msg = String(message || '');
    if (/^password:/i.test(msg)) {
        return localizePasswordErrors(req, msg.replace(/^password:\s*/i, '').split(/;\s*/));
    }
    const hit = AUTH_MSG_KEYS.find(([re, key]) => key && re.test(msg));
    const key = hit ? hit[1] : fallbackKey;
    const FB = {
        'flash:pw_current_incorrect': 'Le mot de passe actuel est incorrect.',
        'flash:pw_account_not_activated': 'Compte introuvable ou non activé.',
        'flash:pw_recently_used':
            'Ce mot de passe a déjà été utilisé récemment. Choisissez-en un autre.',
        'flash:pw_change_error': 'Une erreur est survenue lors du changement de mot de passe.',
    };
    return req && req.t
        ? req.t(key, { defaultValue: FB[key] || FB['flash:pw_change_error'] })
        : FB[key] || FB['flash:pw_change_error'];
}

/**
 * Amendment A1 — the ONE answer to a refused password sign-in (or reset) while SSO
 * is enforced: same message, same status (302), same destination, whatever the
 * reason. Anti-enumeration: the page never tells which accounts exist.
 */
function enforcedRefusal(req, res) {
    req.flash(
        'error',
        req.t
            ? req.t('flash:auth_password_sso_enforced')
            : 'Connexion par mot de passe non autorisée ou identifiants invalides. Utilisez la connexion SSO.'
    );
    return res.redirect('/login?breakglass=1');
}

function homeFor(userType) {
    if (userType === 'employee') return '/employee/dashboard';
    if (userType === 'manager') return '/supervisor/dashboard';
    return '/dashboard';
}

/** Best-effort friendly device string from a User-Agent (no external dep). */
/**
 * The session buckets a person's sessions can live in.
 *
 * `deserializeUser` recomputes `userType` on every request, so the bucket a session
 * row was written into is whatever the person was when they SIGNED IN — while
 * `req.user.userType` is what they are now. Querying only the current type meant an
 * employee who has since become a manager (20 of the 77 here) saw an EMPTY
 * /account/sessions while sessions were live, and "sign out my other devices"
 * deleted 0 rows and still reported success. A non-admin therefore owns both.
 */
function sessionBuckets(userType) {
    return userType === 'admin' ? ['admin'] : ['employee', 'manager'];
}

/**
 * "Browser on Unknown OS" / "Unknown device" were English sentences
 * built in code and printed on the French session pages. Product names (Windows,
 * macOS, Chrome...) stay verbatim - they are brands, not prose; the words AROUND
 * them come from locales.
 */
function describeDevice(ua, req) {
    const T = (key, fallback, vars) =>
        req && typeof req.t === 'function'
            ? req.t('chrome:' + key, Object.assign({ defaultValue: fallback }, vars || {}))
            : fallback;
    if (!ua) return T('sess_device_unknown', 'Unknown device');
    const s = String(ua);
    const os = /Windows NT/i.test(s)
        ? 'Windows'
        : /Mac OS X|Macintosh/i.test(s)
          ? 'macOS'
          : /Android/i.test(s)
            ? 'Android'
            : /iPhone|iPad|iOS/i.test(s)
              ? 'iOS'
              : /Linux/i.test(s)
                ? 'Linux'
                : T('sess_os_unknown', 'unknown OS');
    const br = /Edg\//i.test(s)
        ? 'Edge'
        : /OPR\/|Opera/i.test(s)
          ? 'Opera'
          : /Chrome\//i.test(s)
            ? 'Chrome'
            : /Firefox\//i.test(s)
              ? 'Firefox'
              : /Safari\//i.test(s)
                ? 'Safari'
                : T('sess_browser_generic', 'Browser');
    return T('sess_device_on', `${br} on ${os}`, { browser: br, os });
}

class AuthController {
    async showLogin(req, res) {
        if (req.isAuthenticated()) {
            return res.redirect('/dashboard');
        }
        // NOTE: express-ejs-layouts only honours `layout:false` in the RENDER OPTIONS.
        // `res.locals.layout = false` falls through to `options.layout || res.locals.layout
        // || defaultLayout` → false is falsy → the default layout is applied anyway, and the
        // standalone page gets wrapped in a second <html>/<body>. Always pass it in options.
        let ssoProviders = [];
        try {
            ssoProviders = require('../config/sso').getEnabledProviders();
        } catch (_) {
            /* SSO optional */
        }
        let signupEnabled = false;
        try {
            const OnboardingService = require('../services/OnboardingService');
            signupEnabled = await OnboardingService.allowSignup();
            // SSO-only registration still deserves the "Create an account" link —
            // /signup then shows the one-click SSO buttons instead of the form.
            if (!signupEnabled && ssoProviders.length)
                signupEnabled = await OnboardingService.allowSso();
        } catch (_) {
            /* onboarding optional */
        }
        // Only surface self-service reset when email can actually deliver the link.
        let emailEnabled = false;
        try {
            emailEnabled = await require('../services/EmailService').isEnabled();
        } catch (_) {
            /* off */
        }
        // 3.23.19 (amendment A1): with at least one SSO provider, SSO is ENFORCED —
        // the page shows the SSO button(s) only, plus one discreet break-glass link
        // (/login?breakglass=1) that renders the password form for the SuperAdmin.
        // The page is only the UX: the local strategy refuses every other account.
        // enforcement follows the SSO switch INTENT, not provider health — an
        // SSO switched on with no working provider stays enforced, and the page
        // says so (the SuperAdmin break-glass is then the only way in).
        const AdminSsoPage = require('../services/AdminSsoService');
        const ssoEnforced = AdminSsoPage.isEnforced() || ssoProviders.length > 0;
        const ssoDegraded = ssoEnforced && ssoProviders.length === 0;
        const breakglass = ssoEnforced && String((req.query && req.query.breakglass) || '') === '1';
        if (ssoEnforced) {
            // No local signup while enforced (SSO onboarding stays); no reset link.
            try {
                signupEnabled = await require('../services/OnboardingService').allowSso();
            } catch (_) {
                signupEnabled = false;
            }
            emailEnabled = false;
        }
        // C3h (3.23.20): who to contact — printed under the SSO button.
        let ssoHelpContact = null;
        // EXC (3.23.21): employees a SuperAdmin listed as SSO exceptions use the
        // same discreet password link — its wording then says so, and the reset
        // link is offered on that page (a reset is refused for anyone else).
        let ssoExceptions = false;
        if (ssoEnforced) {
            try {
                ssoHelpContact = await require('../services/SsoInviteService').helpContact();
            } catch (_) {
                ssoHelpContact = null;
            }
            try {
                ssoExceptions = (await AdminSsoPage.countSsoExceptions()) > 0;
            } catch (_) {
                ssoExceptions = false;
            }
            if (ssoExceptions) {
                try {
                    emailEnabled = await require('../services/EmailService').isEnabled();
                } catch (_) {
                    emailEnabled = false;
                }
            }
        }
        res.render('pages/auth/login', {
            layout: false,
            title: req.t ? req.t('chrome:pt_login') : 'Login',
            ssoProviders,
            ssoHelpContact,
            ssoExceptions,
            ssoEnforced,
            ssoDegraded,
            breakglass,
            signupEnabled,
            emailEnabled,
            notice: req.query.expired
                ? req.t
                    ? req.t('auth:notice_session_expired')
                    : "Votre session a expiré après une période d'inactivité. Veuillez vous reconnecter."
                : req.query.loggedout
                  ? req.t
                      ? req.t('auth:notice_signed_out')
                      : 'Vous avez été déconnecté.'
                  : null,
        });
    }

    async login(req, res, next) {
        // Auto-detect user type based on username/password
        passport.authenticate('local', (err, user, info) => {
            if (err) {
                console.error('Login error:', err);
                req.flash(
                    'error',
                    req.t ? req.t('flash:auth_login_error') : 'An error occurred during login'
                );
                return res.redirect('/login');
            }
            // 3.23.19 (amendment A1): while SSO is enforced, EVERY refusal of a
            // password sign-in reads the same and lands on the same page — the
            // reason (not a SuperAdmin, unknown, bad password…) is in the audit only.
            if (require('../services/AdminSsoService').isEnforced()) {
                // EXC (3.23.21): an active SuperAdmin, or an employee a SuperAdmin
                // listed as an SSO exception.
                const superOk = require('../services/AdminSsoService').passwordAllowedWhileEnforced(
                    user
                );
                if (!user || !superOk) {
                    if (user && !superOk)
                        authAudit(
                            req,
                            'LOGIN_BLOCKED',
                            `password_login_blocked_sso_enforced: ${user.userType} #${user.id}`,
                            user.userType === 'admin' ? user.id : null
                        );
                    return enforcedRefusal(req, res);
                }
            }
            if (!user) {
                const attempted = String(req.body.username || '').slice(0, 64);
                console.log('Login failed:', info?.message || 'Invalid credentials');
                // ONE row per attempt: AuthService / EmployeeAuthService
                // already wrote the attempt with the person on it; this third,
                // unattributed LOGIN_FAILED row only repeated the same keystrokes.
                // The passport-level failure (no strategy answer at all) is kept.
                if (!info || !info.message)
                    authAudit(
                        req,
                        'LOGIN_FAILED',
                        `Failed login for "${attempted}": no strategy answer`
                    );
                // an expired invitation is told to the person — it
                // discloses nothing new (they hold the temporary password) and
                // stops the "Identifiants invalides → retry → call the admin" loop.
                const refusalCode = EmployeeAuthService.takeRefusalCode(req.body.username);
                // If this identity is awaiting onboarding placement, guide them to
                // the holding page instead of a bare "invalid credentials".
                (async () => {
                    try {
                        const ident = String(req.body.username || '')
                            .toLowerCase()
                            .trim();
                        if (
                            ident.includes('@') &&
                            (await require('../services/OnboardingService').hasPending(ident))
                        ) {
                            return res.redirect('/onboarding/pending');
                        }
                    } catch (_) {
                        /* fall through to the standard message */
                    }
                    // NEVER `info?.message ||` here: passport strategies return
                    // English prose ("Invalid credentials", "Account locked"),
                    // and preferring it overrode the localized key on a
                    // French-first login page. `info.message` still reaches the
                    // audit line above, where English is correct — the flash the
                    // person reads is localized, always.
                    if (refusalCode === 'INVITATION_EXPIRED') {
                        req.flash(
                            'error',
                            req.t
                                ? req.t('flash:auth_invitation_expired')
                                : 'Your invitation has expired. Please contact your administrator to receive a new one.'
                        );
                        return res.redirect('/login');
                    }
                    req.flash(
                        'error',
                        req.t ? req.t('flash:auth_invalid_credentials') : 'Invalid credentials'
                    );
                    return res.redirect('/login');
                })();
                return;
            }
            // Two-factor: when the account has confirmed MFA, do NOT establish
            // the session yet — park the identity and ask for the TOTP code.
            (async () => {
                let mfaActive = false;
                try {
                    mfaActive = await MfaService.isActive({
                        userType: MfaService.mfaUserType(user),
                        userId: user.id,
                    });
                } catch (e) {
                    // FAIL CLOSED. A failed lookup used to be read as "no MFA" and
                    // opened the session on the password alone: a database hiccup
                    // (or anything that makes this query throw) skipped the second
                    // factor. The sign-in is refused with the generic error and the
                    // reason is logged.
                    console.error('Login MFA lookup failed, sign-in refused:', e && e.message);
                    authAudit(
                        req,
                        'LOGIN_MFA_CHECK_FAILED',
                        `MFA state of ${user.userType} "${user.username || user.employeeNumber || user.id}" could not be read; sign-in refused (fail closed)`,
                        user.userType === 'admin' ? user.id : null,
                        actorRefOf(user)
                    );
                    req.flash(
                        'error',
                        req.t ? req.t('flash:auth_login_error') : 'An error occurred during login'
                    );
                    return res.redirect('/login');
                }

                if (mfaActive) {
                    authAudit(
                        req,
                        'MFA_CHALLENGE',
                        `MFA code requested for ${user.userType} "${user.username || user.employeeNumber}"`,
                        user.userType === 'admin' ? user.id : null
                    );
                    // Rotate the session id at the password→MFA boundary too (not
                    // only after MFA succeeds) so a pre-auth fixated id can't be
                    // reused to ride the pending-MFA session.
                    return req.session.regenerate((rerr) => {
                        if (rerr) console.error('Session regenerate (pre-MFA) error:', rerr);
                        req.session.mfaPending = {
                            id: user.id,
                            userType: user.userType,
                            // A wrong code counts toward THIS account's lockout.
                            username: user.username || null,
                            at: Date.now(),
                        };
                        return req.session.save(() => res.redirect('/login/mfa'));
                    });
                }

                // S13 (3.23.19): while SSO is enforced, the SuperAdmin break-glass
                // with NO local MFA is held on MFA enrolment before anything else
                // (the password is proven; a second factor is not).
                // C2b (3.23.20): a SuperAdmin is ALWAYS held without MFA — with or
                // without SSO. (mfaEnforcement derives the same hold from the role.)
                const enforcedNow = require('../services/AdminSsoService').isEnforced();
                // EXC: an employee SSO exception is not held (employees are outside
                // the admin MFA policy); only an administrator account is.
                const holdForEnrolment =
                    (enforcedNow && user.userType === 'admin') || isSuperadminUser(user);
                // Rotate the session ID on privilege change to prevent session fixation.
                req.session.regenerate((rerr) => {
                    if (rerr) console.error('Session regenerate error:', rerr);
                    req.logIn(user, (err) => {
                        if (err) {
                            console.error('Login session error:', err);
                            req.flash(
                                'error',
                                req.t
                                    ? req.t('flash:auth_session_failed')
                                    : 'Failed to create session'
                            );
                            return res.redirect('/login');
                        }
                        // the hold is set on the FINAL session — passport 0.6
                        // regenerates it inside logIn and copies nothing across —
                        // before the response (and therefore before it is saved).
                        if (holdForEnrolment) req.session.mfaEnrolRequired = true;
                        console.log(
                            'Login successful for:',
                            user.username || user.employeeNumber,
                            'Type:',
                            user.userType
                        );
                        authAudit(
                            req,
                            'LOGIN_SUCCESS',
                            `${user.userType} "${user.username || user.employeeNumber}" signed in`,
                            user.userType === 'admin' ? user.id : null,
                            actorRefOf(user)
                        );
                        if (enforcedNow && isSuperadminUser(user))
                            superadminAlert('security.breakglass_signin', user, {
                                detail: 'password, no two-factor yet (held on enrolment)',
                            });
                        if (holdForEnrolment) return res.redirect('/v2/uam/mfa/setup');
                        return res.redirect(homeFor(user.userType));
                    });
                });
            })().catch((e) => {
                console.error('Login MFA check error:', e);
                req.flash(
                    'error',
                    req.t ? req.t('flash:auth_login_error') : 'An error occurred during login'
                );
                res.redirect('/login');
            });
        })(req, res, next);
    }

    /** Step 2 of login for MFA-enabled accounts: ask for the 6-digit code. */
    async showMfaChallenge(req, res) {
        const pending = req.session.mfaPending;
        if (!pending || Date.now() - pending.at > MFA_PENDING_TTL_MS) {
            delete req.session.mfaPending;
            req.flash(
                'error',
                req.t
                    ? req.t('flash:auth_signin_expired')
                    : 'Your sign-in expired — please log in again.'
            );
            return res.redirect('/login');
        }
        // standalone, like the login page — see the note in showLogin: `layout:false`
        // must live in the render OPTIONS, not res.locals.
        res.render('pages/auth/login-mfa', {
            layout: false,
            title: req.t ? req.t('chrome:pt_two_factor_verification') : 'Two-Factor Verification',
        });
    }

    async verifyMfaChallenge(req, res) {
        try {
            const pending = req.session.mfaPending;
            if (!pending || Date.now() - pending.at > MFA_PENDING_TTL_MS) {
                delete req.session.mfaPending;
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:auth_signin_expired')
                        : 'Your sign-in expired — please log in again.'
                );
                return res.redirect('/login');
            }

            const code = String(req.body.code || '').trim();
            const userType = pending.userType === 'admin' ? 'admin' : 'employee';
            const totpOk = await MfaService.verifyAtLogin({ userType, userId: pending.id, code });
            const backupOk =
                !totpOk &&
                (await MfaService.consumeBackupCode({ userType, userId: pending.id, code }));
            const ok = totpOk || backupOk;
            if (!ok) {
                authAudit(
                    req,
                    'MFA_FAILED',
                    `Invalid MFA code for ${pending.userType} #${pending.id}`,
                    pending.userType === 'admin' ? pending.id : null
                );
                // A wrong second factor is a failed authentication of this
                // account: it feeds the account lockout policy too.
                await require('../middleware/rateLimiter').noteAuthenticatedFailure(
                    {
                        id: pending.id,
                        userType: pending.userType === 'admin' ? 'admin' : 'employee',
                        username: pending.username || null,
                    },
                    req.ip
                );
                // Throttle brute force of the 6-digit code: invalidate the pending
                // sign-in after 5 wrong codes, forcing a full re-login.
                pending.fails = (pending.fails || 0) + 1;
                req.session.mfaPending = pending;
                if (pending.fails >= 5) {
                    authAudit(
                        req,
                        'MFA_LOCKED',
                        `Too many invalid MFA codes for ${pending.userType} #${pending.id}`,
                        pending.userType === 'admin' ? pending.id : null
                    );
                    delete req.session.mfaPending;
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:auth_too_many_codes')
                            : 'Too many invalid codes — please sign in again.'
                    );
                    return res.redirect('/login');
                }
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:auth_invalid_code')
                        : 'Invalid code. Use your authenticator app or a backup code.'
                );
                return res.redirect('/login/mfa');
            }

            // Rebuild the user exactly like passport.deserializeUser does.
            let user;
            if (pending.userType === 'employee' || pending.userType === 'manager') {
                const EmployeeModel = require('../models/EmployeeModel');
                user = await EmployeeModel.findByIdWithOrganization(pending.id);
                if (user) {
                    const gov = await EmployeeModel.governanceOf(pending.id);
                    const isManager = gov.governs;
                    user.userType = isManager ? 'manager' : 'employee';
                    user.isManager = isManager;
                    user.isSupervisorOf = gov.supervises;
                    user.isPeopleManager = gov.manages;
                }
            } else {
                const AdminModel = require('../models/AdminModel');
                user = await AdminModel.findWithScopes(pending.id);
                if (user) user.userType = 'admin';
            }
            if (!user) {
                delete req.session.mfaPending;
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:auth_account_not_found')
                        : 'Account not found — please log in again.'
                );
                return res.redirect('/login');
            }

            // 3.23.19: the first factor was an SSO sign-in to an ADMIN account.
            // Re-check the admin now (D2/D4 — minutes may have passed on the code
            // screen), and for the linked-person route that the link still holds.
            const viaSso = pending.via === 'sso' && user.userType === 'admin';
            // a PASSWORD first factor opens only an active SuperAdmin while SSO
            // is enforced (a code screen reached just before enforcement began, too).
            const AdminSsoGate = require('../services/AdminSsoService');
            if (
                pending.via !== 'sso' &&
                AdminSsoGate.isEnforced() &&
                !AdminSsoGate.passwordAllowedWhileEnforced(user)
            ) {
                delete req.session.mfaPending;
                authAudit(
                    req,
                    'LOGIN_BLOCKED',
                    `password_login_blocked_sso_enforced: ${user.userType} #${user.id} at the MFA step`,
                    user.userType === 'admin' ? user.id : null
                );
                return enforcedRefusal(req, res);
            }
            if (viaSso) {
                const AdminSso = require('../services/AdminSsoService');
                const el = await AdminSso.eligibility(pending.id);
                const linked = el.admin
                    ? Number(el.admin.linkedEmployeeId ?? el.admin.linked_employee_id)
                    : NaN;
                const reason = !el.ok
                    ? el.reason
                    : pending.method === 'linked-person' && linked !== Number(pending.employeeId)
                      ? 'chooser_invalid'
                      : null;
                if (reason) {
                    delete req.session.mfaPending;
                    authAudit(
                        req,
                        'SSO_DENIED',
                        `${pending.provider || 'sso'}: ${reason} — admin #${pending.id} at the MFA step`,
                        pending.id
                    );
                    if (reason === 'superadmin_sso_forbidden')
                        superadminAlert('security.superadmin_sso_refused', user, {
                            detail: `${pending.provider || 'sso'}: at the MFA step`,
                            hourly: true,
                        });
                    // UX-4: the one generic refusal, with whom to contact.
                    let vars = { app: PRODUCT.name, contact: 'votre administrateur' };
                    try {
                        const b = await require('../utils/branding').getBranding();
                        const c = await require('../services/SsoInviteService').helpContact();
                        vars = {
                            app: (b && b.appName) || vars.app,
                            contact:
                                c || (req.t ? req.t('auth:ssoinv_contact_default') : vars.contact),
                        };
                    } catch (_) {
                        /* stock wording */
                    }
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:sso_not_successful', vars)
                            : `La connexion n’a pas abouti. Votre accès n’est peut-être pas (ou plus) ouvert dans ${vars.app}. Contactez ${vars.contact} en indiquant l’heure de la tentative.`
                    );
                    return res.redirect('/login');
                }
            }

            // the session opened here came through SSO — say so, with the
            // linked person for the D3b route. L1: a PASSWORD first factor while
            // SSO is enforced is the SuperAdmin break-glass — recorded as such.
            if (viaSso)
                require('./SsoController')._internals.markSso(
                    user,
                    pending.method === 'linked-person' ? pending.employeeId : null
                );
            else if (user.userType === 'admin' && AdminSsoGate.isEnforced())
                Object.defineProperty(user, '_sessionVia', {
                    value: { via: 'breakglass' },
                    enumerable: false,
                    configurable: true,
                });
            delete req.session.mfaPending;
            // Rotate the session ID once MFA passes (prevents fixation).
            req.session.regenerate((rerr) => {
                if (rerr) console.error('Session regenerate error:', rerr);
                req.logIn(user, (err) => {
                    if (err) {
                        console.error('MFA login session error:', err);
                        req.flash(
                            'error',
                            req.t ? req.t('flash:auth_session_failed') : 'Failed to create session'
                        );
                        return res.redirect('/login');
                    }
                    // the second factor was proven IN THIS session — set on
                    // the final session (after passport's own regenerate).
                    req.session.mfaVerifiedInSession = true;
                    console.log(
                        'MFA login successful for:',
                        user.username || user.employeeNumber,
                        'Type:',
                        user.userType
                    );
                    if (viaSso) {
                        // first factor SSO, second factor the local code.
                        const { ssoAdminAudits } = require('./SsoController')._internals;
                        for (const [action, details, adminId] of ssoAdminAudits(
                            user,
                            pending.provider || 'sso',
                            pending.method || 'direct',
                            'local'
                        ))
                            authAudit(req, action, details, adminId);
                        if (pending.method === 'direct')
                            require('../services/SsoService')
                                .stampAdminIdentityUse(pending.provider, pending.mapped, user.id)
                                .catch(() => {});
                        const { safeRelayPath } = require('../services/SamlSecurityService');
                        return res.redirect(safeRelayPath(pending.relay) || homeFor(user.userType));
                    }
                    authAudit(
                        req,
                        'LOGIN_SUCCESS',
                        `${user.userType} "${user.username || user.employeeNumber}" signed in (MFA verified)`,
                        user.userType === 'admin' ? user.id : null,
                        actorRefOf(user)
                    );
                    // C2f (3.23.20): the other SuperAdmins hear of a break-glass
                    // sign-in while SSO is enforced, and of a recovery-code use.
                    if (isSuperadminUser(user)) {
                        if (AdminSsoGate.isEnforced())
                            superadminAlert('security.breakglass_signin', user, {
                                detail: 'password + two-factor code',
                            });
                        if (backupOk)
                            superadminAlert('security.superadmin_mfa_changed', user, {
                                detail: 'a backup (recovery) code was used to sign in',
                            });
                    }
                    return res.redirect(homeFor(user.userType));
                });
            });
        } catch (error) {
            console.error('MFA verification error:', error);
            req.flash(
                'error',
                req.t
                    ? req.t('flash:auth_verification_error')
                    : 'An error occurred during verification'
            );
            res.redirect('/login/mfa');
        }
    }

    async logout(req, res) {
        const u = req.user;
        if (u)
            authAudit(
                req,
                'LOGOUT',
                `${u.userType || 'user'} "${u.username || u.employeeNumber || u.id}" signed out`,
                u.userType === 'admin' ? u.id : null
            );
        req.logout((err) => {
            if (err) {
                return res.redirect('/dashboard');
            }
            // Fully destroy the server-side session and clear the cookie so the
            // session ID can't be reused after logout.
            req.session.destroy(() => {
                res.clearCookie(process.env.SESSION_COOKIE_NAME || 'app.sid');
                res.redirect('/login?loggedout=1');
            });
        });
    }

    async showChangePassword(req, res) {
        // Layout will be applied automatically (default)
        res.render('pages/auth/change-password', {
            title: req.t ? req.t('chrome:pt_change_password') : 'Change Password',
        });
    }

    // ---- Self-service password reset ("forgot password") ----
    // Best practice: CSPRNG token hashed at rest, short TTL, single-use; the same
    // response whether or not the account exists (anti-enumeration); rate-limited at
    // the route; a successful reset revokes every session for that user.

    async showForgotPassword(req, res) {
        if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/dashboard');
        let emailEnabled = false;
        try {
            emailEnabled = await require('../services/EmailService').isEnabled();
        } catch (_) {
            /* off */
        }
        res.render('pages/auth/forgot-password', {
            layout: false, // full standalone page, like /login
            title: req.t ? req.t('auth:forgot_title') : 'Reset your password',
            emailEnabled,
        });
    }

    async requestPasswordReset(req, res) {
        const identifier = (req.body.identifier || '').toString().trim();
        const generic = req.t
            ? req.t('flash:reset_sent')
            : 'If an account matches, a reset link has been sent to its email address.';
        try {
            const PasswordResetService = require('../services/PasswordResetService');
            const EmailService = require('../services/EmailService');
            const result = await PasswordResetService.requestReset(identifier, req.ip);
            // One address may belong to several accounts (migration 107): the
            // service mints one token per eligible account and each gets its own
            // mail, naming the account, so none is left unrecoverable.
            const resets =
                result.sent && Array.isArray(result.resets) && result.resets.length
                    ? result.resets
                    : result.sent && result.rawToken
                      ? [
                            {
                                rawToken: result.rawToken,
                                email: result.email,
                                name: result.name,
                                subjectType: result.subjectType,
                            },
                        ]
                      : [];
            for (const reset of resets) {
                result.rawToken = reset.rawToken;
                result.email = reset.email;
                result.name = reset.name;
                result.subjectType = reset.subjectType;
                result.accountLine = resets.length > 1 ? reset.name : null;
                // SECURITY — the reset link carries a single-use credential, so its
                // origin comes from server-side config (APP_BASE_URL / TRUSTED_HOSTS),
                // never from the caller's `Host` header. Building it from the header
                // let an attacker request a reset for someone ELSE's account with
                // `Host: evil.test`: the victim received a genuine mail from this
                // platform whose link pointed at the attacker, leaking the token.
                // await the setting rather than using the cached value: this link
                // carries a single-use credential, so it must reflect what the
                // administrator configured RIGHT NOW, not a value up to 30s stale.
                const base = await require('../utils/emailTemplate').baseUrlAsync(req);
                const link = `${base}/reset-password?token=${encodeURIComponent(result.rawToken)}`;
                if (await EmailService.isEnabled().catch(() => false)) {
                    // White-label + FR-first: the brand comes from App Settings (never the
                    // hardcoded product name) and every sentence is localized like the rest
                    // of the chrome. `brand` is admin-supplied, so escape it for the HTML part.
                    const brand =
                        (res.locals && res.locals.branding && res.locals.branding.appName) ||
                        PRODUCT.name;
                    const escHtml = (s) =>
                        String(s)
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;');
                    const T = (key, opts, fallback) =>
                        req.t ? req.t(`chrome:${key}`, opts) : fallback;
                    const mins = result.ttlMinutes;
                    const subject = T(
                        'mail_reset_subject',
                        { brand },
                        `Reset your ${brand} password`
                    );
                    // The link is built from server-side config and a URI-encoded
                    // token, so it cannot carry markup — escape it anyway. It is the
                    // one credential-bearing string in this mail, and an operator
                    // typo in APP_BASE_URL should never be able to break the attribute.
                    const escLink = escHtml(link);
                    const accountLine = result.accountLine
                        ? `<p><strong>${T('mail_reset_account', { name: escHtml(result.accountLine) }, `Account: ${escHtml(result.accountLine)}`)}</strong></p>`
                        : '';
                    const html =
                        `<p>${T('mail_reset_intro', { brand: escHtml(brand) }, `We received a request to reset your ${escHtml(brand)} password.`)}</p>` +
                        accountLine +
                        `<p><a href="${escLink}">${T('mail_reset_cta', {}, 'Choose a new password')}</a> ` +
                        `(${T('mail_reset_validity', { mins }, `link valid for ${mins} minutes`)}).</p>` +
                        `<p>${T('mail_reset_fallback', {}, 'If the link does not work, copy this URL:')}<br><code>${escLink}</code></p>` +
                        `<p>${T('mail_reset_ignore', {}, 'If you did not request this, you can safely ignore this email — your password is unchanged.')}</p>`;
                    const text =
                        `${T('mail_reset_text_lead', { brand }, `Reset your ${brand} password:`)}\n` +
                        (result.accountLine
                            ? `${T('mail_reset_account', { name: result.accountLine }, `Account: ${result.accountLine}`)}\n`
                            : '') +
                        `${link}\n\n` +
                        `${T('mail_reset_text_validity', { mins }, `This link is valid for ${mins} minutes.`)} ` +
                        `${T('mail_reset_ignore', {}, 'If you did not request this, you can safely ignore this email — your password is unchanged.')}`;
                    // Timing: NOT awaited. Awaiting the SMTP round-trip only for
                    // REAL accounts made the response seconds slower exactly when
                    // the identifier exists, an enumeration oracle despite the
                    // identical message. Sent in the background; `result` is
                    // re-used across the loop, so capture THIS mail now.
                    const mail = { to: result.email, subject, html, text };
                    Promise.resolve()
                        .then(() => EmailService.send(mail))
                        .catch((e) => console.error('Reset email send failed:', e && e.message));
                } else {
                    console.warn(
                        `[reset] token created but email delivery is DISABLED — no link sent. ` +
                            `Enable Settings -> Email (SMTP), or use an admin-initiated reset.`
                    );
                }
                authAudit(
                    req,
                    'PASSWORD_RESET_REQUESTED',
                    `Reset requested for ${result.subjectType} ("${identifier}")${resets.length > 1 ? ` — shared address, ${resets.length} accounts served` : ''}`
                );
            }
            if (!resets.length) {
                authAudit(
                    req,
                    'PASSWORD_RESET_REQUESTED',
                    `Reset requested for unknown/no-email "${identifier}" (no link issued)`
                );
            }
        } catch (e) {
            console.error('Password reset request error:', e);
        }
        req.flash('success', generic); // identical response either way
        res.redirect('/login');
    }

    async showResetPassword(req, res) {
        const token = (req.query.token || '').toString();
        try {
            const PasswordResetService = require('../services/PasswordResetService');
            if (!(await PasswordResetService.validate(token))) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:reset_link_invalid')
                        : 'That reset link is invalid or has expired. Please request a new one.'
                );
                return res.redirect('/forgot-password');
            }
            res.render('pages/auth/reset-password', {
                layout: false, // full standalone page, like /login
                title: req.t ? req.t('auth:reset_title') : 'Choose a new password',
                token,
            });
        } catch (e) {
            console.error('Show reset password error:', e);
            req.flash(
                'error',
                req.t
                    ? req.t('flash:reset_link_invalid')
                    : 'That reset link is invalid or has expired. Please request a new one.'
            );
            res.redirect('/forgot-password');
        }
    }

    async resetPassword(req, res) {
        const token = (req.body.token || '').toString();
        const password = (req.body.password || '').toString();
        const passwordConfirm = (req.body.passwordConfirm || '').toString();
        const back = `/reset-password?token=${encodeURIComponent(token)}`;
        try {
            const PasswordResetService = require('../services/PasswordResetService');
            if (!(await PasswordResetService.validate(token))) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:reset_link_invalid')
                        : 'That reset link is invalid or has expired. Please request a new one.'
                );
                return res.redirect('/forgot-password');
            }
            if (!password || password !== passwordConfirm) {
                req.flash(
                    'error',
                    req.t ? req.t('flash:reset_mismatch') : 'The two passwords do not match.'
                );
                return res.redirect(back);
            }
            const check = passwordValidator.validate(password);
            // Localized: /reset-password is a PUBLIC, French-first page — the raw
            // validator prose would be the only English on it.
            if (!check.valid) {
                req.flash('error', localizePasswordErrors(req, check.errors));
                return res.redirect(back);
            }

            const result = await PasswordResetService.consume(token, password);
            if (!result.ok) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:reset_link_invalid')
                        : 'That reset link is invalid or has expired. Please request a new one.'
                );
                return res.redirect('/forgot-password');
            }
            authAudit(
                req,
                'PASSWORD_RESET_COMPLETED',
                `Password reset via link for ${result.subjectType} #${result.subjectId}`,
                result.subjectType === 'admin' ? result.subjectId : null,
                result.subjectType === 'admin' ? null : `${result.subjectType}#${result.subjectId}`
            );
            req.flash(
                'success',
                req.t
                    ? req.t('flash:reset_success')
                    : 'Your password has been reset. Please sign in with your new password.'
            );
            res.redirect('/login');
        } catch (e) {
            console.error('Reset password error:', e);
            req.flash(
                'error',
                req.t
                    ? req.t('flash:reset_link_invalid')
                    : 'That reset link is invalid or has expired. Please request a new one.'
            );
            res.redirect('/forgot-password');
        }
    }

    // ---- « Mon profil » — self-service account profile ----------------------
    //
    // WHY THIS EXISTS: /account/sessions, /account/notifications and
    // /change-password all existed, but there was no page on which a person could
    // read or correct their OWN contact details. The self-service password reset
    // resolves an account to `employees.email` and gives up when it is empty
    // (`{sent:false, reason:'no_email'}`) — and 'test.employee' (#84) is one of the
    // people whose email IS empty. An employee therefore had no way, anywhere in
    // the product, to become reachable by the flow that is supposed to rescue them.
    //
    // WHAT MAY BE EDITED — deliberately narrow: EMAIL and PHONE, on one's OWN row.
    // Role, site, department, service, supervisor/manager, employee number,
    // username, activation flags and every competency record are ORGANISATIONAL
    // facts owned by HR/admin governance; they are rendered read-only here and the
    // write path below never reads them off the request, so posting them by hand
    // changes nothing (see tests/unit/accountProfile.test.js).

    /** Load the signed-in person's own profile (employee/manager) or null (admin). */
    async _ownEmployeeProfile(req) {
        if (!req.user || req.user.userType === 'admin') return null;
        return await EmployeeModel.findByIdWithOrganization(req.user.id);
    }

    async showProfile(req, res) {
        try {
            const isAdmin = req.user.userType === 'admin';
            const employee = await this._ownEmployeeProfile(req);
            if (!isAdmin && !employee) {
                req.flash('error', req.t ? req.t('flash:emp_not_found') : 'Employee not found');
                return res.redirect('/dashboard');
            }
            // An admin edits their OWN e-mail here — the address the
            // self-service password reset depends on. Role, scope, capabilities
            // and state stay with the admin module; only `email` is ever read
            // from the body for an admin (see updateProfile).
            let adminEmail = null;
            if (isAdmin) {
                const AdminModel = require('../models/AdminModel');
                const me = await AdminModel.findById(req.user.id);
                adminEmail = (me && me.email) || req.user.email || '';
            }
            res.render('pages/account/profile', {
                title: req.t ? req.t('chrome:profile_title') : 'Mon profil',
                employee,
                isAdmin,
                adminEditable: isAdmin,
                adminEmail,
                adminUsername: isAdmin ? req.user.username || '' : null,
                form: null,
            });
        } catch (e) {
            console.error('Show profile error:', e);
            req.flash(
                'error',
                req.t ? req.t('flash:profile_load_error') : 'Could not load your profile'
            );
            res.redirect('/dashboard');
        }
    }

    async updateProfile(req, res) {
        const T = (k, fb) => (req.t ? req.t(k, { defaultValue: fb }) : fb);
        try {
            if (req.user.userType === 'admin') {
                // Admin self-service is limited to the e-mail: the only
                // field read from the body, validated like an employee's, with
                // the shared-address advisory instead of a refusal.
                const AdminModel = require('../models/AdminModel');
                const me = await AdminModel.findById(req.user.id);
                if (!me) {
                    req.flash('error', T('flash:admin_not_found', 'Administrateur introuvable'));
                    return res.redirect('/dashboard');
                }
                const email = String(req.body.email == null ? '' : req.body.email)
                    .trim()
                    .toLowerCase();
                if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
                    req.flash(
                        'error',
                        T('flash:profile_email_invalid', 'Adresse e-mail invalide.')
                    );
                    return res.redirect('/account');
                }
                if (email.length > 190) {
                    req.flash('error', T('flash:profile_too_long', 'Valeur trop longue.'));
                    return res.redirect('/account');
                }
                const adminEmailChanged =
                    email !==
                    String(me.email || '')
                        .trim()
                        .toLowerCase();
                if (adminEmailChanged) {
                    const refusal = emailChangeRefusal(
                        await ownPasswordCheck(me, req.body.currentPassword),
                        T
                    );
                    if (refusal) {
                        authAudit(
                            req,
                            'PROFILE_EMAIL_CHANGE_REFUSED',
                            `Own e-mail change refused for admin ${me.username} (re-authentication failed)`,
                            me.id
                        );
                        req.flash('error', refusal);
                        return res.redirect('/account');
                    }
                }
                let emailAdvisory = null;
                if (email && adminEmailChanged) {
                    emailAdvisory = await require('../services/EmailAccountsService')
                        .advisory(req, email, { excludeAdminId: me.id })
                        .catch(() => null);
                }
                await AdminModel.update(me.id, { email: email || null });
                if (adminEmailChanged) {
                    await require('../services/PasswordResetService').onEmailChanged(
                        'admin',
                        me.id,
                        { oldEmail: me.email, newEmail: email, t: req.t, name: me.username }
                    );
                }
                if (emailAdvisory) req.flash('warning', emailAdvisory);
                authAudit(
                    req,
                    'ADMIN_PROFILE_UPDATED',
                    `Own e-mail updated by admin ${me.username} ("${me.email || ''}" -> "${email}")`,
                    me.id
                );
                req.flash(
                    'success',
                    T('flash:profile_saved', 'Vos coordonnées ont été enregistrées.')
                );
                return res.redirect('/account');
            }
            const employeeId = req.user.id;
            const current = await EmployeeModel.findById(employeeId);
            if (!current) {
                req.flash('error', T('flash:emp_not_found', 'Employé introuvable'));
                return res.redirect('/dashboard');
            }

            // Only these two values are ever read from the request body.
            const email = String(req.body.email == null ? '' : req.body.email)
                .trim()
                .toLowerCase();
            const phone = String(req.body.phone == null ? '' : req.body.phone).trim();

            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
                req.flash('error', T('flash:profile_email_invalid', 'Adresse e-mail invalide.'));
                return res.redirect('/account');
            }
            if (email.length > 190 || phone.length > 40) {
                req.flash('error', T('flash:profile_too_long', 'Valeur trop longue.'));
                return res.redirect('/account');
            }
            // A shared address is allowed — a person may hold several accounts
            // (migration 107). It used to be refused because the reset flow took
            // the FIRST account matching an address; the reset flow now issues one
            // link per account, and login by e-mail refuses ambiguity instead of
            // guessing, so the address is accepted and the person is advised.
            const emailChanged =
                email !==
                String(current.email || '')
                    .trim()
                    .toLowerCase();
            if (emailChanged) {
                const refusal = emailChangeRefusal(
                    await ownPasswordCheck(current, req.body.currentPassword),
                    T
                );
                if (refusal) {
                    authAudit(
                        req,
                        'PROFILE_EMAIL_CHANGE_REFUSED',
                        'Own e-mail change refused (re-authentication failed)'
                    );
                    req.flash('error', refusal);
                    return res.redirect('/account');
                }
            }
            let emailAdvisory = null;
            if (email && emailChanged) {
                emailAdvisory = await require('../services/EmailAccountsService')
                    .advisory(req, email, { excludeEmployeeId: employeeId })
                    .catch(() => null);
            }

            // Explicit literal — never a spread of req.body.
            await EmployeeModel.update(employeeId, { email, phone: phone || null });
            if (emailChanged) {
                await require('../services/PasswordResetService').onEmailChanged(
                    'employee',
                    employeeId,
                    {
                        oldEmail: current.email,
                        newEmail: email,
                        t: req.t,
                        name: `${current.firstName || ''} ${current.lastName || ''}`.trim(),
                    }
                );
            }
            if (emailAdvisory) req.flash('warning', emailAdvisory);
            authAudit(
                req,
                'PROFILE_UPDATED',
                `Own contact details updated (email "${current.email || ''}" -> "${email}")`
            );
            req.flash('success', T('flash:profile_saved', 'Vos coordonnées ont été enregistrées.'));
            res.redirect('/account');
        } catch (e) {
            console.error('Update profile error:', e);
            req.flash(
                'error',
                T('flash:profile_save_error', 'Impossible d’enregistrer vos coordonnées.')
            );
            res.redirect('/account');
        }
    }

    /** Account → Active sessions: let a user review + revoke their own sessions. */
    async showSessions(req, res) {
        try {
            const SessionService = require('../services/SessionService');
            const rows = (
                await Promise.all(
                    sessionBuckets(req.user.userType).map((t) =>
                        SessionService.listForUser(req.user.id, t)
                    )
                )
            ).flat();
            const sessions = rows
                .map((s) => ({
                    ...s,
                    current: s.sid === req.sessionID,
                    device: describeDevice(s.userAgent, req),
                }))
                .sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
            res.render('pages/auth/sessions', {
                title: req.t ? req.t('chrome:pt_active_sessions') : 'Active Sessions',
                sessions,
            });
        } catch (e) {
            console.error('Show sessions error:', e);
            req.flash(
                'error',
                req.t
                    ? req.t('flash:auth_sessions_load_error')
                    : 'Could not load your active sessions'
            );
            res.redirect('/dashboard');
        }
    }

    /** Sign out every OTHER session (keep the current device). */
    async revokeOtherSessions(req, res) {
        try {
            const SessionService = require('../services/SessionService');
            const counts = await Promise.all(
                sessionBuckets(req.user.userType).map((t) =>
                    SessionService.revokeOthers(req.user.id, t, req.sessionID)
                )
            );
            const n = counts.reduce((a, b) => a + (Number(b) || 0), 0);
            authAudit(
                req,
                'SESSIONS_REVOKED_OTHERS',
                `Signed out ${n} other session(s)`,
                req.user.userType === 'admin' ? req.user.id : null
            );
            req.flash(
                'success',
                n > 0
                    ? req.t
                        ? req.t('flash:auth_sessions_signed_out', { n, count: n })
                        : `Signed out ${n} other session${n === 1 ? '' : 's'}.`
                    : req.t
                      ? req.t('flash:auth_no_other_sessions')
                      : 'No other active sessions.'
            );
        } catch (e) {
            console.error('Revoke other sessions error:', e);
            req.flash(
                'error',
                req.t
                    ? req.t('flash:auth_sessions_signout_error')
                    : 'Could not sign out your other sessions'
            );
        }
        res.redirect('/account/sessions');
    }

    /** Admin monitor: every active session platform-wide (SuperAdmin only). */
    async adminSessions(req, res) {
        try {
            const SessionService = require('../services/SessionService');
            const rows = await SessionService.listAll();
            const sessions = rows.map((s) => ({
                ...s,
                current: s.sid === req.sessionID,
                device: describeDevice(s.userAgent, req),
            }));
            const named = sessions.filter((s) => !s.anonymous);
            const anonymousCount = sessions.length - named.length;
            res.render('pages/admin/sessions', {
                title: req.t ? req.t('chrome:pt_session_monitor') : 'Session Monitor',
                sessions: named,
                anonymousCount,
            });
        } catch (e) {
            console.error('Admin sessions error:', e);
            req.flash(
                'error',
                req.t ? req.t('flash:auth_sessions_load_error') : 'Could not load active sessions'
            );
            res.redirect('/dashboard');
        }
    }

    /** Admin: force-close one session (any user). Own current session refused. */
    async adminRevokeSession(req, res) {
        try {
            const sid = String(req.body.sid || '');
            if (!sid) {
                req.flash(
                    'error',
                    req.t ? req.t('flash:auth_missing_session_id') : 'Missing session id'
                );
                return res.redirect('/admin/sessions');
            }
            if (sid === req.sessionID) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:auth_cannot_close_own')
                        : 'That is your own current session — use Logout instead.'
                );
                return res.redirect('/admin/sessions');
            }
            const SessionService = require('../services/SessionService');
            const n = await SessionService.revokeBySid(sid);
            authAudit(
                req,
                'SESSION_FORCE_CLOSED',
                `Admin closed session ${sid.slice(0, 8)}… (${n} removed)`,
                req.user.id
            );
            req.flash(
                n ? 'success' : 'error',
                n
                    ? req.t
                        ? req.t('flash:auth_session_closed')
                        : 'Session closed — that device is signed out.'
                    : req.t
                      ? req.t('flash:auth_session_gone')
                      : 'Session no longer exists.'
            );
        } catch (e) {
            console.error('Admin revoke session error:', e);
            req.flash(
                'error',
                req.t ? req.t('flash:auth_sessions_signout_error') : 'Could not close that session'
            );
        }
        res.redirect('/admin/sessions');
    }

    async changePassword(req, res) {
        try {
            const { currentPassword, newPassword, confirmPassword } = req.body;

            if (newPassword !== confirmPassword) {
                req._reauthNotAGuess = true; // nothing was checked against the account
                req.flash(
                    'error',
                    req.t ? req.t('flash:pw_new_mismatch') : 'New passwords do not match'
                );
                return res.redirect('/change-password');
            }

            const isEmployee = req.user.userType === 'employee' || req.user.userType === 'manager';
            let result;
            if (isEmployee) {
                // Employee/manager path enforces the same complexity policy.
                const pw = passwordValidator.validate(newPassword);
                if (!pw.valid) {
                    req._reauthNotAGuess = true; // refused before the current password is read
                    // `flash:pw_policy` interpolated the validator's ENGLISH list into a
                    // French sentence ("Mot de passe : Password must be at least 12
                    // characters long"). Localize each rule instead.
                    req.flash('error', localizePasswordErrors(req, pw.errors));
                    return res.redirect('/change-password');
                }
                result = await EmployeeAuthService.changePassword(
                    req.user.id,
                    currentPassword,
                    newPassword
                );
            } else {
                // Admin path (AuthService applies its own complexity + history rules).
                result = await AuthService.changePassword(
                    req.user.id,
                    currentPassword,
                    newPassword
                );
            }

            if (result.success) {
                // Security: a password change invalidates every OTHER session for
                // this user (a stolen/old session on another device is now dead).
                try {
                    const SessionService = require('../services/SessionService');
                    // Both buckets: the message below promises this unconditionally.
                    const counts = await Promise.all(
                        sessionBuckets(req.user.userType).map((t) =>
                            SessionService.revokeOthers(req.user.id, t, req.sessionID)
                        )
                    );
                    const n = counts.reduce((a, b) => a + (Number(b) || 0), 0);
                    authAudit(
                        req,
                        'PASSWORD_CHANGED',
                        `Password changed; ${n} other session(s) signed out`,
                        req.user.userType === 'admin' ? req.user.id : null
                    );
                } catch (e) {
                    console.error('Session revoke on password change failed:', e.message);
                }
                req.flash(
                    'success',
                    req.t
                        ? req.t('flash:pw_changed')
                        : 'Password changed. You have been signed out of all other sessions.'
                );
                const home =
                    req.user.userType === 'employee'
                        ? '/employee/dashboard'
                        : req.user.userType === 'manager'
                          ? '/supervisor/dashboard'
                          : '/dashboard';
                res.redirect(home);
            } else {
                // A wrong CURRENT password is a failed authentication of this
                // account: it counts toward its lockout (the route's
                // passwordReauthLimiter caps the rate per user). A new-password
                // rule refusal is not a guess and must not burn the re-auth budget.
                const wrongCurrent = /current password is incorrect/i.test(
                    String(result.message || '')
                );
                if (!wrongCurrent) req._reauthNotAGuess = true;
                if (wrongCurrent)
                    await require('../middleware/rateLimiter').noteAuthenticatedFailure(
                        req.user,
                        req.ip
                    );
                // `result.message` is English service prose ("Current password is
                // incorrect"). It never reaches the page verbatim.
                req.flash('error', localizeAuthMessage(req, result.message));
                res.redirect('/change-password');
            }
        } catch (error) {
            console.error('Change password error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:pw_change_error') : 'An error occurred while changing password'
            );
            res.redirect('/change-password');
        }
    }
}

module.exports = new AuthController();
