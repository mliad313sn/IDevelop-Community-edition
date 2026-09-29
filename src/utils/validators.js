const { body, validationResult } = require('express-validator');
const { safeBackUrl } = require('./safeRedirect');

/*
 * a failed form never bounces to /dashboard and never
 * wipes what was typed. Every message is a `validation:<key>` translated through
 * req.t at flash time, and the SAFE body (no passwords / tokens) is flashed under
 * `draft:<form path>` so the form route repopulates it (res.locals.draft — the
 * onboarding `placementDraft` idea, generalised). Controllers that refuse a
 * submission for a business reason use keepDraft the same way.
 */

/** Never echo credentials back into a page. */
const SECRET_FIELD = /pass|pwd|secret|token|_csrf|otp|mfa/i;

function safeDraft(body) {
    const out = {};
    Object.entries(body || {}).forEach(([k, v]) => {
        if (SECRET_FIELD.test(k)) return;
        if (v == null) return;
        // Scalars and small arrays (checkbox groups); files/objects never belong in a draft.
        if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').slice(0, 200);
        else if (typeof v === 'object')
            out[k] = v; // scopes[idx][type] — qs-parsed nested object
        else out[k] = String(v).slice(0, 4000);
    });
    return out;
}

/**
 * The GET page that owns the form a POST came from. Explicit table first (these
 * forms sit on list pages or under a different path than the POST), then a
 * same-origin Referer, then the POSTed path itself — never /dashboard.
 */
const FORM_ROUTES = [
    [/^\/employees\/(\d+)$/, (m) => `/employees/${m[1]}/edit`],
    [/^\/employees$/, () => '/employees/create'],
    [/^\/admins\/(\d+)$/, (m) => `/admins/${m[1]}`],
    [/^\/admins$/, () => '/admins/create'],
    [
        /^\/organization\/(sites|departments|services)(\/\d+)?$/,
        (m, req) =>
            String(req.body?.from || '') === 'hub'
                ? `/organization?tab=${m[1]}`
                : `/organization/${m[1]}`,
    ],
    [/^\/(roles|domains|skills)(\/\d+)?$/, (m) => `/${m[1]}`],
];
function formRouteFor(req) {
    const path = String(req.path || '');
    for (const [re, to] of FORM_ROUTES) {
        const m = path.match(re);
        if (m) return to(m, req);
    }
    const back = safeBackUrl(req, '');
    return back || path || '/';
}

/** Flash-key for a form route: the path only, so `?tab=sites` and the plain page share it. */
function draftKey(route) {
    return 'draft:' + String(route).split('?')[0];
}

/**
 * Keep the submitted form for the page we are about to redirect to.
 * Returns the route so callers can write `return res.redirect(keepDraft(req, '/employees/create'))`.
 */
function keepDraft(req, route) {
    const to = route || formRouteFor(req);
    if (req.body && typeof req.flash === 'function') {
        // `__from` = the POSTed path, so a list page hosting both a create and an
        // edit modal knows WHICH one to reopen (e.g. /organization/sites/12).
        req.flash(
            draftKey(to),
            JSON.stringify({ ...safeDraft(req.body), __from: String(req.path || '') })
        );
    }
    return to;
}

/** Translate a `validation:<key>` message (or pass any other text through). */
function translateMsg(req, msg) {
    if (typeof msg === 'string' && msg.startsWith('validation:') && typeof req.t === 'function') {
        const t = req.t(msg);
        return t && t !== msg ? t : msg;
    }
    return msg;
}

// Validation result handler
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const list = errors.array();
        if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
            // Stable `code` (the key) + translated `msg`, so a JSON client can map either.
            return res.status(400).json({
                errors: list.map((e) => ({ ...e, code: e.msg, msg: translateMsg(req, e.msg) })),
            });
        }
        // The password policy yields several errors for one field — say each once.
        [...new Set(list.map((e) => translateMsg(req, e.msg)))].forEach((m) =>
            req.flash('error', m)
        );
        return res.redirect(keepDraft(req));
    }
    next();
};

