'use strict';

/**
 * backfill-access-profiles.js — propose (and, only after human review, apply) a
 * starting set of capabilities for the admin accounts that have SCOPE but ZERO
 * capability.
 *
 * THE PROBLEM THIS SOLVES
 *   `admin_permissions` is empty on the live install. Every local admin and viewer
 *   has an assigned scope — a site, a department, a service — and not one of them
 *   holds a single permission slug. Granting access today means hand-ticking up to
 *   29 checkboxes per account, 32 times. That is why nobody has done it, and why
 *   the decision routes were quietly relying on role shape instead.
 *
 * THE SHAPE OF THE FIX
 *   A scope already encodes intent: someone scoped to a whole COUNTRY is doing a
 *   different job from someone scoped to a single SERVICE. So we read the scope
 *   shape, propose a named access profile, and — critically — stop there. The
 *   script's DEFAULT and only unattended behaviour is to write a CSV proposal for
 *   a human to review. Access is never granted as a side effect of running it.
 *
 * SAFETY CONTRACT
 *   - Dry run by default. No writes of any kind without `--apply`.
 *   - `--apply` additionally requires `--confirm` AND an existing proposal CSV at
 *     `--out`; it applies ONLY the (account, profile) pairs that appear in that
 *     reviewed file. A proposal that drifted since the review is skipped loudly.
 *   - Accounts that already hold permissions are never touched.
 *   - Grants are stamped with a 365-day expiry, so an unreviewed backfill decays
 *     instead of becoming permanent shadow access.
 *   - One `profile_applied` ledger event per account (AccessLedgerService).
 *
 * USAGE
 *   node scripts/backfill-access-profiles.js --help
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const db = require('../src/config/database');
const { isValidSlug, expandSlugs } = require('../src/config/permissions');
const { csvCell } = require('../src/utils/csvSafe');

const DEFAULT_OUT = './access-backfill-proposal.csv';

// Grants written by this backfill are time-bound so an unreviewed bundle decays
// instead of becoming permanent shadow access. 365 days is both the default and
// the CAP: when the shared catalogue declares a SHORTER `defaultDays` for a
// profile (governance_read is 180), the shorter window wins.
const EXPIRY_DAYS = 365;

// ---------------------------------------------------------------------------
// Access profiles: named bundles of catalogue slugs.
//
// These are PROVISIONING conveniences, not authority. Once applied, the grants
// they produce live in admin_permissions and can be edited or revoked
// independently; `admins.access_profile` only records what the account was
// provisioned FROM, for the drift report. No guard ever reads it.
//
// src/config/accessProfiles.js is the shared source of truth (the admin UI
// applies the same bundles). The table below is a last-resort fallback so this
// script still runs if that module is ever absent — it must never silently
// disagree with the shared catalogue, hence the loud banner on the fallback path.
// ---------------------------------------------------------------------------
const FALLBACK_PROFILES = {
    dept_lead: {
        key: 'dept_lead',
        labelFr: 'Chef de departement',
        labelEn: 'Department / service lead',
        defaultDays: 365,
        slugs: [
            'edit_employees',
            'manage_assessments',
            'approve_assessments',
            'view_domains_skills',
            'view_roles',
            'view_compliance',
        ],
    },
    site_hr: {
        key: 'site_hr',
        labelFr: 'Charge RH de site',
        labelEn: 'Site HR officer',
        defaultDays: 365,
        slugs: [
            'manage_employees',
            'manage_assessments',
            'approve_assessments',
            'manage_talent_reviews',
            'manage_onboarding',
            'view_domains_skills',
            'view_roles',
            'view_continuity',
            'view_compliance',
            'export_data',
        ],
    },
    country_hrbp: {
        key: 'country_hrbp',
        labelFr: 'Responsable RH pays (HRBP)',
        labelEn: 'Country HR business partner',
        defaultDays: 365,
        slugs: [
            'manage_employees',
            'manage_assessments',
            'approve_assessments',
            'manage_talent_reviews',
            'manage_onboarding',
            'manage_mobility',
            'manage_surveys',
            'arbitrate_disputes',
            'manage_succession',
            'view_domains_skills',
            'view_roles',
            'view_continuity',
            'view_compliance',
            'export_data',
        ],
    },
    governance_read: {
        key: 'governance_read',
        labelFr: 'Lecture gouvernance',
        labelEn: 'Governance read-only',
        defaultDays: 180,
        // Viewers can never hold a write slug (RBACService drops them), so this
        // profile is deliberately read-only end to end.
        slugs: [
            'view_domains_skills',
            'view_roles',
            'view_app_settings',
            'view_continuity',
            'view_compliance',
            'view_system_logs',
            'export_data',
        ],
    },
};

/** Normalise one catalogue entry (either shape) into what this script uses. */
function normaliseProfile(key, def) {
    const label = def && def.label;
    const slugs = (def && (def.slugs || def.permissions)) || [];
    if (!Array.isArray(slugs) || !slugs.length) return null;
    return {
        key,
        labelFr: (label && label.fr) || def.labelFr || key,
        labelEn: (label && label.en) || def.labelEn || key,
        defaultDays: Number(def.defaultDays) > 0 ? Number(def.defaultDays) : EXPIRY_DAYS,
        slugs,
    };
}

