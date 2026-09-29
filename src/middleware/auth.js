const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const AdminModel = require('../models/AdminModel');
const EmployeeModel = require('../models/EmployeeModel');
const AuthService = require('../services/AuthService');
const EmployeeAuthService = require('../services/EmployeeAuthService');
const { recordLoginAttempt, noteEnforcedFailure, clearEnforcedFailures } = require('./rateLimiter');
const { safeBackUrl } = require('../utils/safeRedirect');
const bcrypt = require('bcrypt');

// A bcrypt hash of a random secret per cost, so a refused identifier costs the
// same comparison as a real one (A1 / S8 anti-enumeration). Built on first use.
const _dummyHashes = new Map();
const APP_BCRYPT_COST = 10; // the cost every password is hashed with (AuthService, resets)
function bcryptCost(hash) {
    const m = /^\$2[aby]?\$(\d{2})\$/.exec(String(hash || ''));
    const n = m ? Number(m[1]) : APP_BCRYPT_COST;
    return n >= 4 && n <= 15 ? n : APP_BCRYPT_COST;
}
// The highest bcrypt cost among the ACTIVE SuperAdmins' hashes: a refused name
// must cost what the SuperAdmin's check costs. Refreshed in the background every
// minute (never awaited on a sign-in, so no request pays a different price).
let _superCost = null;
let _superCostAt = 0;
function superadminCost() {
    if (Date.now() - _superCostAt > 60000) {
        _superCostAt = Date.now();
        Promise.resolve()
            .then(() =>
                require('../config/database').all(
                    "SELECT password_hash FROM admins WHERE role = 'superadmin' AND is_active = true"
                )
            )
            .then((rows) => {
                const costs = (rows || [])
                    .map((r) => r.passwordHash ?? r.password_hash)
                    .filter(Boolean)
                    .map(bcryptCost);
                _superCost = costs.length ? Math.max(...costs) : null;
            })
            .catch(() => {});
    }
    return _superCost;
}
function dummyHash(cost = APP_BCRYPT_COST) {
    if (!_dummyHashes.has(cost))
        _dummyHashes.set(
            cost,
            bcrypt.hash(require('crypto').randomBytes(18).toString('base64'), cost)
        );
    return _dummyHashes.get(cost);
}

// Audit a refused/accepted break-glass attempt WITHOUT awaiting it: the time the
// caller waits must not depend on which branch was taken.
function authLog(ctx, action, details, adminId = null) {
    try {
        Promise.resolve(
            require('../services/LogService').log({
                adminId,
                action,
                entityType: 'auth',
                details,
                ipAddress: ctx.ip,
                userAgent: ctx.get('user-agent'),
            })
        ).catch(() => {});
    } catch (_) {
        /* audit best-effort */
    }
}

/**
 * The employee returned by a successful password check, typed the way every
 * sign-in types it: a "manager" governs ≥1 person as a supervisor OR as an
 * employee-typed manager.
 */
async function asPersonPrincipal(employee) {
    const gov = await EmployeeModel.governanceOf(employee.id);
    employee.userType = gov.governs ? 'manager' : 'employee';
    employee.isManager = gov.governs;
    employee.isSupervisorOf = gov.supervises;
    employee.isPeopleManager = gov.manages;
    return employee;
}

/**
 * The password sign-in while SSO is enforced.
 * Returns the `[user|false, info]` pair for passport's done(null, …).
 *
 * EVERY request does the same awaited work, whoever it names: the admin lookup
 * (+ the e-mail lookup for an e-mail identifier), the employee lookup, and ONE
 * bcrypt comparison at the cost of the stored hash it would be checked against
 * (the SuperAdmin's hash, else a dummy at the stored account's cost, else the
 * app's). Audit rows and attempt records are written without being awaited.
 * The refusal `info` is identical in every case; only the audit carries why:
 *   password_login_blocked_sso_enforced  a real account that is not an active SuperAdmin
 *   password_login_unknown_sso_enforced  no such identifier
 *   password_login_bad_password          the SuperAdmin, wrong password
 *   password_login_locked                the SuperAdmin, explicitly locked
 *   password_login_disabled              the SuperAdmin, local password disabled
 * only a SuperAdmin's failure is recorded (for its (username, IP) delay); a
 * non-SuperAdmin identifier can never succeed, so it is not counted.
 */
