'use strict';
/**
 * Contextual, clearance-aware user guide. Renders only the sections the
 * signed-in user can actually use (employee → supervisor → manager → local-admin
 * → super admin), in EN/FR, inside the app shell. Supervisor and manager are
 * SEPARATE sections: a supervisor must not be shown the two decisions reserved
 * to a manager (manager validation, arbitration) — that would be a false
 * promise. Same content source as the standalone /user-guide.html.
 */
const C = require('../config/userGuideContent');

const ROLE_LABEL = {
    employee: { en: 'Employee', fr: 'Collaborateur' },
    supervisor: { en: 'Supervisor', fr: 'Superviseur' },
    manager: { en: 'Manager', fr: 'Manager' },
    localadmin: { en: 'Local Admin', fr: 'Administrateur local' },
    superadmin: { en: 'Super Admin', fr: 'Super administrateur' },
};

// Maps each guide feature (by its EN title) to the real in-app page it teaches,
// so the guide can offer a live "Open" button. GENERATED from each block's own
// verified `where` path — every route here is one design review actually opened.
// Signed-out pages (/login, /forgot-password) are deliberately absent.
const ROUTE_MAP = {
    'Your reviews and raising a dispute': '/employee/supervisor-reviews',
    'My Progression — your campaign history': '/employee/my-progress',
    'My growth — opportunities, aspirations, surveys, recognition': '/employee/opportunities',
    'My learning — what is assigned to you': '/employee/my-learning',
    'My certifications and VOCs': '/employee/my-certifications',
    'My coaching and mentoring': '/employee/my-coaching',
    'My OKRs and 1-on-1s': '/employee/okr',
    'Notifications — everything waiting for you': '/notifications',
    'My profile — your contact details (and what you cannot change)': '/account',
    'Active sessions — see and close your sign-ins': '/account/sessions',
    'Notification preferences and quiet hours': '/account/notifications',
    'Change your password (12 characters minimum)': '/change-password',
    'Two-factor authentication (2FA) — optional but recommended': '/v2/uam/mfa/manage',
    'The built-in manual and contextual help': '/guide',
    'Self-assessment reviews': '/supervisor/self-assessment-reviews',
    'Detailed review and retained level': '/supervisor/reviews',
    '9-Box grid — draft the proposal': '/talent/nine-box',
    'Gap analysis for their team': '/supervisor/gap-analysis',
    'Coaching and development plans': '/coaching/plans',
    'My Team — your manager home': '/supervisor/dashboard',
    'Review self-assessments — and enter YOUR rating': '/supervisor/self-assessment-reviews',
    'Gap analysis — a measured gap is not an unmeasured one': '/supervisor/gap-analysis',
    'Workforce Capability Dashboard — Executive overview': '/dashboard',
    'Departmental analytics, campaign burndown, progression': '/reports/dept-analytics',
    'Readiness report (ready-made view)': '/reports/readiness',
    'Gaps report (the training shopping list)': '/reports/gaps',
    'Report Builder': '/reports/builder',
    'Report schedules and the personal departmental digest': '/reports/schedules',
    '9-Box grid — the roster and its state': '/talent/nine-box',
    'Talent Actions — the development backlog': '/talent/actions',
    'Career path and readiness': '/talent/career-path',
    'Coaching and mentoring': '/coaching/plans',
    'Individual Development Plans (IDP)': '/v2/idp/manage',
    'Performance Improvement Plans (PIP)': '/v2/pip',
    'Assessment disputes': '/v2/slf/disputes',
    'People continuity — succession, risk-of-loss, handover': '/v2/continuity',
    'Who is qualified — the operational lookup': '/qualified',
    'Operational compliance — certifications, VOC, coverage': '/compliance',
    'Key-person risk — and the unknown that is not a risk': '/exec/key-person',
    'Movements — what moved, who acted, and under what name': '/movements',
    'Cancellations — you request, an administrator decides': '/cancellations',
    'Post-approval revisions': '/reviews/post-approval',
    'Employee directory': '/employees',
    'Employee profile — evolution, 9-box, OKRs, 1-on-1s': '/employees',
    'A report’s progression (campaign history)': '/employees',
    'Skill matrix (people × skills grid)': '/skill-matrix',
    'Benchmark — role requirements and fit': '/benchmark',
    'Role drill-through and succession (from the Benchmark)': '/benchmark/role',
    'Org chart — four views, search and focus': '/org-chart',
    'Lifecycle events (joiner / mover / leaver)': '/v2/lifecycle',
    'Talent & Engagement Suite': '/v2/cap',
    'Action Center (bell) and notifications': '/notifications',
    'CSV exports — what you actually get': '/reports/readiness',
    'Manager validation of a reviewed file': '/api/self-assessment/',
    'Arbitrating a disagreement': '/api/self-assessment/',
    '9-Box grid — approve and publish': '/talent/nine-box',
    'Disputes: the three levels': '/v2/slf/disputes',
    'Automatic L2 close-out on expiry': '/v2/slf/disputes',
    'A wider span than the supervisor’s': '/dashboard',
    'What you can do = your granted capabilities × your scope': '/mon-acces',
    'Your people — 41 employees, and 403 on everybody else': '/employees',
    'System Logs — delegable, and already limited to your scope': '/system-logs',
    'Viewer — a read-only role that sees nothing until it is given a scope': '/mon-acces',
    'Readiness SCORE vs role-ready VERDICT — two different numbers': '/reports/readiness',
    'Admins — delegate a capability WITHIN a scope': '/admins',
    'My access — the 31-capability catalogue and what each account holds': '/mon-acces',
    'Access Review — recertify privileged accounts': '/admin/access-review',
    'Data Management — exports, templates, imports and snapshots': '/data-management',
    'SQL Console — the last-resort tool, with an automatic restore point':
        '/data-management/sql-console',
    'System Logs — traceability, already scoped': '/system-logs',
    'Session Monitor — see and close any open session': '/admin/sessions',
    'App Settings — 66 settings in 12 categories, plus branding': '/app-settings',
    'Single Sign-On (SSO) — the configuration screen': '/app-settings/sso',
    'API keys & Power BI feeds — one key per audience, partitioned by profile': '/admin/api-keys',
    'License & entitlement — soft enforcement, never a lock-out': '/admin/license',
    'Assessment campaigns — where each stands, and who has not started': '/cycles',
    'Operational Compliance — certificates, coverage rules, planned absences': '/compliance',
    'Report builder, templates and scheduled sends': '/reports/builder',
    'Credentials, authentication policy and deactivating an account': '/employees',
    'Access & Identity — link an SSO identity, grant administrator access': '/employees',
    'Self-service onboarding — the queue and its switch': '/onboarding',
    'LMS Hub — connect Cornerstone, MyPath or any xAPI/LTI LMS': '/v2/lms',
    'Local Content module — present, off by default': '/reports/local-content',
    'Organization — countries, sites, departments, services': '/organization',
    'Getting-started checklist — nine steps, each with its real count': '/setup',
    'About — the exact instance you are looking at': '/about',
    'Password policy — 12 characters, announced and enforced': '/change-password',
    'Your account: email, notifications, sessions, password, 2FA': '/account',
    'Switch the app language (FR/EN) & get help anywhere': '/guide',
};

