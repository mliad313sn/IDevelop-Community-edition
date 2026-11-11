// Conventional Commits. Required format: <type>(<scope>): <subject>
//   types : feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert
//   scope : optional; when present, one of the areas below (see CONTRIBUTING.md).
// Headers already in the history that break a rule. History is never rewritten,
// so each is listed here by its exact text; add nothing new to this list.
const PUBLISHED_EXCEPTIONS = new Set([
    // 5b24e45: 101 characters, one over header-max-length.
    'feat(core): /setup says whether the instance is ready for go-live, read-only for local administrators',
]);

module.exports = {
    extends: ['@commitlint/config-conventional'],
    ignores: [(message) => PUBLISHED_EXCEPTIONS.has(String(message).split('\n')[0].trim())],
    rules: {
        'header-max-length': [2, 'always', 100],
        'subject-case': [2, 'never', ['upper-case', 'pascal-case', 'start-case']],
        'scope-enum': [
            2,
            'always',
            [
                'core', // server bootstrap, config, middleware
                'auth', // local auth, MFA, sessions, SSO (OIDC / SAML), SCIM
                'rbac', // roles, permissions, admin scopes
                'framework', // domains, sub-domains, skills, role families, roles
                'assess', // self-assessments, reviews, campaigns, disputes
                'talent', // 9-box, succession, IDP, coaching, PIP, mobility
                'reports', // dashboards, report builder, exports
                'jobs', // background jobs and notifications
                'api', // versioned JSON API and integrations (LMS, LTI, webhooks)
                'ui', // views, CSS, client JS
                'brand', // identity, palette, logos, chart identity
                'i18n', // locales
                'db', // migrations, schema, seeds
                'installer', // Windows installer and service tooling
                'docker', // container and compose
                'ci',
                'deps',
                'docs',
                'test',
            ],
        ],
    },
};