async function enforcedPasswordLogin(req, username, password, ctx) {
    const REFUSED = { message: 'Invalid credentials', code: 'SSO_ENFORCED' };
    let admin = await AdminModel.findByUsername(username);
    if (!admin && username && String(username).includes('@')) {
        try {
            const u = await require('../services/EmailAccountsService').uniqueAdminByEmail(
                username
            );
            admin = u && u.row && !u.ambiguous ? await AdminModel.findById(u.row.id) : null;
        } catch (_) {
            admin = null;
        }
    }
    let emp = null;
    try {
        emp = await EmployeeModel.findByUsername(username);
    } catch (_) {
        emp = null;
    }
    const isSuper = !!admin && admin.role === 'superadmin' && admin.isActive !== false;
    // EXC (3.23.21): an EMPLOYEE a SuperAdmin listed as an SSO exception keeps
    // the ordinary employee password sign-in (lockout, invitation expiry and
    // policy checks included). Same single bcrypt as every other identifier;
    // a refusal reads exactly like any other.
    const AdminSsoX = require('../services/AdminSsoService');
    if (!isSuper && emp && AdminSsoX.isSsoExcepted(emp)) {
        const r = await EmployeeAuthService.login(username, password, ctx);
        if (r && r.success) {
            await recordLoginAttempt(username, ctx.ip, true);
            authLog(
                ctx,
                'LOGIN_SSO_EXCEPTION',
                `password sign-in for "${String(username || '').slice(0, 64)}" accepted while SSO is enforced — SSO exception set by a SuperAdmin`,
                null
            );
            return [await asPersonPrincipal(r.employee)];
        }
        if (!(r && r.policyRefusal)) await recordLoginAttempt(username, ctx.ip, false);
        return [false, REFUSED];
    }
    const stored = (admin && admin.passwordHash) || (emp && emp.passwordHash) || null;
    // A refused name costs what the SuperAdmin's check costs: the highest cost
    // among the SuperAdmins' hashes (else the stored hash's, else the app's).
    const dummyCost = superadminCost() || bcryptCost(stored);
    const hash = isSuper && admin.passwordHash ? admin.passwordHash : await dummyHash(dummyCost);
    const match = await bcrypt.compare(String(password || ''), hash).catch(() => false);
    const name = String(username || '').slice(0, 64);

    if (!isSuper) {
        authLog(
            ctx,
            'LOGIN_BLOCKED',
            `${admin || emp ? 'password_login_blocked_sso_enforced' : 'password_login_unknown_sso_enforced'}: password sign-in for "${name}" refused — SSO is enforced`,
            admin ? admin.id : null
        );
        await noteEnforcedFailure(username, ctx.ip); // the SAME throttle for every identifier
        return [false, REFUSED];
    }
    const lockedUntil = admin.lockedUntil ?? admin.locked_until;
    const locked = !!lockedUntil && new Date(lockedUntil) > new Date();
    const disabled = admin.passwordDisabled === true || admin.password_disabled === true;
    if (!match || locked || disabled) {
        const why = !match
            ? 'password_login_bad_password'
            : locked
              ? 'password_login_locked'
              : 'password_login_disabled';
        authLog(
            ctx,
            'LOGIN_FAILED',
            `${why}: SuperAdmin break-glass sign-in for "${name}" refused`,
            admin.id
        );
        if (!match) Promise.resolve(recordLoginAttempt(username, ctx.ip, false)).catch(() => {});
        await noteEnforcedFailure(username, ctx.ip);
        return [false, REFUSED];
    }
    authLog(
        ctx,
        'LOGIN_SUCCESS',
        `User logged in (SuperAdmin break-glass, SSO enforced): ${name}`,
        admin.id
    );
    await recordLoginAttempt(username, ctx.ip, true);
    clearEnforcedFailures(username, ctx.ip);
    admin.userType = 'admin';
    // the session remembers it was opened by the break-glass (serializeUser).
    Object.defineProperty(admin, '_sessionVia', {
        value: { via: 'breakglass' },
        enumerable: false,
        configurable: true,
    });
    return [admin];
}

