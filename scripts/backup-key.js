'use strict';

/**
 * backup-key.js — the backup encryption key and the encrypted-backup tools (SA-39).
 * See docs/BACKUPS.md for when to use which command.
 *
 *   node scripts/backup-key.js init
 *       Create the backup master key if absent (Windows: DPAPI keyring under
 *       %ProgramData%\IDevelop\keys). Idempotent. Prints JSON {keyId, protection, created}.
 *   node scripts/backup-key.js status
 *       JSON {keyId, protection, exportedAt, retiredKeys}. Read-only.
 *   node scripts/backup-key.js export [--out <file>] [--force]
 *       The recovery copy of the current key. Windows (DPAPI): ONCE; a second
 *       export needs --force and is recorded. Without --out the line goes to
 *       stdout. Keep it offline: restoring on ANOTHER server needs it.
 *   node scripts/backup-key.js import --in <file> [--current]
 *       Add a recovery copy to this server's keyring (reads the file, or stdin
 *       with --in -; never from the command line).
 *   node scripts/backup-key.js import-app-key --in <file>
 *       Add the backup key derived from a PREVIOUS APP_KEY (file, or stdin with
 *       --in -): the way back when APP_KEY was changed by hand, or the keyring
 *       was lost.
 *   node scripts/backup-key.js encrypt --in <plain> --out <file.enc> [--kind k] [--remove-plain]
 *       Encrypt an existing dump (+ manifest). --remove-plain deletes the clear
 *       file only after the encrypted copy verified.
 *   node scripts/backup-key.js verify --in <file> [--pg-restore <path>]
 *       Manifest + full authenticated decryption (+ pg_restore --list when
 *       given). Exit 0 = restorable, 1 = refuse.
 *   node scripts/backup-key.js pipe --in <file> --run <exe> [args...]   ("--" also accepted)
 *       Verify, then run <exe> with the backup's PLAINTEXT on stdin (e.g.
 *       pg_restore -d scratch ...). Nothing is decrypted to disk. Exit code =
 *       the tool's.
 *   node scripts/backup-key.js decrypt --in <file.enc> --out <plain>
 *       Last resort (manual restore elsewhere): writes the plaintext,
 *       ACL-restricted. Prefer `pipe`.
 */

const fs = require('fs');
const path = require('path');

try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
} catch (_) {
    /* dotenv optional */
}

const Crypto = require('../src/services/BackupCryptoService');

function parseArgs(argv) {
    const out = { _: [], flags: new Map(), rest: [] };
    // "--" or "--run" separates the tool to run (Windows PowerShell 5.1 can
    // swallow a bare "--" on a native command line, so scripts use --run).
    let dd = argv.indexOf('--');
    const run = argv.indexOf('--run');
    if (run >= 0 && (dd < 0 || run < dd)) dd = run;
    const head = dd >= 0 ? argv.slice(0, dd) : argv;
    out.rest = dd >= 0 ? argv.slice(dd + 1) : [];
    for (let i = 0; i < head.length; i++) {
        const a = head[i];
        if (a.startsWith('--')) {
            const k = a.slice(2);
            const next = head[i + 1];
            if (next !== undefined && (next === '-' || !next.startsWith('--'))) {
                out.flags.set(k, next);
                i++;
            } else out.flags.set(k, true);
        } else out._.push(a);
    }
    return out;
}

function print(obj) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(msg, code = 1) {
    process.stderr.write(`backup-key: ${msg}\n`);
    return code;
}

function readStdin() {
    return new Promise((resolve) => {
        let s = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => (s += d));
        process.stdin.on('end', () => resolve(s));
    });
}

/** --in <file> or --in - (stdin). A secret is never read from the command line itself. */
async function readInput(flags) {
    const src = flags.get('in');
    if (typeof src !== 'string') return null;
    return src === '-' ? readStdin() : fs.readFileSync(src, 'utf8');
}

