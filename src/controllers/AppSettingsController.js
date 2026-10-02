const PRODUCT = require('../config/product');
const AppSettingsModel = require('../models/AppSettingsModel');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');
const EmailService = require('../services/EmailService');
const { validationResult } = require('express-validator');

class AppSettingsController {
    async index(req, res) {
        try {
            // Read page: view_app_settings may SEE settings (manage_app_settings
            // implies it). Update/reset/testEmail below keep manage_app_settings.
            if (!RBACService.hasPermission(req.user, 'view_app_settings')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_manage_superadmin')
                        : 'You do not have permission to view app settings.'
                );
                return res.redirect('/dashboard');
            }

            // Ensure defaults are initialized
            await AppSettingsModel.initializeDefaults();

            const settings = await AppSettingsModel.findAll();

            // Group settings by category. Job-state markers are pulled
            // out of their tunable categories into one read-only "job state"
            // block whatever category the writing job used ('ops', 'jobs', …).
            const settingsByCategory = {};
            const jobState = [];
            settings.forEach((setting) => {
                setting.rule = AppSettingsModel.ruleFor(setting.settingKey);
                if (setting.rule.readOnly) {
                    jobState.push(setting);
                    return;
                }
                if (!settingsByCategory[setting.category]) {
                    settingsByCategory[setting.category] = [];
                }
                settingsByCategory[setting.category].push(setting);
            });
            // A refused save comes back here with the field, the typed
            // value and the message, so the dialog reopens on that setting with
            // the error next to the input instead of a page-level flash.
            let settingError = null;
            try {
                const raw = req.flash('settingError');
                if (raw && raw[0]) settingError = JSON.parse(raw[0]);
            } catch (_) {
                settingError = null;
            }

            // Boot-level .env configuration, shown READ-ONLY to super admins so the
            // whole server configuration is visible from the app. These require a
            // .env edit + service restart (they configure the process itself);
            // secrets and credentials are masked to set / not set.
            let envInfo = null;
            if (req.user && req.user.role === 'superadmin') {
                const e = process.env;
                // the .env panel printed English notes and
                // English placeholder values ("not set", "(auto-detect)"…) on the
                // French UI. Both sides are locale keys now; the variable NAMES and
                // the real configured values stay verbatim (they are not prose).
                const T = (k, fb, p) =>
                    req.t ? req.t(`admin:${k}`, Object.assign({ defaultValue: fb }, p || {})) : fb;
                const setOrNot = (v) => (v ? T('env_v_set', 'set') : T('env_v_not_set', 'not set'));
                const dflt = (v) => `${v} ${T('env_v_default', '(default)')}`;
                let dbDisplay = T('env_v_not_set', 'not set');
                try {
                    const u = new URL(e.DATABASE_URL);
                    dbDisplay = T(
                        'env_v_db_display',
                        `${u.hostname}:${u.port || '5432'}${u.pathname}`,
                        {
                            host: u.hostname,
                            port: u.port || '5432',
                            path: u.pathname,
                            user: decodeURIComponent(u.username),
                        }
                    );
                } catch (_) {
                    /* keep */
                }
                const autoDetect = T('env_v_auto_detect', '(auto-detect)');
                envInfo = [
                    {
                        name: 'NODE_ENV',
                        value: e.NODE_ENV || T('env_v_unset', '(unset)'),
                        note: T('env_note_NODE_ENV', 'Runtime mode'),
                    },
                    {
                        name: 'PORT',
                        value: e.PORT || dflt('3000'),
                        note: T('env_note_PORT', 'HTTP port'),
                    },
                    {
                        name: 'APP_BASE_URL',
                        value:
                            e.APP_BASE_URL ||
                            e.BASE_URL ||
                            T('env_v_derived_host', '(derived from server hostname)'),
                        note: T(
                            'env_note_APP_BASE_URL',
                            'Public base URL for links in emails (BASE_URL accepted as alias)'
                        ),
                    },
                    {
                        name: 'TRUSTED_HOSTS',
                        value: e.TRUSTED_HOSTS || T('env_v_none', '(none)'),
                        note: T(
                            'env_note_TRUSTED_HOSTS',
                            'Host headers allowed in email links when APP_BASE_URL is unset'
                        ),
                    },
                    {
                        name: 'DATABASE_URL',
                        value: dbDisplay,
                        note: T('env_note_DATABASE_URL', 'PostgreSQL connection'),
                    },
                    {
                        name: 'REDIS_URL',
                        value: setOrNot(e.REDIS_URL),
                        note: T(
                            'env_note_REDIS_URL',
                            'Optional job queue backend (inline when unset)'
                        ),
                    },
                    {
                        name: 'SESSION_SECRET',
                        value: setOrNot(e.SESSION_SECRET),
                        note: T('env_note_SESSION_SECRET', 'Session cookie signing key'),
                    },
                    {
                        name: 'APP_KEY',
                        value: setOrNot(e.APP_KEY),
                        note: T('env_note_APP_KEY', 'Application encryption key'),
                    },
                    {
                        name: 'COOKIE_SECURE',
                        value: e.COOKIE_SECURE || 'auto',
                        note: T(
                            'env_note_COOKIE_SECURE',
                            'Force Secure cookies (behind HTTPS/proxy)'
                        ),
                    },
                    {
                        name: 'TRUST_PROXY',
                        value: e.TRUST_PROXY || T('env_v_off', '(off)'),
                        note: T('env_note_TRUST_PROXY', 'Behind a reverse proxy'),
                    },
                    {
                        name: 'SESSION_MAX_HOURS',
                        value: e.SESSION_MAX_HOURS || dflt('24'),
                        note: T(
                            'env_note_SESSION_MAX_HOURS',
                            'Fallback for sessionTimeout (the setting above wins when set)'
                        ),
                    },
                    // Code default is 5, not 10 — and both are only the FALLBACK
                    // of the maxLoginAttempts / loginLockoutMinutes settings above.
                    {
                        name: 'LOGIN_RATE_LIMIT / WINDOW',
                        value: `${e.LOGIN_RATE_LIMIT || dflt('5')} / ${e.LOGIN_RATE_WINDOW || '15'} min`,
                        note: T(
                            'env_note_LOGIN_RATE',
                            'Fallback for maxLoginAttempts (settings above win when set)'
                        ),
                    },
                    {
                        name: 'LOGIN_LOCKOUT_DURATION',
                        value: `${e.LOGIN_LOCKOUT_DURATION || dflt('30')} min`,
                        note: T(
                            'env_note_LOGIN_LOCKOUT_DURATION',
                            'Fallback for loginLockoutMinutes (settings above win when set)'
                        ),
                    },
                    {
                        name: 'API_RATE_LIMIT / WINDOW',
                        value: `${e.API_RATE_LIMIT || '100'} / ${e.API_RATE_WINDOW || '15'} min`,
                        note: T('env_note_API_RATE', 'API requests per window'),
                    },
                    {
                        name: 'SIGNUP_RATE_LIMIT / WINDOW',
                        value: `${e.SIGNUP_RATE_LIMIT || '5'} / ${e.SIGNUP_RATE_WINDOW || '60'} min`,
                        note: T('env_note_SIGNUP_RATE', 'Self-service signups per window'),
                    },
                    {
                        name: 'WRITE_ACTION_LIMIT',
                        value: e.WRITE_ACTION_LIMIT || dflt('30'),
                        note: T(
                            'env_note_WRITE_ACTION_LIMIT',
                            'Survey/recognition/feedback writes per window'
                        ),
                    },
                    {
                        name: 'JSON_BODY_LIMIT / FORM_BODY_LIMIT',
                        value: `${e.JSON_BODY_LIMIT || dflt('')} / ${e.FORM_BODY_LIMIT || dflt('')}`,
                        note: T('env_note_BODY_LIMIT', 'Request body size caps'),
                    },
                    {
                        name: 'PG_POOL_MAX / MIN',
                        value: `${e.PG_POOL_MAX || dflt('')} / ${e.PG_POOL_MIN || dflt('')}`,
                        note: T('env_note_PG_POOL', 'DB connection pool size'),
                    },
                    {
                        name: 'PG_QUERY_TIMEOUT_MS',
                        value: e.PG_QUERY_TIMEOUT_MS || dflt('30000'),
                        note: T('env_note_PG_QUERY_TIMEOUT_MS', 'Per-query timeout'),
                    },
                    {
                        name: 'SLOW_REQUEST_MS / SLOW_QUERY_MS',
                        value: `${e.SLOW_REQUEST_MS || '1500'} / ${e.SLOW_QUERY_MS || '400'}`,
                        note: T('env_note_SLOW_MS', 'Telemetry thresholds'),
                    },
                    {
                        name: 'BACKUP_DIR',
                        value: e.BACKUP_DIR || dflt('<app>/backups/auto'),
                        note: T(
                            'env_note_BACKUP_DIR',
                            'Daily backup folder (hour & retention are settings above)'
                        ),
                    },
                    {
                        name: 'SQL_CONSOLE_BACKUP_DIR',
                        value:
                            e.SQL_CONSOLE_BACKUP_DIR ||
                            dflt('%ProgramData%/IDevelop/sql-restore-points'),
                        note: T('env_note_SQL_CONSOLE_BACKUP_DIR', 'SQL Console restore points'),
                    },
                    {
                        name: 'UPLOADS_DIR / QUARANTINE_DIR',
                        value: `${e.UPLOADS_DIR || dflt('uploads')} / ${e.QUARANTINE_DIR || dflt('uploads/_quarantine')}`,
                        note: T('env_note_UPLOADS_DIR', 'Evidence file storage'),
                    },
                    {
                        name: 'PG_BIN / PG_DUMP_PATH',
                        value: `${e.PG_BIN || autoDetect} / ${e.PG_DUMP_PATH || autoDetect}`,
                        note: T('env_note_PG_BIN', 'PostgreSQL client tools'),
                    },
                    {
                        name: 'CLAMD_SOCKET',
                        value: e.CLAMD_SOCKET || T('env_v_disabled', '(disabled)'),
                        note: T('env_note_CLAMD_SOCKET', 'Optional ClamAV upload scanning'),
                    },
                    {
                        name: 'V2_FEATURES',
                        value:
                            e.V2_FEATURES ||
                            T('env_v_v2_unset', '(unset: modules follow the adoption stage)'),
                        note: T(
                            'env_note_V2_FEATURES',
                            'Legacy: 1 forces every optional module on'
                        ),
                    },
                    {
                        name: 'DISABLE_INPROC_JOBS',
                        value:
                            e.DISABLE_INPROC_JOBS ||
                            T('env_v_inproc_jobs', '(jobs run in-process)'),
                        note: T('env_note_DISABLE_INPROC_JOBS', 'Background job host switch'),
                    },
                    {
                        name: 'LOG_MAX_BYTES / LOG_MAX_FILES',
                        value: `${e.LOG_MAX_BYTES || dflt('')} / ${e.LOG_MAX_FILES || dflt('')}`,
                        note: T('env_note_LOG_MAX', 'Log rotation'),
                    },
                    {
                        name: 'LLM_URL / LLM_MODEL',
                        value: e.LLM_URL
                            ? `${e.LLM_URL} / ${e.LLM_MODEL || 'llama3.1'}`
                            : T(
                                  'env_v_superseded_copilot',
                                  '(superseded by the copilot settings above)'
                              ),
                        note: T('env_note_LLM', 'Legacy copilot fallback'),
                    },
                ];
            }

            res.render('pages/app-settings/index', {
                title: req.t ? req.t('chrome:pt_app_settings') : 'App Settings',
                settings,
                settingsByCategory,
                jobState,
                settingError,
                envInfo,
                // Copilot provider presets — shown in the test card so an admin
                // sees the supported engines + default models without docs.
                copilotPresets: require('../services/CopilotService').presets(),
                // the breadcrumb printed the literal English "App Settings"
                // on the French UI.
                breadcrumbs: [
                    {
                        label: req.t
                            ? req.t('admin:set_bc_configuration', { defaultValue: 'Configuration' })
                            : 'Configuration',
                        url: '/organization',
                    },
                    {
                        label: req.t
                            ? req.t('admin:set_bc_app_settings', { defaultValue: 'App settings' })
                            : 'App settings',
                    },
                ],
            });
        } catch (error) {
            console.error('App settings index error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:settings_load_error') : 'Error loading app settings'
            );
            res.redirect('/dashboard');
        }
    }

    async update(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'manage_app_settings')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_update_superadmin')
                        : 'Only SuperAdmins can update app settings'
                );
                return res.redirect('/app-settings');
            }

            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_validation_errors', {
                              errors: errors
                                  .array()
                                  .map((e) => e.msg)
                                  .join(', '),
                          })
                        : 'Validation errors: ' +
                              errors
                                  .array()
                                  .map((e) => e.msg)
                                  .join(', ')
                );
                return res.redirect('/app-settings');
            }

            // The type is the STORED type — never `req.body.settingType` (
            // a client could post settingType=string and park "abc" in a numeric
            // setting; the page then showed "abc" while getValue served the default).
            const { id, settingValue } = req.body;
            const setting = await AppSettingsModel.findAll();
            // PG returns BIGINT ids as strings — compare numerically.
            const currentSetting = setting.find((s) => Number(s.id) === Number(id));

            if (!currentSetting) {
                req.flash('error', req.t ? req.t('flash:settings_not_found') : 'Setting not found');
                return res.redirect('/app-settings');
            }
            const settingType = currentSetting.settingType;

            // Field-level refusal: the dialog reopens on this setting with the
            // message under the input (index reads the flash back).
            const refuse = (code, params) => {
                const msg = req.t
                    ? req.t(`admin:set_err_${code}`, { ...params, defaultValue: code })
                    : code;
                req.flash(
                    'settingError',
                    JSON.stringify({
                        id: Number(id),
                        key: currentSetting.settingKey,
                        value: settingValue == null ? '' : String(settingValue).slice(0, 500),
                        msg,
                    })
                );
                return res.redirect('/app-settings');
            };
            if (AppSettingsModel.isReadOnly(currentSetting.settingKey))
                return refuse('readonly', { key: currentSetting.settingKey });

            // Auth-surface settings (self-service onboarding) change who can get
            // INTO the system, so they are SuperAdmin-only — a delegated
            // manage_app_settings admin must not be able to enable open signup or
            // widen the domain allowlist. (SSO is already SuperAdmin-only on its
            // own page.)
            // onboarding = who can get IN; copilot = the outbound LLM URL the server
            // fetches (an SSRF sink), so restricting the target to superadmins keeps a
            // delegated manage_app_settings admin from pointing it at internal hosts.
            // 3.23.19: SSO settings — the master switch,
            // issuers, secrets, the multi-factor acr list — decide who signs in and
            // what counts as MFA. They are written ONLY through the SuperAdmin SSO
            // page (/app-settings/sso: validation + live reload), never through this
            // generic handler, whoever the actor is.
            const isSsoSetting = require('../utils/ssoSettingKeys').isSsoSettingKey(
                currentSetting.settingKey,
                currentSetting.category
            );
            if (isSsoSetting) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_sso_only_on_sso_page')
                        : 'Les réglages SSO se modifient uniquement sur la page Authentification unique (super administrateur).'
                );
                return res.redirect('/app-settings');
            }
            const SENSITIVE_CATEGORIES = new Set(['onboarding', 'copilot']);
            if (
                SENSITIVE_CATEGORIES.has(currentSetting.category) &&
                !(req.user && req.user.role === 'superadmin')
            ) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_onboarding_superadmin')
                        : 'Only SuperAdmins can change self-service onboarding settings.'
                );
                return res.redirect('/app-settings');
            }

            // Secret fields are shown blank in the UI; an empty submission means
            // "leave unchanged" rather than "erase the stored secret".
            // One definition of "secret" (AppSettingsModel): …token / …apiKey too.
            const isSecretKey = AppSettingsModel.isSecretKey(
                currentSetting.settingKey,
                currentSetting.settingType
            );
            if (isSecretKey && (settingValue === undefined || String(settingValue).trim() === '')) {
                req.flash(
                    'success',
                    req.t
                        ? req.t('flash:settings_unchanged', { key: currentSetting.settingKey })
                        : `${currentSetting.settingKey} left unchanged`
                );
                return res.redirect('/app-settings');
            }

            // Per-key validation from the catalog (range, enum, hour, day-of-week,
            // port, URL, e-mail, integer counts). A fractional backupKeep, a
            // backupHour of 99 or a digestDow of 9 never reach the database.
            const check = AppSettingsModel.validate(
                currentSetting.settingKey,
                settingType,
                settingValue
            );
            if (!check.ok) return refuse(check.code, check.params);
            const validatedValue = check.value;

            await AppSettingsModel.update({
                id: parseInt(id),
                settingValue: validatedValue,
                settingType: currentSetting.settingType,
                description: currentSetting.description,
                category: currentSetting.category,
                updatedBy: req.user.id,
            });

            // Email/SMTP settings changed — drop the cached transport so the
            // next send re-reads the new configuration.
            if (
                currentSetting.category === 'email' ||
                currentSetting.settingKey === 'enableEmailNotifications'
            ) {
                EmailService.invalidate();
            }
            // The address used for links in outgoing mail is cached for ~30s so the
            // six leaf callers can stay synchronous. Refresh it immediately on save,
            // or an administrator who fixes a wrong link would keep seeing the old
            // one and reasonably conclude the setting does not work.
            if (currentSetting.settingKey === 'appBaseUrl') {
                require('../utils/emailTemplate')
                    .refreshBaseUrl()
                    .catch(() => {});
            }
            // Copilot LLM settings changed — drop the cached connection config, and
            // warn when the target is a THIRD-PARTY (non-local) host: from then on the
            // RBAC-scoped context (incl. employee names/risk/PIP) leaves the box.
            if (currentSetting.category === 'copilot') {
                require('../services/CopilotService').invalidate();
                if (currentSetting.settingKey === 'copilotUrl' && validatedValue) {
                    let host = '';
                    try {
                        host = new URL(validatedValue).host;
                    } catch (_) {
                        /* ignore */
                    }
                    const isLocal =
                        /^(localhost|127\.|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
                            host
                        );
                    if (host && !isLocal) {
                        req.flash(
                            'success',
                            `Note: ${host} is an external service — the privacy filter applies: copilot requests to it are PSEUDONYMIZED (employee names replaced with EMP-nnn tokens; answers de-tokenized), and each transfer is recorded in the audit log. Only internal/trusted AI servers (copilotTrustedHosts, localhost, LAN) receive full data.`
                        );
                    }
                }
            }

            // Never echo a changed secret into the audit log.
            const isSecret = AppSettingsModel.isSecretKey(
                currentSetting.settingKey,
                currentSetting.settingType
            );
            const logDetail = isSecret
                ? `Updated ${currentSetting.settingKey}`
                : `Updated ${currentSetting.settingKey}: ${currentSetting.settingValue} → ${validatedValue}`;

            await LogService.log({
                adminId: req.user.id,
                action: 'APP_SETTING_UPDATED',
                entityType: 'appSetting',
                entityId: id,
                details: logDetail,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:settings_updated') : 'Setting updated successfully'
            );
            res.redirect('/app-settings');
        } catch (error) {
            console.error('App settings update error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:settings_update_error') : 'Error updating setting'
            );
            res.redirect('/app-settings');
        }
    }

    async testEmail(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'manage_app_settings')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_test_email_superadmin')
                        : 'Only SuperAdmins can send a test email'
                );
                return res.redirect('/app-settings');
            }

            // Default to the signed-in admin's address; allow an override.
            const to = (req.body.testEmailTo && req.body.testEmailTo.trim()) || req.user.email;
            if (!to) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_no_recipient')
                        : 'No recipient address — enter one or set an email on your admin account.'
                );
                return res.redirect('/app-settings');
            }

            // Always invalidate first so the test reflects the latest saved config.
            EmailService.invalidate();
            const verify = await EmailService.verify();
            if (!verify.ok) {
                try {
                    await AppSettingsModel.setValue(
                        'smtpLastFailure',
                        `${new Date().toISOString()} · ${String(verify.error || 'unknown').slice(0, 200)}`,
                        'string',
                        'Last SMTP failure (ISO · error)',
                        'ops',
                        req.user.id
                    );
                } catch (_) {
                    /* best-effort */
                }
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_smtp_failed', { error: verify.error })
                        : `SMTP connection failed: ${verify.error}`
                );
                return res.redirect('/app-settings');
            }

            const result = await EmailService.sendTest(to);
            await LogService.log({
                adminId: req.user.id,
                action: result.sent ? 'EMAIL_TEST_SENT' : 'EMAIL_TEST_FAILED',
                entityType: 'email',
                details: result.sent
                    ? `Test email sent to ${to}`
                    : `Test email to ${to} failed: ${result.error}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            // SMTP verified state: the health page and /setup read these
            // instead of "smtpHost is non-empty". Read-only rows (catalog).
            try {
                if (result.sent) {
                    await AppSettingsModel.setValue(
                        'smtpVerifiedAt',
                        new Date().toISOString(),
                        'string',
                        'Last successful SMTP test (ISO)',
                        'ops',
                        req.user.id
                    );
                    await AppSettingsModel.setValue(
                        'smtpVerifiedBy',
                        req.user.username || String(req.user.id),
                        'string',
                        'Admin who ran the last successful SMTP test',
                        'ops',
                        req.user.id
                    );
                    await AppSettingsModel.setValue(
                        'smtpLastFailure',
                        '',
                        'string',
                        'Last SMTP failure (ISO · error)',
                        'ops',
                        req.user.id
                    );
                } else {
                    await AppSettingsModel.setValue(
                        'smtpLastFailure',
                        `${new Date().toISOString()} · ${String(result.error || 'unknown').slice(0, 200)}`,
                        'string',
                        'Last SMTP failure (ISO · error)',
                        'ops',
                        req.user.id
                    );
                    await require('../services/JobRunService').alert(
                        'ops.smtp_failed',
                        `smtp:${new Date().toISOString().slice(0, 10)}`,
                        { error: String(result.error || '').slice(0, 200), link: '/app-settings' }
                    );
                }
            } catch (_) {
                /* state write best-effort */
            }

            if (result.sent) {
                req.flash(
                    'success',
                    req.t
                        ? req.t('flash:settings_test_email_sent', { to })
                        : `Test email sent to ${to}. Check the inbox to confirm delivery.`
                );
            } else {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_test_email_failed', { error: result.error })
                        : `Test email failed: ${result.error}`
                );
            }
            res.redirect('/app-settings');
        } catch (error) {
            console.error('Test email error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:settings_test_email_error') : 'Error sending test email'
            );
            res.redirect('/app-settings');
        }
    }

    /**
     * Test the configured copilot LLM connection (provider/url/model/key from
     * App Settings) and report reachability + a sample reply.
     */
    async testCopilot(req, res) {
        try {
            // Superadmin-only: testing triggers a server-side fetch to the configured
            // URL (SSRF surface), so keep it aligned with who may set that URL.
            if (!req.user || req.user.role !== 'superadmin') {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_update_superadmin')
                        : 'Only SuperAdmins can update app settings'
                );
                return res.redirect('/app-settings');
            }

            const Copilot = require('../services/CopilotService');
            Copilot.invalidate(); // test the latest SAVED config, not a stale cache
            const status = await Copilot.llmStatus();

            await LogService.log({
                adminId: req.user.id,
                action: status.reachable ? 'COPILOT_TEST_OK' : 'COPILOT_TEST_FAILED',
                entityType: 'appSetting',
                details:
                    `Copilot connection test: provider=${status.provider}, model=${status.model || '-'}, reachable=${status.reachable}` +
                    (status.error ? `, error=${status.error}` : ''),
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            if (!status.configured) {
                // NB: the flash partial renders only success/error types.
                req.flash(
                    'success',
                    req.t
                        ? req.t('flash:copilot_not_configured')
                        : 'No LLM configured (provider is "none") — the copilot answers with the built-in deterministic engine. Set copilotProvider + copilotUrl to connect a model.'
                );
            } else if (status.reachable) {
                req.flash(
                    'success',
                    req.t
                        ? req.t('flash:copilot_test_ok', {
                              provider: status.provider,
                              model: status.model,
                          })
                        : `Copilot LLM reachable (${status.provider} · ${status.model}). Sample reply: ${status.sample || 'ok'}`
                );
            } else {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:copilot_test_failed', { error: status.error })
                        : `Copilot LLM NOT reachable: ${status.error}. The copilot will fall back to deterministic answers.`
                );
            }
            res.redirect('/app-settings');
        } catch (error) {
            console.error('Test copilot error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:copilot_test_error') : 'Error testing the copilot connection'
            );
            res.redirect('/app-settings');
        }
    }

    /**
     * Save the white-label branding (name, tagline, accent color, logo, favicon).
     * Logos are stored as data-URLs in app_settings so branding travels with
     * backups/snapshots/JSON exports and needs no file serving. Applies to the
     * next rendered page — no restart.
     */
    async updateBranding(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'manage_app_settings')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_update_superadmin')
                        : 'Only SuperAdmins can update app settings'
                );
                return res.redirect('/app-settings');
            }

            const fs = require('fs');
            const branding = require('../utils/branding');
            // Attributed: every write from a request names the admin.
            const set = async (key, value, description, category = 'branding') =>
                AppSettingsModel.setValue(key, value, 'string', description, category, req.user.id);

            // Name + tagline (appName lives in the existing 'general' category).
            const appName = String(req.body.appName || '').trim();
            if (appName)
                await set(
                    'appName',
                    appName,
                    'Application name displayed in the header and page titles',
                    'general'
                );
            await set(
                'brandTagline',
                String(req.body.brandTagline || '').trim(),
                'Login-page tagline (blank = default subtitle)'
            );

            // Accent color. "Clear" wins over the (pre-filled) hex field, so ticking
            // the clear box actually clears even when the box still shows the old value.
            const warnings = [];
            const rawColor = String(req.body.brandAccentColor || '').trim();
            if (req.body.clearAccent === '1') {
                await set(
                    'brandAccentColor',
                    '',
                    'Brand accent color (hex) replacing the default gold across the UI'
                );
            } else if (rawColor) {
                const hex = branding.normalizeHex(rawColor);
                if (!hex) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:brand_bad_color')
                            : 'Accent color must be a 6-digit hex value like #1E90FF.'
                    );
                    return res.redirect('/app-settings');
                }
                await set(
                    'brandAccentColor',
                    hex,
                    'Brand accent color (hex) replacing the default gold across the UI'
                );
                const ratio = branding.contrastRatio(hex, '#0F1222'); // main dark surface
                // Low contrast is a WARNING, not an error — the change applied. Fold it
                // into the success message so the admin doesn't see a red "error" next
                // to a green "success" for the same save.
                if (ratio < 3) {
                    warnings.push(
                        req.t
                            ? req.t('flash:brand_low_contrast', { ratio: ratio.toFixed(1) })
                            : `low contrast on the dark theme (${ratio.toFixed(1)}:1 — aim for 3:1+); consider a lighter shade`
                    );
                }
            }

            // Logo / favicon uploads → validated data-URLs.
            const readImage = (file, maxKb) => {
                if (!file) return { skip: true };
                try {
                    const buf = fs.readFileSync(file.path);
                    fs.unlinkSync(file.path);
                    if (buf.length > maxKb * 1024)
                        return { error: `File too large (max ${maxKb} KB).` };
                    const ext = require('path').extname(file.originalname).toLowerCase();
                    const mime = {
                        '.png': 'image/png',
                        '.jpg': 'image/jpeg',
                        '.jpeg': 'image/jpeg',
                        '.webp': 'image/webp',
                        '.svg': 'image/svg+xml',
                        '.ico': 'image/x-icon',
                    }[ext];
                    if (!mime)
                        return { error: 'Unsupported image type. Use PNG, JPG, WEBP, SVG or ICO.' };
                    // SVG hardening: reject active content outright (defence in depth —
                    // <img src=data:> would not execute it, but keep the stored value inert).
                    if (
                        mime === 'image/svg+xml' &&
                        /<script|onload\s*=|onerror\s*=|javascript:/i.test(buf.toString('utf8'))
                    ) {
                        return {
                            error: 'SVG contains active content (script/event handlers) and was rejected.',
                        };
                    }
                    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
                } catch (e) {
                    return { error: 'Could not read the uploaded file.' };
                }
            };

            const files = req.files || {};
            const logo = readImage(files.logoFile && files.logoFile[0], 300);
            const favicon = readImage(files.faviconFile && files.faviconFile[0], 100);
            for (const [label, r] of [
                ['Logo', logo],
                ['Favicon', favicon],
            ]) {
                if (r.error) {
                    req.flash('error', `${label}: ${r.error}`);
                    return res.redirect('/app-settings');
                }
            }
            if (logo.dataUrl)
                await set(
                    'brandLogo',
                    logo.dataUrl,
                    'Company logo (data-URL) shown in the sidebar, on the login page and as favicon fallback'
                );
            if (req.body.clearLogo === '1')
                await set(
                    'brandLogo',
                    '',
                    'Company logo (data-URL) shown in the sidebar, on the login page and as favicon fallback'
                );
            if (favicon.dataUrl)
                await set(
                    'brandFavicon',
                    favicon.dataUrl,
                    'Browser-tab icon (data-URL); falls back to the logo'
                );
            if (req.body.clearFavicon === '1')
                await set(
                    'brandFavicon',
                    '',
                    'Browser-tab icon (data-URL); falls back to the logo'
                );

            branding.invalidate();

            await LogService.log({
                adminId: req.user.id,
                action: 'BRANDING_UPDATED',
                entityType: 'appSetting',
                details: `Branding updated (name=${appName || '(unchanged)'}, accent=${rawColor || '(unchanged)'}, logo=${logo.dataUrl ? 'uploaded' : req.body.clearLogo === '1' ? 'cleared' : 'unchanged'}, favicon=${favicon.dataUrl ? 'uploaded' : req.body.clearFavicon === '1' ? 'cleared' : 'unchanged'})`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            const base = req.t
                ? req.t('flash:brand_updated')
                : 'Branding updated — the new identity applies to every page immediately.';
            req.flash('success', warnings.length ? `${base} (${warnings.join('; ')})` : base);
            res.redirect('/app-settings');
        } catch (error) {
            console.error('Branding update error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:brand_update_error') : 'Error updating branding'
            );
            res.redirect('/app-settings');
        }
    }

    /** Restore the stock identity (name, gold accent, built-in logo). */
    async resetBranding(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'manage_app_settings')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_reset_superadmin')
                        : 'Only SuperAdmins can reset settings'
                );
                return res.redirect('/app-settings');
            }
            const branding = require('../utils/branding');
            await AppSettingsModel.setValue(
                'appName',
                PRODUCT.name,
                'string',
                'Application name displayed in the header and page titles',
                'general',
                req.user.id
            );
            for (const k of ['brandLogo', 'brandFavicon', 'brandAccentColor', 'brandTagline']) {
                await AppSettingsModel.setValue(k, '', 'string', '', 'branding', req.user.id);
            }
            branding.invalidate();
            await LogService.log({
                adminId: req.user.id,
                action: 'BRANDING_RESET',
                entityType: 'appSetting',
                details: 'Branding reset to the stock identity',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash(
                'success',
                req.t ? req.t('flash:brand_reset') : 'Branding reset to the default identity.'
            );
            res.redirect('/app-settings');
        } catch (error) {
            console.error('Branding reset error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:brand_update_error') : 'Error updating branding'
            );
            res.redirect('/app-settings');
        }
    }

    async reset(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'manage_app_settings')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:settings_reset_superadmin')
                        : 'Only SuperAdmins can reset settings'
                );
                return res.redirect('/app-settings');
            }

            await AppSettingsModel.initializeDefaults();

            await LogService.log({
                adminId: req.user.id,
                action: 'APP_SETTINGS_RESET',
                entityType: 'appSetting',
                details: 'Reset all app settings to defaults',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t
                    ? req.t('flash:settings_reset_done')
                    : 'Settings reset to defaults successfully'
            );
            res.redirect('/app-settings');
        } catch (error) {
            console.error('App settings reset error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:settings_reset_error') : 'Error resetting settings'
            );
            res.redirect('/app-settings');
        }
    }
}

module.exports = new AppSettingsController();