// Configure Passport Local Strategy - Auto-detect user type
passport.use(
    new LocalStrategy({ passReqToCallback: true }, async (req, username, password, done) => {
        try {
            // Use the REAL request so the audit log and the IP-based lockout record
            // the actual client IP / user-agent (a fixed mock collapsed every
            // attempt onto 127.0.0.1, breaking per-IP lockout + forensics).
            const ctx = {
                ip: (req && req.ip) || '0.0.0.0',
                get: (h) => (req && req.get ? req.get(h) : ''),
            };

            // 3.23.19 (amendment A1): while SSO is ENFORCED (an interactive provider
            // is enabled) a password opens ONLY an active SuperAdmin account — the
            // break-glass. Everyone else is refused with the SAME answer as a wrong
            // password (anti-enumeration), after the SAME work (one bcrypt), and the
            // failed attempt is counted as before.
            const AdminSso = require('../services/AdminSsoService');
            if (AdminSso.isEnforced()) {
                return done(null, ...(await enforcedPasswordLogin(req, username, password, ctx)));
            }

            // Try admin login first
            const adminResult = await AuthService.login(username, password, ctx);

            // COLLISION D'IDENTIFIANT — deux comptes, un seul humain qui tape.
            //
            // `admins.username` et `employees.username` vivent dans deux tables
            // qu'aucune contrainte ne relie. Le cote employe refuse deja un
            // identifiant deja pris cote administration (EmployeeController) ;
            // la reciproque manquait. Quand un compte d'administration porte le
            // MEME identifiant qu'une personne ET que le mot de passe tape ouvre
            // LES DEUX, cette strategie rendait le compte d'administration parce
            // qu'elle l'essaie en premier.
            //
            // Mesure sur une base de developpement, identifiants INCHANGES du
            // debut a la fin : avant la creation du compte homonyme, POST /login
            // -> 302 /supervisor/dashboard, file [139,138], detail 200 ; apres,
            // -> 302 /dashboard, file [89,88] (aucun de ses 15 rattaches) et 403
            // sur le detail de ses propres rattaches. La personne changeait
            // d'identite sans rien changer, et rien ne le disait.
            //
            // On tranche vers la MOINDRE autorite — la personne, jamais
            // l'habilitation d'un compte homonyme : la ligne hierarchique n'est
            // pas une propriete du mot de passe qui a ete tape, et un compte
            // d'administration cree au nom de quelqu'un ne doit pas devenir un
            // chemin d'elevation. Le cas est journalise pour que l'anomalie soit
            // VUE et corrigee (renommer l'un des deux comptes).
            //
            // EXCEPTION, deliberee : un compte qui NOMME la personne
            // (`linked_employee_id`, pose par « accorder l'acces administrateur »
            // et par la liaison de comptes) n'est pas homonyme par accident — il
            // n'y a la aucune ambiguite d'identite et GovernanceService.actingPersonId
            // rend deja sa ligne hierarchique a ce compte. Il passe inchange.
            let employeeResult = null;
            if (adminResult.success) {
                const namesNobody = !(
                    adminResult.admin &&
                    (adminResult.admin.linkedEmployeeId || adminResult.admin.linked_employee_id)
                );
                const twin = namesNobody ? await EmployeeModel.findByUsername(username) : null;
                if (
                    twin &&
                    twin.passwordHash &&
                    (await bcrypt.compare(password, twin.passwordHash))
                ) {
                    const asPerson = await EmployeeAuthService.login(username, password, ctx);
                    if (asPerson.success) {
                        employeeResult = asPerson;
                        try {
                            await require('../services/LogService').log({
                                action: 'LOGIN_IDENTIFIER_COLLISION',
                                entityType: 'employee',
                                entityId: Number(asPerson.employee.id),
                                actorRef: `employee:${asPerson.employee.id}`,
                                details: `Identifier "${username}" names BOTH an administration account (#${adminResult.admin.id}, ${adminResult.admin.role}, linked to no employee) and employee #${asPerson.employee.id}, and the password opens both. Signed in as the PERSON; the administration account is unreachable by password until one of the two logins is renamed.`,
                                ipAddress: ctx.ip,
                                userAgent: ctx.get('user-agent'),
                            });
                        } catch (_) {
                            /* the trail must never block the sign-in */
                        }
                    }
                }
            }

            if (adminResult.success && !employeeResult) {
                // Record login attempt
                await recordLoginAttempt(username, ctx.ip, true);
                adminResult.admin.userType = 'admin';
                return done(null, adminResult.admin);
            }

            // If admin login failed, try employee login
            if (!employeeResult)
                employeeResult = await EmployeeAuthService.login(username, password, ctx);

            if (employeeResult.success) {
                // A "manager" is anyone who governs ≥1 person — as a supervisor
                // OR as an employee-typed manager (not only supervisor_id, so a
                // pure manager can reach the review console). Supervisor and
                // manager stay apart on the session (asPersonPrincipal).
                await asPersonPrincipal(employeeResult.employee);

                // Clear the failed-attempt tally on success — mirrors the admin
                // branch (line ~26). Without this, an employee/manager (the bulk of
                // users) who mistyped a few times then logged in still carries those
                // failed rows, and one more slip re-locks a valid account.
                await recordLoginAttempt(username, ctx.ip, true);

                return done(null, employeeResult.employee);
            }

            // Both failed. A POLICY refusal is not an authentication failure: the
            // account is SSO-only, or its invitation has expired, so the password
            // path is closed and counting attempts protects nothing. Recording them
            // meant an SSO-only user who typed their password out of habit five
            // times LOCKED THEIR OWN ACCOUNT for 30 minutes, and the log blamed a
            // "failed login" while the real reason was policy — misleading whoever
            // came to help them.
            //
            // The message stays generic on purpose: showing the specific reason
            // would tell an anonymous caller which accounts exist.
            const policyRefusal = Boolean(
                (adminResult && adminResult.policyRefusal) ||
                (employeeResult && employeeResult.policyRefusal)
            );
            // (A shared-address refusal — EMAIL_AMBIGUOUS — is a policy refusal
            // too; the auth services already wrote the explicit audit line.)
            if (!policyRefusal) await recordLoginAttempt(username, ctx.ip, false);
            return done(null, false, { message: 'Invalid credentials' });
        } catch (error) {
            return done(error);
        }
    })
);

