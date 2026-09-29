// Conventional Commits. Required format: <type>(<scope>): <subject>
//   types : feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert
//   scope : optional; when present, one of the areas below (see CONTRIBUTING.md).
module.exports = {
    extends: ['@commitlint/config-conventional'],
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
