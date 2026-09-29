'use strict';

const fs = require('fs');
const SqlConsoleService = require('../services/SqlConsoleService');
const LogService = require('../services/LogService');
const { bc } = require('../utils/breadcrumbLabel');

// How much of a script the audit trail keeps verbatim. Long enough that ordinary
// statements are recorded whole; capped so one paste cannot bloat the audit table.
const AUDIT_SQL_MAX = 4000;

/**
 * Keep the SQL that was actually run. Whitespace is collapsed so a multi-line
 * script stays one readable audit line, and any truncation is stated explicitly —
 * an entry must never look complete when it is not.
 */
function truncateForAudit(sql) {
    const s = String(sql || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return '(empty)';
    return s.length <= AUDIT_SQL_MAX
        ? s
        : `${s.slice(0, AUDIT_SQL_MAX)} …[truncated, ${s.length} chars total]`;
}

/**
 * SqlConsoleController — the super-admin-only SQL toolbox.
 *   GET  /data-management/sql-console            → the page
 *   POST /data-management/sql-console/execute    → run a SQL script (dry-run capable)
 *   POST /data-management/sql-console/from-excel  → convert a full-system Excel to SQL
 *
 * Every route is additionally guarded by requireSuperAdmin at the router; each handler
 * re-checks the role defensively and audits what was run.
 */
class SqlConsoleController {
    _denied(req, res) {
        if (req.user && req.user.role === 'superadmin') return false;
        res.status(403).json({ success: false, error: 'Super administrator privileges required.' });
        return true;
    }

    async index(req, res) {
        if (!req.user || req.user.role !== 'superadmin') {
            req.flash(
                'error',
                req.t
                    ? req.t('flash:superadmin_required')
                    : 'Super administrator privileges required.'
            );
            return res.redirect('/data-management');
        }
        res.render('pages/data-management/sql-console', {
            title: req.t ? req.t('chrome:pt_sql_console') : 'SQL Console',
            csrfToken: res.locals.csrfToken || '',
            // translated crumbs, like every other visible string.
            breadcrumbs: [
                { label: bc(req, 'chrome:pt_bc_tools', 'Tools'), url: '/dashboard' },
                {
                    label: bc(req, 'chrome:pt_data_management', 'Data Management'),
                    url: '/data-management',
                },
                { label: bc(req, 'chrome:pt_sql_console', 'SQL Console') },
            ],
        });
    }

    async execute(req, res) {
        if (this._denied(req, res)) return;
        const sql = (req.body && req.body.sql) || '';
        // Omitting `dryRun` means "execute" (what the console's own UI relies on).
        // But once a client SENDS the field, any value that is not an explicit no
        // means SIMULATE. The old `String(x) === 'true'` did the reverse: a JSON
        // boolean `true` from a non-browser client, or 1, or "oui", all failed the
        // string comparison and so EXECUTED — a caller who believed they were
        // dry-running wrote to the database. On the most destructive tool in the
        // product an unrecognised value must fall on the safe side.
        const rawDry = req.body ? req.body.dryRun : undefined;
        const dryRun = !(
            rawDry === false ||
            rawDry === 'false' ||
            rawDry === 0 ||
            rawDry === '0' ||
            rawDry === undefined ||
            rawDry === null ||
            rawDry === ''
        );
        const actor = { adminId: req.user.id, ipAddress: req.ip, userAgent: req.get('user-agent') };
        try {
            const result = await SqlConsoleService.execute(sql, { dryRun, actor });

            await LogService.log({
                adminId: req.user.id,
                action: dryRun ? 'SQL_CONSOLE_DRYRUN' : 'SQL_CONSOLE_EXECUTE',
                entityType: 'database',
                // Record the SCRIPT, not its length. "superadmin executed 4 711
                // characters of SQL" is unauditable on the most destructive tool in
                // the product: nothing lets anyone reconstruct what was done to the
                // database. Long scripts are truncated with an explicit marker so
                // the entry stays readable and never silently implies it is whole.
                details:
                    `${dryRun ? 'Dry-run' : 'Executed'} SQL; ok=${result.ok}; mode=${result.mode}` +
                    `; sql=${truncateForAudit(sql)}` +
                    (result.restorePoint ? `; restorePoint=${result.restorePoint.name}` : '') +
                    (result.autoReverted ? '; AUTO-REVERTED' : '') +
                    (result.error
                        ? `; error=${result.error}`
                        : `; statements=${result.statements.length}`) +
                    (result.stripped && result.stripped.length
                        ? `; stripped=${result.stripped.join(',')}`
                        : ''),
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: result.ok, ...result });
        } catch (error) {
            console.error('SQL console execute error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async listRestorePoints(req, res) {
        if (this._denied(req, res)) return;
        try {
            res.json({ success: true, restorePoints: SqlConsoleService.listRestorePoints() });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async revertRestorePoint(req, res) {
        if (this._denied(req, res)) return;
        try {
            const out = await SqlConsoleService.revertRestorePoint(req.params.name, {
                actor: {
                    adminId: req.user.id,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                },
            });

            const ap = out.auditPreservation || {};
            await LogService.log({
                adminId: req.user.id,
                action: 'SQL_CONSOLE_REVERT',
                entityType: 'database',
                details:
                    `Reverted the database to restore point "${req.params.name}"` +
                    (out.warnings.length ? ` (${out.warnings.length} pg_restore warnings)` : '') +
                    `; append-only audit rows re-attached=${ap.reattached || 0}` +
                    (ap.unreattachable
                        ? `; NOT re-attached=${ap.unreattachable} (kept in "${ap.quarantineSchema}")`
                        : ''),
                severity: ap.unreattachable ? 'critical' : 'warn',
                category: 'security',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, ...out });
        } catch (error) {
            console.error('SQL console revert error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async fromExcel(req, res) {
        if (this._denied(req, res)) return;
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
        try {
            const sql = await SqlConsoleService.generateFromExcelFile(req.file.path);
            fs.unlink(req.file.path, () => {});

            await LogService.log({
                adminId: req.user.id,
                action: 'SQL_CONSOLE_FROM_EXCEL',
                entityType: 'database',
                details: `Generated SQL from Excel (${req.file.originalname})`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, sql });
        } catch (error) {
            if (req.file && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
            console.error('SQL console from-excel error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
}

module.exports = new SqlConsoleController();