passport.serializeUser((user, done) => {
    // 3.23.19: a session opened through SSO carries `via: 'sso'` (and,
    // for an admin reached through its linked person, that person's id) so the
    // request pipeline can tell it apart. Set by SsoController as `_sessionVia`.
    const v = user && user._sessionVia;
    done(null, {
        id: user.id,
        userType: user.userType || 'admin',
        ...(v && (v.via === 'sso' || v.via === 'breakglass') ? { via: v.via } : {}),
        ...(v && v.viaEmployeeId ? { viaEmp: Number(v.viaEmployeeId) } : {}),
    });
});

passport.deserializeUser(async (serialized, done) => {
    try {
        if (serialized.userType === 'employee' || serialized.userType === 'manager') {
            const employee = await EmployeeModel.findByIdWithOrganization(serialized.id);
            if (!employee) {
                return done(null, false);
            }
            // De-authorize a still-live session the instant the account is
            // deactivated: a leaver processed via JML, a GDPR-erased subject, or
            // an admin-disabled account flips is_active/is_account_active=false but
            // its open browser would otherwise keep passing req.isAuthenticated
            // (rolling maxAge never lets it expire while in use). Treat either flag
            // being explicitly false as a dead session. `=== false` only — a missing
            // field must never lock everyone out.
            if (employee.isActive === false || employee.isAccountActive === false) {
                return done(null, false);
            }

            // Manager = governs ≥1 person as supervisor OR employee-manager
            // (matches the login-strategy classification above).
            const gov = await EmployeeModel.governanceOf(serialized.id);
            const isManager = gov.governs;
            employee.userType = isManager ? 'manager' : 'employee';
            employee.isManager = isManager;
            employee.isSupervisorOf = gov.supervises;
            employee.isPeopleManager = gov.manages;

            done(null, employee);
        } else {
            const admin = await AdminModel.findWithScopes(serialized.id);
            if (!admin) {
                return done(null, false);
            }
            // Same de-authorization gate as the employee branch: a disabled admin
            // (is_active=false) must lose its live session on the very next request,
            // not linger until idle timeout. `=== false` only (defensive).
            if (admin.isActive === false) {
                return done(null, false);
            }
            // 3.23.19: an explicit lock ends the live session too (the
            // password login and the SSO checks both refuse a locked admin).
            const lockedUntil = admin.lockedUntil ?? admin.locked_until;
            if (lockedUntil && new Date(lockedUntil) > new Date()) {
                return done(null, false);
            }
            // a session opened through SSO keeps the conditions it was opened
            // under — the linked person still active (D3b) and access not expired.
            if (serialized.via === 'sso') {
                // C1d (3.23.20): a SuperAdmin never holds an SSO-opened session —
                // an admin promoted while signed in by SSO loses it at the very
                // next request (role read from the database, fail closed).
                if (admin.role === 'superadmin') return done(null, false);
                if (serialized.viaEmp) {
                    const p = await EmployeeModel.findById(serialized.viaEmp);
                    const linked = Number(admin.linkedEmployeeId ?? admin.linked_employee_id);
                    if (
                        !p ||
                        p.isActive === false ||
                        p.isAccountActive === false ||
                        linked !== Number(serialized.viaEmp)
                    )
                        return done(null, false);
                }
                const AdminPermissionModel = require('../models/AdminPermissionModel');
                const exp = await AdminPermissionModel.getExpiryStateForAdmin(admin.id);
                if (exp && exp.expired) return done(null, false);
            }
            admin.userType = 'admin';
            // Attach granted permission slugs so route guards/views can do a
            // synchronous check. SuperAdmins hold everything implicitly, so we
            // only query the grant table for non-superadmins.
            try {
                if (admin.role === 'superadmin') {
                    admin.permissions = [...require('../config/permissions').ALL_SLUGS];
                } else {
                    const AdminPermissionModel = require('../models/AdminPermissionModel');
                    const { expandSlugs } = require('../config/permissions');
                    const granted = await AdminPermissionModel.findSlugsByAdminId(admin.id);
                    // Expand coarse grants (e.g. manage_employees) to the finer slugs
                    // they imply, so a route guarding view_employees is satisfied.
                    admin.grantedPermissions = granted; // what was actually stored (for the edit form)
                    admin.permissions = expandSlugs(granted);
                }
            } catch (e) {
                admin.permissions = [];
            }
            // Attach scopes to user object for easier access
            done(null, admin);
        }
    } catch (error) {
        done(error);
    }
});