async function main(argv = process.argv.slice(2)) {
    const { _, flags, rest } = parseArgs(argv);
    const str = (k) => (typeof flags.get(k) === 'string' ? flags.get(k) : null);
    const cmd = _[0];
    switch (cmd) {
        case 'init': {
            const before = Crypto.keyStatus();
            const k = await Crypto.getCurrentKey();
            print({
                keyId: k.keyId,
                protection: k.protection,
                keyring: k.keyring,
                created: !before.keyId || before.keyId !== k.keyId,
            });
            if (k.protection !== Crypto.PROT_DPAPI)
                process.stderr.write(
                    'backup-key: WARNING: the key is derived from APP_KEY. Keep an offline copy of APP_KEY, ' +
                        'and change APP_KEY only with scripts/rotate-app-key.js.\n'
                );
            return 0;
        }
        case 'status':
            print(Crypto.keyStatus());
            return 0;
        case 'export': {
            let r;
            try {
                r = await Crypto.exportRecovery({ force: !!flags.get('force') });
            } catch (e) {
                return fail(e.message, e.code === 'ALREADY_EXPORTED' ? 3 : 1);
            }
            const out = str('out');
            if (out) {
                fs.writeFileSync(out, r.recovery + '\n', {
                    encoding: 'utf8',
                    mode: 0o600,
                    flag: 'wx',
                });
                await Crypto.restrictAcl(out);
                print({ keyId: r.keyId, exportedAt: r.exportedAt, out });
            } else {
                process.stdout.write(r.recovery + '\n');
            }
            if (r.note) process.stderr.write(`backup-key: ${r.note}\n`);
            process.stderr.write(
                'backup-key: store this recovery key OFFLINE (vault, sealed envelope), apart from the backups. ' +
                    'Without it, backups cannot be restored on another server.\n'
            );
            return 0;
        }
        case 'import': {
            const text = await readInput(flags);
            if (text == null) return fail('import needs --in <file> (or --in - for stdin)');
            try {
                print(await Crypto.importRecovery(text, { makeCurrent: !!flags.get('current') }));
            } catch (e) {
                return fail(e.message);
            }
            return 0;
        }
        case 'import-app-key': {
            const text = await readInput(flags);
            if (text == null) return fail('import-app-key needs --in <file> (or --in - for stdin)');
            try {
                print(await Crypto.importPreviousAppKey(text));
            } catch (e) {
                return fail(e.message);
            }
            return 0;
        }
        case 'encrypt': {
            const inFile = str('in');
            const outFile = str('out');
            if (!inFile || !outFile) return fail('encrypt needs --in <plain> --out <file.enc>');
            const r = await Crypto.encryptFile(inFile, outFile, { kind: str('kind') || 'backup' });
            const gate = await Crypto.verifyDecrypt(outFile);
            if (!gate.ok) return fail(`encrypted copy did not verify: ${gate.reason}`);
            await Crypto.restrictAcl(outFile);
            await Crypto.restrictAcl(Crypto.manifestPath(outFile));
            if (flags.get('remove-plain')) fs.unlinkSync(inFile);
            print({
                file: r.file,
                sizeBytes: r.sizeBytes,
                sha256: r.sha256,
                keyId: r.keyId,
                removedPlain: !!flags.get('remove-plain'),
            });
            return 0;
        }
        case 'verify': {
            const inFile = str('in');
            if (!inFile) return fail('verify needs --in <file>');
            let gate;
            try {
                gate = await Crypto.assertRestorable(inFile);
            } catch (e) {
                return fail(e.message);
            }
            const out = {
                file: inFile,
                encrypted: gate.encrypted,
                warning: gate.warning,
                pgRestoreList: null,
            };
            const pgRestore = str('pg-restore');
            if (pgRestore) {
                const r = await Crypto.spawnWithPlainStdin(pgRestore, ['--list'], inFile);
                const entries = (/TOC Entries:\s*(\d+)/.exec(r.stdout) || [])[1];
                out.pgRestoreList =
                    r.code === 0 && entries && !r.streamError
                        ? `ok (${entries} TOC entries)`
                        : `failed: ${r.stderr.trim().slice(0, 300)}`;
                if (!/^ok/.test(out.pgRestoreList)) {
                    print(out);
                    return 1;
                }
            }
            print(out);
            return 0;
        }
        case 'pipe': {
            const inFile = str('in');
            if (!inFile || !rest.length)
                return fail('pipe needs --in <file> --run <exe> [args...]');
            let gate;
            try {
                gate = await Crypto.assertRestorable(inFile);
            } catch (e) {
                return fail(e.message);
            }
            if (gate.warning) process.stderr.write(`backup-key: WARNING: ${gate.warning}\n`);
            const r = await Crypto.spawnWithPlainStdin(rest[0], rest.slice(1), inFile);
            process.stdout.write(r.stdout);
            process.stderr.write(r.stderr);
            if (r.streamError)
                return fail(`decryption failed mid-stream: ${r.streamError.message}`);
            return r.code;
        }
        case 'decrypt': {
            const inFile = str('in');
            const outFile = str('out');
            if (!inFile || !outFile) return fail('decrypt needs --in <file.enc> --out <plain>');
            try {
                await Crypto.assertRestorable(inFile);
            } catch (e) {
                return fail(e.message);
            }
            await new Promise((resolve, reject) => {
                const w = fs.createWriteStream(outFile, { mode: 0o600, flags: 'wx' });
                require('stream').pipeline(Crypto.openPlainStream(inFile), w, (e) =>
                    e ? reject(e) : resolve()
                );
            });
            await Crypto.restrictAcl(outFile);
            process.stderr.write(
                `backup-key: WARNING: ${outFile} is a CLEAR copy of the database. Delete it after use.\n`
            );
            return 0;
        }
        default:
            process.stderr.write(
                'usage: backup-key.js init | status | export [--out f] [--force] | import --in f [--current] |\n' +
                    '       import-app-key --in f | encrypt --in plain --out f.enc [--remove-plain] |\n' +
                    '       verify --in f [--pg-restore exe] | pipe --in f --run exe args... | decrypt --in f.enc --out plain\n'
            );
            return 2;
    }
}

if (require.main === module) {
    main().then(
        (code) => process.exit(code),
        (e) => {
            process.stderr.write(`backup-key: ${e.message}\n`);
            process.exit(1);
        }
    );
}

module.exports = { main, parseArgs };