const LANGS = new Set(['en', 'fr']);

class GuideController {
    index(req, res) {
        const clearance = C.clearanceOf(req.user);
        const ids = C.SECTIONS_FOR[clearance] || ['employee'];
        const sections = C.PROFILES.filter((p) => ids.includes(p.id));
        // the guide is rendered SERVER-SIDE in ONE language. It used to
        // emit both halves and hide one in CSS, so a French reader still
        // downloaded the whole English manual — the last "English on a French
        // page" source. The page follows the session language; `?glang=` is a
        // plain link that lets a reader read the manual in the other language
        // without switching the whole app, and needs no JavaScript.
        const session = String(res.locals.lang || 'fr')
            .toLowerCase()
            .slice(0, 2);
        const asked = String(req.query.glang || '').toLowerCase();
        const glang = LANGS.has(asked) ? asked : session === 'en' ? 'en' : 'fr';
        res.render('pages/guide', {
            title: req.t ? req.t('chrome:pt_user_guide') : 'User Guide',
            clearance,
            glang,
            roleLabel: ROLE_LABEL[clearance] || ROLE_LABEL.employee,
            getting: C.GETTING,
            sections,
            flows: C.FLOWS,
            glossary: C.GLOSSARY,
            faq: C.FAQ,
            routes: ROUTE_MAP,
        });
    }
}

module.exports = new GuideController();