/**
 * UN APPEL JSON NE REÇOIT JAMAIS DE 3xx.
 *
 * Mesuré le 16/09/2026 sur une base de développement, 7 routes, visiteur non
 * connecté portant les en-têtes JSON les plus explicites qu'une page puisse
 * envoyer (Content-Type + Accept + X-Requested-With + Origin) : LES 7
 * répondaient `302 → /login`, sans content-type. Un `fetch` de navigateur suit
 * la redirection, reçoit la page de connexion en `200 text/html`, et `r.ok` vaut
 * alors `true` : l'appelant croit avoir réussi. C'est la cause racine commune des
 * 44 écrans qui appellent fetch — la refermer ici les ferme tous, y compris
 * ceux que personne n'a encore ouverts.
 *
 * Statut honnête, pas une redirection :
 *  - pas de session   → 401 (l'écran dit « reconnectez-vous »)
 *  - session vivante, mauvais profil → 403 (l'écran dit « hors de votre périmètre »)
 * La navigation de PAGE, elle, ne change pas d'un octet : même flash, même 302.
 */
function denyJson(req, res, key, fallback) {
    const msg = req.t ? req.t(`flash:${key}`, { defaultValue: fallback }) : fallback;
    const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
    return res
        .status(authed ? 403 : 401)
        .json({ ok: false, error: msg, code: authed ? key : 'session_expired' });
}

// Middleware to check if user is authenticated
const requireAuth = (req, res, next) => {
    if (req.isAuthenticated()) {
        return next();
    }
    if (wantsJson(req))
        return denyJson(req, res, 'login_required', 'Please log in to access this page');
    req.flash('error', req.t ? req.t('flash:login_required') : 'Please log in to access this page');
    res.redirect('/login');
};

/**
 * UN REFUS DE TYPE DE COMPTE, DIT AU BON FORMAT.
 *
 * `requireEmployee` et `requireManager` répondaient par `302 → /login` À TOUT LE
 * MONDE, y compris à un appel JSON d'une session bien vivante. Mesuré : session
 * `uat.manager` (→ 200 sur /api/notifications) puis `POST /v2/slf/disputes` avec
 * `Accept: application/json` ET `X-Requested-With: XMLHttpRequest` → 302 vers
 * /login, corps vide, sans content-type. Côté navigateur c'est le pire des cas :
 * la page HTML de connexion arrive dans un `fetch`, rien ne se remplit, et
 * AUCUNE erreur ne s'affiche. Leur sœur `requireManagerOrAdmin` (juste dessous)
 * porte depuis longtemps la bonne branche — ces deux-là ne l'avaient jamais eue.
 *
 * Deuxième moitié du même défaut : renvoyer un utilisateur CONNECTÉ vers /login
 * perd le motif. `uat.admin` sur `GET /supervisor/dashboard` parcourait
 * /login → /dashboard → et arrivait sans aucune alerte, le message avalé par la
 * redirection de /login. On le renvoie donc vers SON tableau de bord, où le
 * message survit.
 *
 * Ce qui ne change pas, et qui est vérifié : un visiteur NON CONNECTÉ garde
 * exactement l'ancien comportement — flash + `302 → /login`.
 */
function homeFor(req) {
    if (!(typeof req.isAuthenticated === 'function' && req.isAuthenticated())) return '/login';
    return req.user && req.user.userType === 'admin' ? '/dashboard' : '/employee/dashboard';
}

function denyUserType(req, res, key, fallback) {
    const msg = req.t ? req.t(`flash:${key}`, { defaultValue: fallback }) : fallback;
    // Même forme que `denyPermission` : statut honnête, phrase lisible, code stable.
    // 403 quand la session VIT et que le profil ne convient pas ; 401 quand il n'y
    // a plus de session du tout — sinon l'écran dit « hors de votre périmètre » à
    // quelqu'un dont le vrai problème est qu'il doit se reconnecter.
    if (wantsJson(req)) return denyJson(req, res, key, fallback);
    if (typeof req.flash === 'function') req.flash('error', msg);
    return res.redirect(homeFor(req));
}

// Middleware to check if user is an employee (not manager)
const requireEmployee = (req, res, next) => {
    if (req.isAuthenticated() && req.user.userType === 'employee') {
        return next();
    }
    return denyUserType(req, res, 'employee_access_required', 'Employee access required');
};