// Common validation rules
const employeeValidation = [
    body('employeeNumber').optional({ checkFalsy: true }).trim(),
    body('firstName').trim().notEmpty().withMessage('validation:first_name_required'),
    body('lastName').trim().notEmpty().withMessage('validation:last_name_required'),
    body('siteId').isInt({ min: 1 }).withMessage('validation:site_required'),
    body('departmentId').isInt({ min: 1 }).withMessage('validation:department_required'),
    body('serviceId').isInt({ min: 1 }).withMessage('validation:service_required'),
    body('roleId').isInt({ min: 1 }).withMessage('validation:role_required'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('validation:email_invalid'),
    body('phone').optional({ checkFalsy: true }).trim(),
    handleValidationErrors,
];

const siteValidation = [
    body('name').trim().notEmpty().withMessage('validation:site_name_required'),
    handleValidationErrors,
];

const departmentValidation = [
    body('name').trim().notEmpty().withMessage('validation:department_name_required'),
    body('siteId').isInt({ min: 1 }).withMessage('validation:site_required'),
    handleValidationErrors,
];

const serviceValidation = [
    body('name').trim().notEmpty().withMessage('validation:service_name_required'),
    body('departmentId').isInt({ min: 1 }).withMessage('validation:department_required'),
    handleValidationErrors,
];

const domainValidation = [
    body('name').trim().notEmpty().withMessage('validation:domain_name_required'),
    handleValidationErrors,
];

const skillValidation = [
    body('name').trim().notEmpty().withMessage('validation:skill_name_required'),
    // a skill is placed by sub-domain (the pillar/domainId is derived from it).
    body('subDomainId').isInt({ min: 1 }).withMessage('validation:subdomain_required'),
    body('domainId').optional({ checkFalsy: true }).isInt({ min: 1 }),
    // Mirrors the skills_category_check DB constraint so a bad value fails as a
    // friendly validation message instead of a raw 23514 error.
    body('category')
        .optional({ checkFalsy: true })
        .isIn(['Technical', 'Behavioral', 'Safety', 'Compliance'])
        .withMessage('validation:skill_category_invalid'),
    handleValidationErrors,
];

const roleValidation = [
    body('name').trim().notEmpty().withMessage('validation:role_name_required'),
    handleValidationErrors,
];

/*
 * the default SuperAdmin could never save its own form.
 *
 * The product SEEDS `admin@localhost` on both of its bootstrap paths
 * (`src/database/PostgresDatabase.js`, `src/services/AuthService.js`) and the
 * installer normalises it, but `isEmail` defaults to `require_tld: true` and
 * refuses a bare host: `GET /admins/1` pre-filled `admin@localhost`, and posting
 * that very value back answered « Une adresse e-mail valide est requise » and
 * wrote nothing. The rule was right about the general case and wrong about the
 * only address the product itself creates.
 *
 * The rule is NOT disabled. An appliance on a closed network legitimately holds
 * `admin@localhost` or `helpdesk@srv01`, and `<input type="email">` — the rule
 * the browser already applies to this same field — accepts a bare host too. So
 * the chain splits in two on the SHAPE of the domain: no dot → the hostname form
 * is checked without the public-TLD rule; anything else → the strict rule,
 * unchanged, byte for byte. Nothing that used to be refused with a dotted domain
 * becomes acceptable. The form then says, in one sentence, what such an address
 * costs (see `admin:adm_email_no_domain_note`) instead of leaving the operator
 * to guess.
 */
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function _domainOf(value) {
    const s = String(value == null ? '' : value);
    const at = s.lastIndexOf('@');
    return at === -1 ? '' : s.slice(at + 1);
}

/**
 * True when the address names a bare host rather than a domain
 * (`admin@localhost`, `helpdesk@srv01`) — syntactically valid, but nothing sent
 * there leaves the machine. The admin forms use it to explain, not to refuse.
 */
function emailHasNoPublicDomain(value) {
    const dom = _domainOf(value);
    return dom !== '' && !dom.includes('.') && HOSTNAME_LABEL.test(dom);
}

/** The two halves of the e-mail rule for an admin account. */
const adminEmailRules = () => [
    body('email')
        .optional({ checkFalsy: true })
        .if((value) => emailHasNoPublicDomain(value))
        .isEmail({ require_tld: false })
        .withMessage('validation:email_invalid'),
    body('email')
        .optional({ checkFalsy: true })
        .if((value) => !emailHasNoPublicDomain(value))
        .isEmail()
        .withMessage('validation:email_invalid'),
];

const adminValidation = [
    body('username').trim().notEmpty().withMessage('validation:username_required'),
    ...adminEmailRules(),
    body('password').isLength({ min: 12 }).withMessage('validation:pw_min_length'),
    body('password').matches(/[a-z]/).withMessage('validation:pw_lowercase'),
    body('password').matches(/[A-Z]/).withMessage('validation:pw_uppercase'),
    body('password').matches(/[0-9]/).withMessage('validation:pw_number'),
    body('password')
        .matches(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/)
        .withMessage('validation:pw_special'),
    body('passwordConfirm').custom((value, { req }) => {
        if (value !== req.body.password) {
            throw new Error('validation:pw_no_match');
        }
        return true;
    }),
    body('role')
        .isIn(['superadmin', 'localadmin', 'viewer'])
        .withMessage('validation:role_account_required'),
    handleValidationErrors,
];

const adminUpdateValidation = [
    body('username').trim().notEmpty().withMessage('validation:username_required'),
    ...adminEmailRules(),
    body('role')
        .isIn(['superadmin', 'localadmin', 'viewer'])
        .withMessage('validation:role_account_required'),
    handleValidationErrors,
];

const assessmentValidation = [
    body('skillId').isInt({ min: 1 }).withMessage('validation:skill_required'),
    body('currentLevel').isInt({ min: 0, max: 4 }).withMessage('validation:level_range'),
    handleValidationErrors,
];

module.exports = {
    handleValidationErrors,
    keepDraft,
    safeDraft,
    formRouteFor,
    draftKey,
    emailHasNoPublicDomain,
    employeeValidation,
    siteValidation,
    departmentValidation,
    serviceValidation,
    domainValidation,
    skillValidation,
    roleValidation,
    adminValidation,
    adminUpdateValidation,
    assessmentValidation,
};