function loadProfiles() {
    try {
        // eslint-disable-next-line global-require
        const shared = require('../src/config/accessProfiles');
        const out = {};
        // Canonical shape: ACCESS_PROFILES is an ARRAY of {key, label:{fr,en}, slugs, ...}.
        const list = shared && (shared.ACCESS_PROFILES || shared.PROFILES);
        if (Array.isArray(list)) {
            for (const def of list) {
                const p = def && def.key ? normaliseProfile(def.key, def) : null;
                if (p) out[p.key] = p;
            }
        } else if (list && typeof list === 'object') {
            // Tolerate a keyed-map shape too, so a future refactor of the shared
            // module doesn't silently drop this script back to the fallback table.
            for (const [key, def] of Object.entries(list)) {
                const p = normaliseProfile(key, def);
                if (p) out[p.key] = p;
            }
        }
        if (Object.keys(out).length)
            return { profiles: out, source: 'src/config/accessProfiles.js', shared: true };
    } catch (_) {
        /* not present — fall through to the built-in table */
    }
    return {
        profiles: FALLBACK_PROFILES,
        source: 'BUILT-IN FALLBACK (src/config/accessProfiles.js not loadable)',
        shared: false,
    };
}

// ---------------------------------------------------------------------------
// Scope shape -> proposed profile.
// Broadest scope wins; a read-only viewer is always governance_read regardless
// of how wide their scope is, because a viewer cannot hold a write slug at all.
// ---------------------------------------------------------------------------
const SCOPE_RANK = { region: 5, country: 4, site: 3, department: 2, service: 1 };

function proposeProfile(row) {
    const types = row.scopeTypes || [];
    const noScope = types.length === 0;

    if (row.role === 'viewer') {
        // A viewer can never hold a write slug (RBACService drops them), so the
        // scope shape doesn't change WHAT they get — only how far it reaches.
        return {
            profile: 'governance_read',
            note:
                'role=viewer -> read-only profile (write slugs are inert for viewers)' +
                (noScope
                    ? '; NO SCOPE — this read access reaches nobody until a scope is assigned'
                    : ''),
        };
    }
    if (noScope) {
        return {
            profile: null,
            note: 'NO SCOPE — assign a scope before granting; capability without reach grants nothing',
        };
    }
    const broadest = types.slice().sort((a, b) => (SCOPE_RANK[b] || 0) - (SCOPE_RANK[a] || 0))[0];
    if (broadest === 'region') {
        return {
            profile: 'country_hrbp',
            note: 'region scope is broader than country — REVIEW: confirm this account should hold country-HRBP rights',
        };
    }
    if (broadest === 'country') return { profile: 'country_hrbp', note: '' };
    if (broadest === 'site') return { profile: 'site_hr', note: '' };
    if (broadest === 'department' || broadest === 'service')
        return { profile: 'dept_lead', note: '' };
    return { profile: null, note: `unrecognised scope type "${broadest}"` };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const args = { apply: false, confirm: false, help: false, out: DEFAULT_OUT, actor: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') args.help = true;
        else if (a === '--apply') args.apply = true;
        else if (a === '--confirm') args.confirm = true;
        else if (a === '--out') args.out = argv[++i];
        else if (a.startsWith('--out=')) args.out = a.slice(6);
        else if (a === '--actor') args.actor = argv[++i];
        else if (a.startsWith('--actor=')) args.actor = a.slice(8);
        else {
            console.error(`Unknown argument: ${a}\nRun with --help.`);
            process.exit(2);
        }
    }
    if (!args.out) args.out = DEFAULT_OUT;
    return args;
}