// Middleware to check if user is a manager or employee
const requireEmployeeOrManager = (req, res, next) => {
    if (
        req.isAuthenticated() &&
        (req.user.userType === 'employee' || req.user.userType === 'manager')
    ) {
        return next();
    }
    // GET /api/coaching/mine répondait 302 à un appel JSON : « Mon accompagnement »
    // affichait alors une page vide comme si la personne n'avait aucun suivi.
    if (wantsJson(req))
        return denyJson(
            req,
            res,
            'employee_or_manager_required',
            'Employee or Manager access required'
        );
    req.flash(
        'error',
        req.t ? req.t('flash:employee_or_manager_required') : 'Employee or Manager access required'
    );
    res.redirect('/login');
};

// Middleware to check if user is a manager
const requireManager = (req, res, next) => {
    if (req.isAuthenticated() && req.user.userType === 'manager') {
        return next();
    }
    // voir `denyUserType` ci-dessus : 403 JSON pour un appel JSON,
    // redirection inchangée vers /login pour un visiteur non connecté.
    return denyUserType(req, res, 'manager_access_required', 'Manager access required');
};

// Middleware to check if user is an admin
const requireAdmin = (req, res, next) => {
    if (req.isAuthenticated() && req.user.userType === 'admin') {
        return next();
    }
    if (wantsJson(req)) return denyJson(req, res, 'admin_access_required', 'Admin access required');
    req.flash('error', req.t ? req.t('flash:admin_access_required') : 'Admin access required');
    res.redirect('/login');
};

// Middleware for manager/admin-only screens (excludes regular employees).
// Used for the dashboard, skill matrix, 9-box, reports, and the review/
// coaching consoles — screens a self-service employee must not reach.
const requireManagerOrAdmin = (req, res, next) => {
    if (
        req.isAuthenticated() &&
        (req.user.userType === 'manager' || req.user.userType === 'admin')
    ) {
        return next();
    }
    // Reniflage COMPLET (le `req.xhr || Accept` d'avant laissait passer en 302
    // l'appel qui n'a que `Content-Type: application/json` — c'est-à-dire tous
    // ceux des pages). Corps JSON inchangé pour un appelant connecté : la surface
    // d'API ne bouge pas ; seul l'anonyme passe de 302 à 401.
    if (wantsJson(req)) {
        const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
        if (!authed)
            return denyJson(
                req,
                res,
                'manager_or_admin_required',
                'Access denied. Manager or admin privileges required.'
            );
        return res
            .status(403)
            .json({ error: 'Access denied. Manager or admin privileges required.' });
    }
    req.flash(
        'error',
        req.t
            ? req.t('flash:manager_or_admin_required')
            : 'Access denied. Manager or admin privileges required.'
    );
    res.redirect(req.isAuthenticated() ? '/employee/dashboard' : '/login');
};

// Middleware to check if user is SuperAdmin
const requireSuperAdmin = (req, res, next) => {
    // userType AND role — admin and employee id spaces overlap, and an employee
    // row must never pass a superadmin gate on a `role` field alone.
    if (req.isAuthenticated() && require('../services/RBACService').isSuperAdmin(req.user)) {
        return next();
    }
    // C'est CETTE garde que portait /admin/api-keys : elle renvoyait `302 → /dashboard`
    // à un appel JSON, y compris à une session vivante du mauvais profil.
    if (wantsJson(req))
        return denyJson(
            req,
            res,
            'superadmin_required',
            'Access denied. SuperAdmin privileges required.'
        );
    req.flash(
        'error',
        req.t
            ? req.t('flash:superadmin_required')
            : 'Access denied. SuperAdmin privileges required.'
    );
    res.redirect('/dashboard');
};

/**
 * SINGLE denial path shared by the three permission guards below.
 *
 * The old code ended each guard with a flash + redirect to /dashboard, which
 * loses WHY: the admin lands back on the dashboard with a generic "you do not
 * have permission" toast and no idea which capability is missing or who could
 * grant it. That is a dead end — the top adoption complaint on an install where
 * 25 local admins hold scope but zero capability.
 *
 * Behaviour contract:
 *  - API / XHR callers keep the EXACT previous JSON 403 (byte-identical body).
 *    Nothing about the API surface changes.
 *  - An unauthenticated caller keeps the previous login redirect.
 *  - A signed-in caller gets a real 403 HTML page naming the action attempted,
 *    the missing capability (localized label + description from the catalogue)
 *    and who can grant it.
 *
 * `slugs` is the list the guard was checking (one for requirePermission, any-of
 * for the two "any" variants).
 *
 * Never leaks more than a username + role about the granters.
 */
