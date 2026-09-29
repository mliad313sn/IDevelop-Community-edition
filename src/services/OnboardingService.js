'use strict';
/**
 * Self-service onboarding.
 *
 * Lets people register themselves — either via SSO (an unknown identity that
 * authenticates through a configured IdP) or via an open email/password signup
 * page. They are parked as a pending {@link OnboardingRequestModel} row (NOT an
 * employee) until an admin with `manage_onboarding` "places" them into a
 * site/department/service/role with a supervisor or manager — which creates the
 * real employee account. Everything is gated by the `onboarding.*` app settings
 * (with ONBOARDING_* env fallbacks); the whole feature is OFF by default.
 *
 * @module services/OnboardingService
 */
const bcrypt = require('bcrypt');
const db = require('../config/database');
const AppSettingsModel = require('../models/AppSettingsModel');
const OnboardingRequestModel = require('../models/OnboardingRequestModel');
const EmployeeModel = require('../models/EmployeeModel');
const passwordValidator = require('../utils/passwordValidator');
const { baseUsername, uniqueUsername } = require('../utils/credentialGenerator');
const LogService = require('./LogService');

function envOn(name) {
    const v = String(process.env[name] || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

async function settingBool(key, envName) {
    const v = await AppSettingsModel.getValue(key, null);
    if (v === null || v === undefined || String(v) === '') return envOn(envName);
    return v === true || String(v).toLowerCase() === 'true';
}

/** Master switch. */
async function isEnabled() {
    return settingBool('onboarding.enabled', 'ONBOARDING_ENABLED');
}
/** SSO JIT auto-onboarding allowed (and master on). */
async function allowSso() {
    return (await isEnabled()) && settingBool('onboarding.allowSso', 'ONBOARDING_ALLOW_SSO');
}
/** Open email/password signup allowed (and master on). Never while SSO is
 *  enforced (3.23.19, amendment A1): a local password account could not sign in
 *  anyway. One-click SSO onboarding (allowSso) is unaffected. */
async function allowSignup() {
    let enforced = false;
    try {
        enforced = require('./AdminSsoService').isEnforced();
    } catch (_) {
        enforced = false;
    }
    if (enforced) return false;
    return (await isEnabled()) && settingBool('onboarding.allowSignup', 'ONBOARDING_ALLOW_SIGNUP');
}
/**
 * F10 (3.23.21): is an SSO MIGRATION running? — SSO is switched on (enforced),
 * or accounts are mapped / invited and waiting for it. While it runs, the
 * onboarding queue defaults to « attach to the existing account » when a
 * candidate exists. False on any error (the queue then behaves as before).
 */
async function isSsoMigrationRunning() {
    try {
        if (require('./AdminSsoService').isEnforced()) return true;
        const r = await db.get(
            `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM sso_pending_links WHERE status = 'pending')
                          OR EXISTS (SELECT 1 FROM sso_migration_invites WHERE status IN ('waiting_sso', 'pending'))`
        );
        return !!(r && (r.x === 1 || r.x === '1'));
    } catch (_) {
        return false;
    }
}

/** Explicit opt-in to accept signups from ANY email domain (else, with an empty
 *  allowedDomains list, open signup is default-denied as a safer default). */
async function allowOpenSignup() {
    return settingBool('onboarding.allowOpenSignup', 'ONBOARDING_ALLOW_OPEN_SIGNUP');
}

async function allowedDomains() {
    const v = await AppSettingsModel.getValue('onboarding.allowedDomains', null);
    const raw = (v && String(v).trim()) || (process.env.ONBOARDING_ALLOWED_DOMAINS || '').trim();
    return raw
        ? raw
              .split(',')
              .map((d) => d.trim().toLowerCase())
              .filter(Boolean)
        : [];
}

async function emailAllowed(email) {
    const domains = await allowedDomains();
    if (!domains.length) return true;
    const at = String(email || '')
        .toLowerCase()
        .lastIndexOf('@');
    if (at < 0) return false;
    return domains.includes(
        String(email)
            .toLowerCase()
            .slice(at + 1)
    );
}

/** True if an active local account already exists for this email (so the
 *  person should sign in, not onboard). */
async function accountExists(email) {
    const e = String(email || '')
        .toLowerCase()
        .trim();
    if (!e) return false;
    const a = await db.get('SELECT id FROM admins WHERE lower(email) = ? AND is_active = true', [
        e,
    ]);
    if (a) return true;
    const emp = await db.get(
        'SELECT id FROM employees WHERE lower(email) = ? AND is_account_active = true',
        [e]
    );
    return !!emp;
}

async function pendingByEmail(email) {
    const e = String(email || '')
        .toLowerCase()
        .trim();
    if (!e) return null;
    return db.get(
        "SELECT * FROM onboarding_requests WHERE lower(email) = ? AND status = 'pending' LIMIT 1",
        [e]
    );
}

function splitName(full) {
    const parts = String(full || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return { firstName: null, lastName: null };
    if (parts.length === 1) return { firstName: parts[0], lastName: null };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Create a pending request from an open signup form.
 * @returns {Promise<{ok:boolean, reason?:string, message:string, alreadyPending?:boolean}>}
 */
// Notify the onboarding-review audience that a request is waiting (previously only
// a log line was written, so pending accounts could sit unseen). The audience =
// whoever holds `manage_onboarding` — a SuperAdmin OR a scoped local admin,
// depending on clearance. Best-effort, non-blocking.
async function notifyOnboardingAdmins(email) {
    try {
        const adminIds = await require('./RBACService').adminsWithPermission('manage_onboarding');
        const NotificationService = require('./NotificationService');
        for (const id of adminIds) {
            await NotificationService.notify({
                userType: 'admin',
                userId: Number(id),
                kind: 'onboarding.submitted',
                category: 'lifecycle',
                payload: { email: email || '', link: '/onboarding' },
            }).catch(() => {});
        }
    } catch (_) {
        /* never block onboarding on notification */
    }
}

/**
 * Classify a password rejection into ONE stable, translatable code.
 *
 * `passwordValidator` speaks English prose only, and its sentences were being
 * concatenated straight into the signup flash — the first thing a new user ever
 * sees on a French-first product. We never render that prose again: the errors
 * are read here purely to decide WHICH localized sentence to show. Composition
 * wins over predictability because it is the actionable minimum.
 */
function passwordCode(errors) {
    const joined = (errors || []).join(' | ').toLowerCase();
    // 'is required' counts as composition: an empty password is answered with the
    // rule, not with "that password is too predictable".
    const composition =
        /(is required|characters long|lowercase|uppercase|one number|special character|exceed)/.test(
            joined
        );
    return composition ? 'onbx_su_password_policy' : 'onbx_su_password_weak';
}

async function createFromSignup({ email, firstName, lastName, password }) {
    // Every outcome carries a STABLE `code` (+ interpolation `params`); the
    // controller renders it through req.t so the applicant reads their own
    // language. `message` is kept as the English last-resort fallback for
    // callers with no translator (and it is what the audit trail quotes).
    if (!(await allowSignup()))
        return {
            ok: false,
            reason: 'disabled',
            code: 'onbx_su_disabled',
            message: 'Self-registration is not available.',
        };
    email = String(email || '')
        .toLowerCase()
        .trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return {
            ok: false,
            reason: 'email',
            code: 'onbx_su_bad_email',
            message: 'Enter a valid email address.',
        };
    // Default-deny truly-open signup: if no domain allowlist is configured, require
    // an explicit allowOpenSignup opt-in, so a fresh install can't accidentally
    // accept registrations from any address on the internet.
    const domains = await allowedDomains();
    if (!domains.length && !(await allowOpenSignup())) {
        return {
            ok: false,
            reason: 'restricted',
            code: 'onbx_su_restricted',
            message:
                'Self-registration is restricted to approved email domains. Please contact your administrator.',
        };
    }
    if (!(await emailAllowed(email)))
        return {
            ok: false,
            reason: 'domain',
            code: 'onbx_su_domain_denied',
            message: 'That email domain is not permitted to register.',
        };

    const pw = passwordValidator.validate(password || '');
    if (!pw.valid)
        return {
            ok: false,
            reason: 'password',
            code: passwordCode(pw.errors),
            message: 'Password: ' + pw.errors.join('; '),
        };

    if (await accountExists(email))
        return {
            ok: false,
            reason: 'exists',
            code: 'onbx_su_exists',
            message: 'An account with that email already exists — please sign in instead.',
        };
    if (await pendingByEmail(email))
        return {
            ok: true,
            alreadyPending: true,
            code: 'onbx_su_pending_already',
            message: "Your request is already pending an administrator's review.",
        };

    const passwordHash = await bcrypt.hash(password, 10);
    await OnboardingRequestModel.create({
        email,
        firstName: firstName || null,
        lastName: lastName || null,
        source: 'signup',
        authProvider: 'local',
        passwordHash,
        status: 'pending',
    });
    await LogService.log({
        action: 'ONBOARDING_REQUEST',
        entityType: 'onboarding',
        details: `Signup onboarding request: ${email}`,
    });
    notifyOnboardingAdmins(email);
    return {
        ok: true,
        code: 'onbx_su_received',
        message: 'Thanks! Your request was received and is awaiting administrator approval.',
    };
}

/**
 * Create a pending request from an SSO sign-in whose identity isn't provisioned.
 * Best-effort and quiet: returns a small status object the SSO layer turns into
 * the holding page (or a denial when onboarding is off).
 * @returns {Promise<{created?:boolean, alreadyPending?:boolean, blocked?:boolean}>}
 */
async function createFromSso({ provider, email, externalId, name, firstName, lastName }) {
    if (!(await allowSso())) return { blocked: true };
    email = String(email || '')
        .toLowerCase()
        .trim();
    if (!email || !(await emailAllowed(email))) return { blocked: true };
    if (await accountExists(email)) return { blocked: true }; // resolveIdentity should have matched; be safe.
    if (await pendingByEmail(email)) return { alreadyPending: true };

    if (!firstName && !lastName && name) {
        const s = splitName(name);
        firstName = s.firstName;
        lastName = s.lastName;
    }
    await OnboardingRequestModel.create({
        email,
        firstName: firstName || null,
        lastName: lastName || null,
        source: 'sso',
        authProvider: provider || 'sso',
        externalId: externalId || null,
        status: 'pending',
    });
    await LogService.log({
        action: 'ONBOARDING_REQUEST',
        entityType: 'onboarding',
        details: `SSO onboarding request (${provider}): ${email}`,
    });
    notifyOnboardingAdmins(email);
    return { created: true };
}

/** True if an open onboarding request exists for this email (for login UX). */
async function hasPending(email) {
    return !!(await pendingByEmail(email));
}

/**
 * The CURRENT state of the most recent request for an email — what the holding
 * page needs to stop being a dead end.
 *
 * The "awaiting setup" page used to be a static leaflet: it said the same
 * sentence forever, including long after the request had been approved (account
 * live, applicant still waiting) or rejected (decision made, applicant never
 * told, because the only channel was an email that a switched-off SMTP silently
 * drops). This returns the truth so the page can say it.
 *
 * Callers MUST only ask about an email the visitor proved they own in this
 * session (i.e. the one they just submitted) — it is not an endpoint to probe
 * arbitrary addresses with.
 *
 * @param {string} email
 * @returns {Promise<null|{status:string, source:string|null, decisionNote:string|null, decidedAt:string|null}>}
 */
async function statusForEmail(email) {
    const e = String(email || '')
        .toLowerCase()
        .trim();
    if (!e) return null;
    const row = await db.get(
        'SELECT * FROM onboarding_requests WHERE lower(email) = ? ORDER BY id DESC LIMIT 1',
        [e]
    );
    if (!row) return null;
    return {
        status: row.status || 'pending',
        source: row.source || null,
        decisionNote: row.decisionNote || null,
        decidedAt: row.decidedAt || null,
    };
}

async function listPending() {
    return OnboardingRequestModel.findPending();
}
async function get(id) {
    return OnboardingRequestModel.findById(id);
}
async function countPending() {
    return OnboardingRequestModel.count({ status: 'pending' });
}

/**
 * Place a pending request: create the employee and mark the request approved.
 * @param {number} id
 * @param {object} placement {employeeNumber, firstName, lastName, siteId, departmentId, serviceId, roleId, supervisorId?, managerId?, managerType?, username?}
 * @param {number} adminId
 * @returns {Promise<{ok:boolean, message?:string, employee?:object}>}
 */
/**
 * Placement validation shared with the employee form. Returns an {ok:false,…}
 * result to bubble up, or null when the placement is sound.
 *
 * @param {object} placement {siteId, departmentId, serviceId, supervisorId?, managerId?, managerType?}
 * @param {number} adminId   the approving admin (resolved to a principal here)
 */
async function validatePlacement(placement, adminId) {
    const AdminModel = require('../models/AdminModel');
    const RBACService = require('./RBACService');
    const { destinationPlacementError } = require('../controllers/EmployeeController');

    const admin = adminId != null ? await AdminModel.findById(adminId) : null;
    const actor = admin ? { ...admin, userType: 'admin' } : null;

    // t returns the KEY so the message can be mapped to a stable code.
    const key = await destinationPlacementError(actor, placement, (k) => k);
    if (key) {
        const CODES = {
            'flash:emp_place_incomplete': 'onbx_q_missing_field',
            'flash:emp_place_inconsistent': 'onbx_q_place_inconsistent',
            'flash:emp_create_scope_denied': 'onbx_q_scope_denied',
        };
        const code = CODES[key] || 'onbx_q_place_inconsistent';
        if (code === 'onbx_q_missing_field') {
            const missing = !placement.siteId
                ? 'site'
                : !placement.departmentId
                  ? 'department'
                  : 'service';
            return {
                ok: false,
                code,
                params: { field: missing },
                message: `Missing required placement field: ${missing}Id.`,
            };
        }
        return {
            ok: false,
            code,
            message:
                code === 'onbx_q_scope_denied'
                    ? 'That placement is outside your scope.'
                    : 'The selected site, department and service do not nest.',
        };
    }

    const reviewerOk = async (empId) => {
        const emp = await EmployeeModel.findById(empId);
        if (!emp || !emp.isActive || emp.cancelledAt) return false;
        if (!actor) return true;
        return RBACService.canAccessEmployeeData(actor, emp);
    };
    if (placement.supervisorId && !(await reviewerOk(placement.supervisorId))) {
        return {
            ok: false,
            code: 'onbx_q_bad_supervisor',
            message: 'The supervisor must be an active employee within your scope.',
        };
    }
    if (placement.managerId) {
        const type = placement.managerType || 'employee';
        if (type === 'admin') {
            const a = await AdminModel.findById(placement.managerId);
            if (!a || a.isActive === false)
                return {
                    ok: false,
                    code: 'onbx_q_bad_manager',
                    message: 'The manager must be an active account within your scope.',
                };
        } else if (!(await reviewerOk(placement.managerId))) {
            return {
                ok: false,
                code: 'onbx_q_bad_manager',
                message: 'The manager must be an active account within your scope.',
            };
        }
    }
    return null;
}

async function approve(id, placement, adminId) {
    const reqRow = await OnboardingRequestModel.findById(id);
    if (!reqRow || reqRow.status !== 'pending')
        return {
            ok: false,
            code: 'onbx_q_not_found',
            message: 'Request not found or already decided.',
        };

    // `field` is the translation slug for the unit; `message` keeps the raw key
    // name so logs (and the placement unit test) still name the exact field.
    const required = {
        siteId: 'site',
        departmentId: 'department',
        serviceId: 'service',
        roleId: 'role',
    };
    for (const k of Object.keys(required)) {
        if (!placement[k]) {
            return {
                ok: false,
                code: 'onbx_q_missing_field',
                params: { field: required[k] },
                message: `Missing required placement field: ${k}.`,
            };
        }
    }

    const firstName = (placement.firstName || reqRow.firstName || '').trim();
    const lastName = (placement.lastName || reqRow.lastName || '').trim();
    if (!firstName || !lastName)
        return {
            ok: false,
            code: 'onbx_q_name_required',
            message: 'First and last name are required to create the employee.',
        };

    // The placement must be a REAL placement: service → department → site must
    // nest, the units must be inside the approving admin's scope, and the
    // supervisor / manager must be ACTIVE, non-voided people the admin may see.
    // Nothing here was checked before — a valid-looking trio that did not nest
    // was stored, and a leaver or a voided record could be handed a new joiner
    // to review. Same rule as the employee form (destinationPlacementError),
    // resolved against the acting admin so the two screens cannot drift apart.
    const placementCheck = await validatePlacement(placement, adminId);
    if (placementCheck) return placementCheck;

    // employee_number: use the provided one (must be unique) or generate a unique fallback.
    let employeeNumber = (placement.employeeNumber || '').trim();
    if (employeeNumber) {
        const clash = await EmployeeModel.findByEmployeeNumber(employeeNumber);
        if (clash)
            return {
                ok: false,
                code: 'onbx_q_empnum_taken',
                params: { number: employeeNumber },
                message: `Employee number "${employeeNumber}" is already in use.`,
            };
    } else {
        // ONB-<id>; bump if (improbably) taken.
        let n = Number(id);
        employeeNumber = `ONB-${n}`;
        /* eslint-disable no-await-in-loop */
        while (await EmployeeModel.findByEmployeeNumber(employeeNumber)) {
            n += 1;
            employeeNumber = `ONB-${n}`;
        }
        /* eslint-enable no-await-in-loop */
    }

    // The address may already belong to other accounts (a person may hold
    // several — migration 107): allowed, but the approver is TOLD, so a request
    // that duplicates an existing person is still noticed.
    const sharedWith = reqRow.email
        ? await require('./EmailAccountsService')
              .accountsWithEmail(reqRow.email)
              .catch(() => [])
        : [];

    // Username: explicit, else derived from name; ensured unique.
    const base = baseUsername({
        username: placement.username,
        firstName,
        lastName,
        employeeNumber,
    });
    const username = await uniqueUsername(
        base,
        async (u) => !!(await EmployeeModel.findByUsername(u))
    );

    const data = {
        employeeNumber,
        firstName,
        lastName,
        email: reqRow.email || null,
        siteId: placement.siteId,
        departmentId: placement.departmentId,
        serviceId: placement.serviceId,
        roleId: placement.roleId,
        supervisorId: placement.supervisorId || null,
        managerId: placement.managerId || null,
        managerType: placement.managerType || (placement.managerId ? 'employee' : null),
        username,
        passwordHash: reqRow.passwordHash || null, // signup keeps their chosen password; SSO has none (logs in via IdP)
        isAccountActive: true,
        isActive: true,
        forcePasswordChange: false,
        authProvider: reqRow.authProvider || null,
        externalId: reqRow.externalId || null,
    };

    // Atomic: create the employee and mark the request approved together, so a
    // failure can't leave an orphan employee + a stuck 'pending' request.
    const employee = await db.runTransaction(async () => {
        const emp = await EmployeeModel.create(data);
        await OnboardingRequestModel.update(id, {
            status: 'approved',
            decidedBy: adminId,
            decidedAt: new Date().toISOString(),
            createdEmployeeId: emp.id,
        });
        return emp;
    });

    await LogService.log({
        adminId,
        action: 'ONBOARDING_APPROVED',
        entityType: 'onboarding',
        entityId: id,
        details: `Placed onboarding request ${reqRow.email} as employee #${employee.id} (${employeeNumber})`,
    });

    // CLOSE THE LOOP WITH THE APPLICANT. Approval used to be silent: the account
    // went live and the only trace was an audit line the applicant cannot read,
    // so they stayed parked on the "awaiting setup" page indefinitely. Reuses the
    // existing 'lifecycle.joiner' kind — bilingual title ("Bienvenue — votre
    // compte est prêt" / "Welcome — your account is ready"), 'digest' email tier,
    // so the mail follows the established in-app-first policy instead of adding a
    // new immediate send. Link is overridden to the EMPLOYEE dashboard (the
    // KIND_META default '/dashboard' bounces an employee), exactly as
    // LifecycleService.onJoiner does.
    //
    // AWAITED, unlike the fire-and-forget admin ping above: notify resolves to
    // a status object and never throws, so awaiting costs one INSERT and cannot
    // fail the placement — while an un-awaited call can outlive a surrounding
    // transaction and commit a notification for an employee whose creation was
    // rolled back (observed in a rollback probe). The try/catch still guards the
    // unexpected; a notification must never undo a completed placement.
    try {
        await require('./NotificationService').notify({
            userType: 'employee',
            userId: Number(employee.id),
            kind: 'lifecycle.joiner',
            category: 'lifecycle',
            payload: { link: '/employee/dashboard', source: 'onboarding' },
        });
    } catch (_) {
        /* never block the placement on a notification */
    }

    return {
        ok: true,
        employee,
        code: 'onbx_q_created',
        params: { name: `${firstName} ${lastName}`, username },
        message: `Account created for ${firstName} ${lastName} (${username}).`,
        // Advisory, not a refusal: the address is also carried by other accounts.
        warning: sharedWith.length
            ? {
                  code: 'onbx_q_email_shared',
                  params: {
                      count: sharedWith.length,
                      who: sharedWith.map((m) => m.label).join(', '),
                  },
                  message: `Note: this e-mail address is also used by ${sharedWith.length} other account(s).`,
              }
            : null,
    };
}

/** HTML-escape a value interpolated into the rejection mail. */
function esc(s) {
    return String(s == null ? '' : s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

/**
 * The rejection notice, FR primary + EN parity in ONE message.
 *
 * A rejected applicant has no account, therefore no stored locale and no in-app
 * inbox — this mail is the only thing they will ever receive, so it cannot be
 * English-only on a French-first product and cannot be guessed into a single
 * language either. FR leads; EN follows under a rule.
 */
function rejectionMail(name, note) {
    const fr = {
        hello: `Bonjour ${name},`,
        body: "Votre demande d'accès à IDevelop n'a pas été approuvée.",
        reason: 'Motif :',
        contact:
            "Si vous pensez qu'il s'agit d'une erreur, veuillez contacter votre administrateur.",
    };
    const en = {
        hello: `Hello ${name},`,
        body: 'Your request to access IDevelop was not approved.',
        reason: 'Reason:',
        contact: 'If you believe this is a mistake, please contact your administrator.',
    };
    const block = (L) =>
        `${L.hello}\n\n${L.body}${note ? `\n\n${L.reason} ${note}` : ''}\n\n${L.contact}`;
    const htmlBlock = (L) =>
        `<p>${esc(L.hello)}</p><p>${esc(L.body)}</p>` +
        (note ? `<p><strong>${esc(L.reason)}</strong> ${esc(note)}</p>` : '') +
        `<p>${esc(L.contact)}</p>`;
    return {
        subject: "[IDevelop] Votre demande d'accès / Your access request",
        text: `${block(fr)}\n\n---\n\n${block(en)}`,
        html: `${htmlBlock(fr)}<hr>${htmlBlock(en)}`,
    };
}

async function reject(id, note, adminId) {
    const reqRow = await OnboardingRequestModel.findById(id);
    if (!reqRow || reqRow.status !== 'pending')
        return {
            ok: false,
            code: 'onbx_q_not_found',
            message: 'Request not found or already decided.',
        };
    await OnboardingRequestModel.update(id, {
        status: 'rejected',
        decidedBy: adminId,
        decidedAt: new Date().toISOString(),
        decisionNote: note || null,
    });
    await LogService.log({
        adminId,
        action: 'ONBOARDING_REJECTED',
        entityType: 'onboarding',
        entityId: id,
        details: `Rejected onboarding request ${reqRow.email}${note ? ' — ' + note : ''}`,
    });
    // Tell the applicant by email (best-effort — no in-app account exists yet;
    // EmailService.send self-skips when SMTP is off, so no extra guard needed).
    // The holding page reads the same decision + note from statusForEmail, so
    // the applicant still learns the outcome when mail never leaves the box.
    try {
        if (reqRow.email) {
            const name = reqRow.firstName || reqRow.email;
            await require('./EmailService').send({
                to: reqRow.email,
                ...rejectionMail(name, note),
            });
        }
    } catch (e) {
        /* email is best-effort; the decision + audit already stand */
    }
    return { ok: true, code: 'onbx_q_rejected', message: 'Request rejected.' };
}

module.exports = {
    isSsoMigrationRunning,
    isEnabled,
    allowSso,
    allowSignup,
    allowOpenSignup,
    allowedDomains,
    emailAllowed,
    accountExists,
    createFromSignup,
    createFromSso,
    hasPending,
    statusForEmail,
    listPending,
    get,
    countPending,
    approve,
    reject,
    validatePlacement,
};