function printHelp() {
    const { profiles, source } = loadProfiles();
    console.log(`
backfill-access-profiles.js — propose access profiles for powerless admin accounts

  Every active non-superadmin admin has a SCOPE but (on the live install) zero
  permission slugs. This reads the scope shape, proposes a named access profile,
  and writes a CSV for a human to review. It grants NOTHING unless you explicitly
  say so twice.

USAGE
  node scripts/backfill-access-profiles.js [--out <file>]
      DRY RUN (the default). Writes the proposal CSV. No database writes.

  node scripts/backfill-access-profiles.js --apply --confirm [--out <file>] [--actor <id|username>]
      Applies the proposal. Refused unless the CSV at --out already exists — and
      only the (username, profile) pairs present in that reviewed file are applied.

OPTIONS
  --out <file>       Proposal CSV path (default: ${DEFAULT_OUT})
  --apply            Write the grants. Requires --confirm and an existing --out CSV.
  --confirm          Second, explicit acknowledgement. Required with --apply.
  --actor <id|name>  Admin id or username to attribute the change to in the
                     access ledger and audit log. Default: unattributed (system).
  --help, -h         This text.

WHAT --apply DOES, PER ACCOUNT
  - grants the profile's slugs (catalogue-validated) via AdminPermissionModel
  - stamps a ${EXPIRY_DAYS}-day expiry so an unreviewed backfill decays instead of
    becoming permanent shadow access (a profile declaring a SHORTER window keeps it)
  - stamps admins.access_profile (REPORTING/DRIFT ONLY — never read by a guard)
  - records exactly one 'profile_applied' event in the access ledger
  - SKIPS any account that already holds permissions

PROFILES (source: ${source})
${Object.values(profiles)
    .map(
        (p) =>
            `  ${p.key.padEnd(16)} ${String(p.slugs.length).padStart(2)} slugs, ${String(Math.min(EXPIRY_DAYS, p.defaultDays)).padStart(3)}d — ${p.labelEn}`
    )
    .join('\n')}
  (only the four below are proposed by scope shape; the rest are assigned by hand in the UI)

SCOPE -> PROFILE
  role = viewer            -> governance_read   (always; viewers hold no write slug)
  region / country scope   -> country_hrbp
  site scope               -> site_hr
  department / service     -> dept_lead
  no scope                 -> nothing proposed
`);
}

// ---------------------------------------------------------------------------
// Read the current access picture in one query.
// ---------------------------------------------------------------------------
async function loadAccounts() {
    const rows = await db.all(`
        SELECT a.id,
               a.username,
               a.role,
               a.is_active,
               a.access_profile,
               (SELECT COUNT(*) FROM admin_permissions ap
                  WHERE ap.admin_id = a.id
                    AND (ap.expires_at IS NULL OR ap.expires_at > now())) AS perm_count,
               (SELECT string_agg(DISTINCT acs.scope_type::text, ',' ORDER BY acs.scope_type::text)
                  FROM admin_scopes acs WHERE acs.admin_id = a.id) AS scope_types,
               (SELECT string_agg(DISTINCT COALESCE(s.name, d.name, sv.name, c.name, r.name), ' | ')
                  FROM admin_scopes acs
                  LEFT JOIN sites       s  ON acs.scope_type = 'site'       AND acs.site_id       = s.id
                  LEFT JOIN departments d  ON acs.scope_type = 'department' AND acs.department_id = d.id
                  LEFT JOIN services    sv ON acs.scope_type = 'service'    AND acs.service_id    = sv.id
                  LEFT JOIN countries   c  ON acs.scope_type = 'country'    AND acs.country_id    = c.id
                  LEFT JOIN regions     r  ON acs.scope_type = 'region'     AND acs.region_id     = r.id
                 WHERE acs.admin_id = a.id) AS scope_summary
          FROM admins a
         WHERE a.is_active = true
           AND a.role <> 'superadmin'
         ORDER BY a.role, a.username
    `);

    return rows.map((r) => ({
        id: Number(r.id),
        username: r.username,
        role: r.role,
        accessProfile: r.accessProfile || null,
        permCount: Number(r.permCount || 0),
        scopeTypes: r.scopeTypes ? String(r.scopeTypes).split(',').filter(Boolean) : [],
        scopeSummary: r.scopeSummary || '',
    }));
}