/** A JSON caller: XHR, an Accept naming json, or a JSON body (the app's own
 *  fetch sends only `Content-Type: application/json` — no Accept, no
 *  X-Requested-With — and used to receive the HTML 403 page).
 *
 *  The definition moved to utils/wantsJson so the ERROR HANDLER can apply the
 *  same rule without importing this module (passport, every model) — it had a
 *  narrower test of its own and answered a 302 to a fetch on a 500. Re-exported
 *  here unchanged; this is still the name the rest of the middleware uses. */
const { wantsJson } = require('../utils/wantsJson');

async function denyPermission(req, res, slugs) {
    // 1) API/XHR — FROZEN. Same status, same message, same shape as before.
    if (wantsJson(req)) {
        return res
            .status(403)
            .json({ error: 'Access denied. You do not have permission for this action.' });
    }

    const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();

    // 2) Not signed in — unchanged: flash + bounce to the login screen.
    if (!authed) {
        req.flash(
            'error',
            req.t
                ? req.t('flash:no_permission')
                : 'Access denied. You do not have permission for this action.'
        );
        return res.redirect('/login');
    }

    // 3) Signed in — render the explanatory 403. Any failure here degrades to the
    //    old flash+redirect so a denial can never turn into a 500.
    try {
        const { BY_SLUG } = require('../config/permissions');
        const t = (key, fallback, opts) =>
            req.t ? req.t(key, Object.assign({ defaultValue: fallback }, opts || {})) : fallback;

        const wanted = (Array.isArray(slugs) ? slugs : [slugs])
            .filter((s) => typeof s === 'string' && BY_SLUG[s])
            .map((s) => {
                const def = BY_SLUG[s];
                // The catalogue itself is English-only; the FR/EN wording lives in
                // the existing `admin:perm.<slug>.{label,desc}` dictionary, with the
                // catalogue string as the defaultValue so a slug added later still
                // renders (in English) instead of printing a raw key.
                return {
                    slug: s,
                    label: t(`admin:perm.${s}.label`, def.label),
                    description: t(`admin:perm.${s}.desc`, def.description),
                    write: Boolean(def.write),
                };
            });

        // Who can grant it: active holders of manage_admins, by
        // DISPLAY NAME (from the linked employee where there is one), never a
        // test/demo/QA fixture login, never an e-mail address. One helper so the
        // scope refusal below shows exactly the same list.
        const granters = await require('../utils/contactableAdmins').contactableGranters();

        const isAdmin = req.user && req.user.userType === 'admin';
        return res.status(403).render('pages/errors/403-permission', {
            title: t('admin:acc_403_title', 'Accès refusé'),
            // Query string is deliberately dropped (never reflect caller-supplied text).
            attemptedPath: String(req.originalUrl || req.path || '/').split('?')[0],
            attemptedMethod: String(req.method || 'GET').toUpperCase(),
            missing: wanted,
            scopeDenied: null,
            // everybody who is refused gets a real, contactable name —
            // an employee who lands on an admin URL needs to know who to ask
            // just as much as a delegate does.
            granters,
            isAdmin,
            backUrl: isAdmin ? '/dashboard' : '/employee/dashboard',
        });
    } catch (e) {
        req.flash(
            'error',
            req.t
                ? req.t('flash:no_permission')
                : 'Access denied. You do not have permission for this action.'
        );
        return res.redirect(
            req.user && req.user.userType === 'admin' ? '/dashboard' : '/employee/dashboard'
        );
    }
}

// Middleware factory: allow a SuperAdmin OR a local admin who holds the given
// granular permission slug. This is what lets routine governance be delegated
// to scoped local admins instead of requiring a SuperAdmin. Scope is still
// enforced separately (rbacMiddleware / checkXAccess) so a delegated admin only
// acts within their assigned site/department/service.
const requirePermission = (slug) => (req, res, next) => {
    if (req.isAuthenticated() && req.user.userType === 'admin') {
        if (req.user.role === 'superadmin') return next();
        const isViewer = req.user.role === 'viewer';
        const writeSlugs = require('../config/permissions').WRITE_SLUGS;
        const grants = Array.isArray(req.user.permissions) ? req.user.permissions : [];
        if (grants.includes(slug) && !(isViewer && writeSlugs.has(slug))) {
            return next();
        }
    }
    return denyPermission(req, res, [slug]);
};

// Like requirePermission but passes if the admin holds ANY of the given slugs
// (used for hub pages reachable via more than one capability, e.g. Data
// Management which serves both exporters and importers).
const requireAnyPermission =
    (...slugs) =>
    (req, res, next) => {
        if (req.isAuthenticated() && req.user.userType === 'admin') {
            if (req.user.role === 'superadmin') return next();
            const isViewer = req.user.role === 'viewer';
            const writeSlugs = require('../config/permissions').WRITE_SLUGS;
            const grants = Array.isArray(req.user.permissions) ? req.user.permissions : [];
            if (slugs.some((s) => grants.includes(s) && !(isViewer && writeSlugs.has(s)))) {
                return next();
            }
        }
        return denyPermission(req, res, slugs);
    };

// Manager OR (SuperAdmin / local admin holding ANY of the given slugs).
// Used for the talent-continuity & LMS modules: a manager always reaches them
// for their own reports; a scoped local admin needs an explicit grant. Scope is
// still enforced separately in the services.
const requireManagerOrAnyPermission =
    (...slugs) =>
    (req, res, next) => {
        if (req.isAuthenticated()) {
            if (req.user.userType === 'manager') return next();
            if (req.user.userType === 'admin') {
                if (req.user.role === 'superadmin') return next();
                const isViewer = req.user.role === 'viewer';
                const writeSlugs = require('../config/permissions').WRITE_SLUGS;
                const grants = Array.isArray(req.user.permissions) ? req.user.permissions : [];
                if (slugs.some((s) => grants.includes(s) && !(isViewer && writeSlugs.has(s)))) {
                    return next();
                }
            }
        }
        return denyPermission(req, res, slugs);
    };

// Middleware to check if user has write permissions (not a viewer)
const requireReadWrite = (req, res, next) => {
    if (req.isAuthenticated() && req.user.userType === 'admin' && req.user.role !== 'viewer') {
        return next();
    }

    // Même reniflage complet : sans lui, un appel JSON de viewer partait en 302
    // vers la page précédente et l'écran ne voyait aucun refus.
    if (wantsJson(req)) {
        const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
        if (!authed)
            return denyJson(
                req,
                res,
                'write_denied',
                'Write access denied. You have read-only permissions.'
            );
        return res.status(403).json({ error: 'Write access denied. Viewers are read-only.' });
    }
    req.flash(
        'error',
        req.t ? req.t('flash:write_denied') : 'Write access denied. You have read-only permissions.'
    );
    res.redirect(safeBackUrl(req)); // same-origin only (no open redirect)
};

/**
 * a SuperAdmin-only PAGE refuses with the explanatory 403 instead
 * of bouncing to /dashboard with a toast. `requireSuperAdmin` keeps its redirect
 * behaviour everywhere else (it guards ~40 POST endpoints whose callers expect it);
 * this variant is for the handful of pages where the person deserves to be told
 * what they hit and who can help. JSON/XHR callers keep the frozen JSON 403.
 */
const requireSuperAdminPage = async (req, res, next) => {
    if (
        req.isAuthenticated &&
        req.isAuthenticated() &&
        require('../services/RBACService').isSuperAdmin(req.user)
    ) {
        return next();
    }
    if (wantsJson(req)) {
        return res
            .status(403)
            .json({ error: 'Access denied. You do not have permission for this action.' });
    }
    if (!(req.isAuthenticated && req.isAuthenticated())) {
        req.flash('error', req.t ? req.t('flash:no_permission') : 'Access denied.');
        return res.redirect('/login');
    }
    try {
        const t = (key, fallback) => (req.t ? req.t(key, { defaultValue: fallback }) : fallback);
        const isAdmin = req.user && req.user.userType === 'admin';
        const granters = await require('../utils/contactableAdmins').contactableGranters();
        return res.status(403).render('pages/errors/403-permission', {
            title: t('admin:acc_403_title', 'Accès refusé'),
            attemptedPath: String(req.originalUrl || req.path || '/').split('?')[0],
            attemptedMethod: String(req.method || 'GET').toUpperCase(),
            missing: [],
            scopeDenied: null,
            superAdminOnly: true,
            granters,
            isAdmin,
            backUrl: isAdmin ? '/dashboard' : '/employee/dashboard',
        });
    } catch (_) {
        req.flash(
            'error',
            req.t
                ? req.t('flash:superadmin_required')
                : 'Access denied. SuperAdmin privileges required.'
        );
        return res.redirect(
            req.user && req.user.userType === 'admin' ? '/dashboard' : '/employee/dashboard'
        );
    }
};

module.exports = {
    passport,
    denyPermission,
    wantsJson,
    requireAuth,
    requireSuperAdmin,
    requireSuperAdminPage,
    requirePermission,
    requireAnyPermission,
    requireEmployee,
    requireEmployeeOrManager,
    requireManager,
    requireManagerOrAdmin,
    requireManagerOrAnyPermission,
    requireAdmin,
    requireReadWrite,
    // Amendment A1 (3.23.19) — exported for the behavioural tests.
    _enforcedPasswordLogin: enforcedPasswordLogin,
    _resetSuperadminCostCache: () => {
        _superCost = null;
        _superCostAt = 0;
    },
};