function buildProposals(accounts, profiles) {
    return accounts.map((a) => {
        const { profile, note } = proposeProfile(a);
        const def = profile ? profiles[profile] : null;
        const notes = [note];

        if (profile && !def)
            notes.push(
                `profile "${profile}" is not in the loaded catalogue — nothing will be granted`
            );

        // Validate against the live permission catalogue AND expand implications,
        // so the slug count in the CSV is exactly what gets written.
        const slugs = def ? expandSlugs((def.slugs || []).filter(isValidSlug)) : [];
        const unknown = def ? (def.slugs || []).filter((s) => !isValidSlug(s)) : [];
        if (unknown.length) notes.push(`NOT IN CATALOGUE (ignored): ${unknown.join(' ')}`);

        // 365 days by default; a profile that declares a SHORTER window keeps it.
        const expiryDays = def
            ? Math.min(EXPIRY_DAYS, def.defaultDays || EXPIRY_DAYS)
            : EXPIRY_DAYS;

        return {
            ...a,
            profile: def ? profile : null,
            profileLabelFr: def ? def.labelFr : '',
            slugs,
            expiryDays,
            notes: notes.filter(Boolean).join('; '),
        };
    });
}

// ---------------------------------------------------------------------------
// CSV write / read. UTF-8 BOM + `sep=,` so French Excel opens it correctly
// (same convention as the report exports), and every cell is formula-neutralised.
// ---------------------------------------------------------------------------
const CSV_HEADER = [
    // The six columns a reviewer reads first, in that order...
    'username',
    'role',
    'current_scope',
    'current_perm_count',
    'proposed_profile',
    'slug_count',
    // ...then the detail they need to judge it.
    'proposed_profile_fr',
    'expiry_days',
    'admin_id',
    'scope_types',
    'proposed_slugs',
    'notes',
];

function toCsv(proposals) {
    const lines = [CSV_HEADER.map(csvCell).join(',')];
    for (const p of proposals) {
        lines.push(
            [
                p.username,
                p.role,
                p.scopeSummary || '(none)',
                p.permCount,
                p.profile || '(none proposed)',
                p.slugs.length,
                p.profileLabelFr || '',
                p.profile ? p.expiryDays : '',
                p.id,
                p.scopeTypes.join(' '),
                p.slugs.join(' '),
                p.notes || '',
            ]
                .map(csvCell)
                .join(',')
        );
    }
    // U+FEFF (BOM) + `sep=,` hint: French Excel then renders accents correctly
    // and parses the comma delimiter instead of collapsing every row into one cell.
    return '\uFEFF' + 'sep=,\r\n' + lines.join('\r\n') + '\r\n';
}

/** Minimal RFC-4180 reader — enough to read back a file we wrote (and one a
 *  reviewer edited in Excel). Skips the BOM and the `sep=,` hint line. */
function parseCsv(text) {
    let s = text.replace(/^\uFEFF/, '');
    if (/^sep=.\r?\n/i.test(s)) s = s.replace(/^sep=.\r?\n/i, '');

    const rows = [];
    let row = [];
    let cell = '';
    let inQ = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inQ) {
            if (ch === '"') {
                if (s[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else inQ = false;
            } else cell += ch;
            continue;
        }
        if (ch === '"') {
            inQ = true;
            continue;
        }
        if (ch === ',') {
            row.push(cell);
            cell = '';
            continue;
        }
        if (ch === '\r') continue;
        if (ch === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            continue;
        }
        cell += ch;
    }
    if (cell !== '' || row.length) {
        row.push(cell);
        rows.push(row);
    }
    if (!rows.length) return [];

    const header = rows[0].map((h) => h.trim());
    return rows
        .slice(1)
        .filter((r) => r.some((c) => c !== ''))
        .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
async function resolveActor(actorArg) {
    if (!actorArg) return null;
    const byId = /^\d+$/.test(String(actorArg))
        ? await db.get('SELECT id, username FROM admins WHERE id = ?', [Number(actorArg)])
        : await db.get('SELECT id, username FROM admins WHERE username = ?', [String(actorArg)]);
    if (!byId) {
        // Throw rather than process.exit so the caller's `finally` still closes
        // the pool — and so an unattributable change is never written.
        throw new Error(
            `--actor "${actorArg}" does not match any admin. ` +
                'Aborting rather than mis-attributing the change.'
        );
    }
    return byId;
}

/** Undo csvSafe's formula-injection guard so a username like `-ops` compares equal. */
function unNeutralize(s) {
    return String(s == null ? '' : s).replace(/^'(?=[=+\-@\t\r])/, '');
}

async function apply(proposals, reviewed, actor) {
    // The reviewed CSV is the authority on WHAT may be applied. A live proposal
    // that isn't in it (new account, changed scope, edited row) is skipped.
    // Keyed on admin_id — a numeric column csvSafe never rewrites — with the
    // username checked as well, so a rename since the review also invalidates.
    const approved = new Map();
    for (const r of reviewed) {
        const id = Number(r.admin_id);
        const p = r.proposed_profile;
        if (!Number.isFinite(id) || !p || p === '(none proposed)') continue;
        approved.set(id, { profile: p, username: unNeutralize(r.username) });
    }

    const AdminPermissionModel = require('../src/models/AdminPermissionModel');
    const AccessLedgerService = require('../src/services/AccessLedgerService');

    const result = { applied: [], skipped: [], failed: [] };

    for (const p of proposals) {
        if (!p.profile || !p.slugs.length) {
            result.skipped.push({ username: p.username, why: 'nothing proposed' });
            continue;
        }
        if (p.permCount > 0) {
            result.skipped.push({
                username: p.username,
                why: `already holds ${p.permCount} permission(s) — not overwriting`,
            });
            continue;
        }
        const ok = approved.get(p.id);
        if (!ok) {
            result.skipped.push({
                username: p.username,
                why: 'not in the reviewed CSV — re-run the dry run and review again',
            });
            continue;
        }
        if (ok.username !== p.username) {
            result.skipped.push({
                username: p.username,
                why: `reviewed as "${ok.username}" — the account was renamed since the review`,
            });
            continue;
        }
        if (ok.profile !== p.profile) {
            result.skipped.push({
                username: p.username,
                why: `reviewed as "${ok.profile}" but now proposes "${p.profile}" — scope changed since review`,
            });
            continue;
        }

        const expiresAt = new Date(Date.now() + p.expiryDays * 24 * 60 * 60 * 1000);
        try {
            // `silent` suppresses the per-slug grant events: this backfill records
            // exactly ONE ledger event per account, as a profile application.
            await AdminPermissionModel.setForAdmin(p.id, p.slugs, expiresAt, { silent: true });

            // Reporting/drift only — never read by an authorization guard.
            await db.run('UPDATE admins SET access_profile = ?, updated_at = now() WHERE id = ?', [
                p.profile,
                p.id,
            ]);

            await AccessLedgerService.record({
                adminId: p.id,
                changeType: 'profile_applied',
                profileKey: p.profile,
                effectiveTo: expiresAt,
                actorAdminId: actor ? actor.id : null,
                reason:
                    'Reviewed backfill of powerless accounts (scripts/backfill-access-profiles.js): ' +
                    `${p.slugs.length} slug(s) from profile "${p.profile}", scope=${p.scopeTypes.join('+') || 'none'}, ` +
                    `expires in ${p.expiryDays} days`,
            });

            result.applied.push({
                username: p.username,
                profile: p.profile,
                slugs: p.slugs.length,
                days: p.expiryDays,
            });
        } catch (e) {
            result.failed.push({ username: p.username, error: (e && e.message) || String(e) });
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
function printProposalSummary(proposals, outPath) {
    const byProfile = {};
    for (const p of proposals) {
        const k = p.profile || '(none proposed)';
        byProfile[k] = (byProfile[k] || 0) + 1;
    }
    const powerless = proposals.filter((p) => p.permCount === 0);
    const noScope = proposals.filter((p) => p.scopeTypes.length === 0);

    console.log('\n  Accounts examined (active, non-superadmin): ' + proposals.length);
    console.log('  Holding ZERO permissions right now:         ' + powerless.length);
    console.log(
        '  Holding some permissions already:           ' + (proposals.length - powerless.length)
    );
    console.log('  With no scope at all (reach is empty):      ' + noScope.length);
    console.log('\n  Proposed profiles:');
    for (const [k, n] of Object.entries(byProfile).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(n).padStart(4)}  ${k}`);
    }
    console.log(`\n  Proposal written to: ${outPath}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    const outPath = path.resolve(process.cwd(), args.out);

    // Refuse an --apply that hasn't been through a review, BEFORE touching the DB.
    if (args.apply) {
        if (!args.confirm) {
            console.error(
                '\nREFUSED: --apply also requires --confirm.\n' +
                    'This writes real permission grants to real accounts. Run the dry run first,\n' +
                    'have someone read the CSV, then re-run with --apply --confirm.\n'
            );
            process.exit(1);
        }
        if (!fs.existsSync(outPath)) {
            console.error(
                `\nREFUSED: no proposal CSV at ${outPath}.\n` +
                    'Generate and review one first:\n' +
                    `  node scripts/backfill-access-profiles.js --out ${args.out}\n`
            );
            process.exit(1);
        }
    }

    const { profiles, source } = loadProfiles();

    await db.connect();
    try {
        const actor = args.apply ? await resolveActor(args.actor) : null;
        const accounts = await loadAccounts();
        const proposals = buildProposals(accounts, profiles);

        if (!args.apply) {
            fs.writeFileSync(outPath, toCsv(proposals), 'utf8');
            console.log('\n=== DRY RUN — no database writes ===');
            console.log(`  Profile source: ${source}`);
            printProposalSummary(proposals, outPath);
            console.log(
                '\n  NEXT: have a human read that CSV. Then, to apply exactly what was reviewed:'
            );
            console.log(
                `    node scripts/backfill-access-profiles.js --apply --confirm --out ${args.out} --actor <your-admin-username>\n`
            );
            return;
        }

        const reviewed = parseCsv(fs.readFileSync(outPath, 'utf8'));
        console.log('\n=== APPLYING reviewed proposal ===');
        console.log(`  Profile source: ${source}`);
        console.log(`  Reviewed file:  ${outPath} (${reviewed.length} row(s))`);
        console.log(
            `  Attributed to:  ${actor ? `${actor.username} (#${actor.id})` : 'system (unattributed — pass --actor next time)'}`
        );
        console.log(`  Grant expiry:   ${EXPIRY_DAYS} days\n`);

        const res = await apply(proposals, reviewed, actor);

        console.log(`  Applied: ${res.applied.length}`);
        for (const a of res.applied)
            console.log(`    + ${a.username.padEnd(24)} ${a.profile} (${a.slugs} slugs)`);
        console.log(`\n  Skipped: ${res.skipped.length}`);
        for (const s of res.skipped) console.log(`    - ${s.username.padEnd(24)} ${s.why}`);
        if (res.failed.length) {
            console.log(`\n  FAILED: ${res.failed.length}`);
            for (const f of res.failed) console.log(`    ! ${f.username.padEnd(24)} ${f.error}`);
        }
        console.log(
            '\n  Every applied account now has one profile_applied event in admin_access_events'
        );
        console.log('  and a matching entry in the hash-chained audit log.\n');
        if (res.failed.length) process.exitCode = 1;
    } finally {
        await db.close();
    }
}

// Only run when invoked directly — requiring this file (e.g. from a test that
// exercises the pure helpers) must never connect to the database or write grants.
if (require.main === module) {
    main().catch((e) => {
        console.error('backfill-access-profiles failed:', (e && e.stack) || e);
        process.exit(1);
    });
}

// Pure helpers, exported for testing. `apply` and `main` are deliberately NOT
// exported: the only way to grant access with this file is to run it as a script
// with --apply --confirm and a reviewed CSV.
module.exports = {
    parseArgs,
    proposeProfile,
    buildProposals,
    loadProfiles,
    toCsv,
    parseCsv,
    CSV_HEADER,
    EXPIRY_DAYS,
    FALLBACK_PROFILES,
};
