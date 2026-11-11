'use strict';
/**
 * The upload guard's file-name rule and antivirus gate (middleware/uploadGuard).
 *
 *  - a client file name carrying a folder path, a control character, nothing
 *    but dots or more than 200 characters is refused (400 UPLOAD_BAD_NAME),
 *    before any scan, and the temp file is removed;
 *  - every accepted upload is scanned before the route sees it:
 *      threat            -> 422 UPLOAD_REJECTED_AV, temp file deleted, audited;
 *      no verdict and a scan is required (requireMalwareScan)
 *                        -> 503 UPLOAD_AV_UNAVAILABLE (fail-closed), audited;
 *      no verdict otherwise
 *                        -> accepted, file.avScan.av = 'not_scanned', one WARN
 *                           per process, an UPLOAD_NOT_SCANNED row per upload;
 *  - App Setting uploadAvScan off -> no scan at all;
 *  - refusal messages come from the locale catalogue (FR and EN);
 *  - MalwareScanService.scanAndRecord records the gate's verdict instead of
 *    scanning the same file twice.
 * The scanner, settings and audit are replaced through uploadGuard's test
 * seams; a live engine run happens only where an engine answers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/config/database', () => ({
    run: jest.fn().mockResolvedValue({ changes: 1 }),
    get: jest.fn().mockResolvedValue(null),
    all: jest.fn().mockResolvedValue([]),
}));
jest.setTimeout(60000);

const ug = require('../../src/middleware/uploadGuard');
const { checkFile } = require('../../src/utils/fileSignature');

// Inside os.tmpdir(): one of the upload temp directories (uploadTempPath).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-av-gate-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const real = { ...ug.__test.deps };

const LOCALES = path.join(__dirname, '..', '..', 'locales');
const catalogue = (lng) =>
    JSON.parse(fs.readFileSync(path.join(LOCALES, lng, 'compliance.json'), 'utf8'));

function tempFile(name, buf) {
    const p = path.join(TMP, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(p, buf);
    return { path: p, originalname: name, fieldname: 'file', size: buf.length };
}

/** A stand-in for a multer middleware that "received" `file`. */
const fakeMulter = (file) => (req, res, cb) => {
    req.file = file;
    cb();
};

/** Run a guarded middleware with a request translated from the real catalogue. */
function run(mw, { lng = 'en' } = {}) {
    const cat = catalogue(lng);
    return new Promise((resolve) => {
        const req = {
            headers: { 'x-csrf-token': 'x' },
            method: 'POST',
            originalUrl: '/probe?x=1',
            ip: '127.0.0.1',
            user: { id: 7, userType: 'employee' },
            get: () => null,
            t: (k, o) => cat[String(k).split(':').pop()] || (o && o.defaultValue) || k,
        };
        const res = {
            statusCode: 200,
            status(c) {
                this.statusCode = c;
                return this;
            },
            json(b) {
                resolve({ req, status: this.statusCode, body: b });
            },
        };
        mw(req, res, (err) => resolve({ req, status: err ? err.status : 'next', err }));
    });
}

const settle = () => new Promise((s) => setTimeout(s, 50));
let audit;

beforeEach(() => {
    audit = jest.fn().mockResolvedValue();
    ug.__test.deps.audit = audit;
    ug.__test.deps.enabled = jest.fn().mockResolvedValue(true);
    ug.__test.deps.requireScan = jest.fn().mockResolvedValue(false);
    ug.__test.deps.scanFile = jest.fn().mockResolvedValue({ verdict: 'clean', engine: 'clamd' });
    ug.__test.deps.scanBuffer = jest.fn().mockResolvedValue({ verdict: 'clean', engine: 'clamd' });
    ug.__test.resetWarn();
});
afterAll(() => {
    Object.assign(ug.__test.deps, real);
    fs.rmSync(TMP, { recursive: true, force: true });
});

describe('client file names', () => {
    test.each([
        ['../../evil.png', true],
        ['C:\\Users\\someone\\evil.png', true],
        ['folder/evil.png', true],
        ['a\u0000.png', true],
        ['bad\nname.png', true],
        ['tab\tname.png', true],
        ['del\u007fname.png', true],
        ['..', true],
        ['.', true],
        [' . . ', true],
        ['x'.repeat(197) + '.png', true],
        ['', true],
        [null, true],
        [undefined, true],
        ['x'.repeat(196) + '.png', false],
        ['Rapport annuel — été 2026.pdf', false],
        ['.hidden.png', false],
        ['logo.png', false],
    ])('%j refused=%s', (name, refused) => {
        expect(ug.badName(name)).toBe(refused);
    });

    test('a name with a folder path is refused (400) before any scan and its temp file removed', async () => {
        const f = tempFile('..\\..\\evil.png', PNG);
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['png'] }));
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('UPLOAD_BAD_NAME');
        expect(r.body.error).toBe(catalogue('en').upload_err_bad_name);
        await settle();
        expect(fs.existsSync(f.path)).toBe(false);
        expect(ug.__test.deps.scanFile).not.toHaveBeenCalled();
    });

    test('the French catalogue gives the French message', async () => {
        const f = tempFile('dir/evil.png', PNG);
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['png'] }), { lng: 'fr' });
        expect(r.body.error).toBe(catalogue('fr').upload_err_bad_name);
    });
});

describe('content check (extension and declared type are not trusted)', () => {
    test('an executable renamed .png is refused', async () => {
        const f = tempFile('photo.png', Buffer.from('MZ\x90\x00\x03\x00\x00\x00 exe body'));
        expect((await checkFile(f, ['png'])).code).toBe('UPLOAD_TYPE_MISMATCH');
    });
    test('an HTML page named .pdf is refused, and .html is not an evidence type', async () => {
        const html = Buffer.from('<html><script>alert(1)</script></html>');
        expect((await checkFile(tempFile('a.pdf', html), ['pdf'])).code).toBe(
            'UPLOAD_TYPE_MISMATCH'
        );
        expect((await checkFile(tempFile('a.html', html), ['pdf', 'png'])).code).toBe(
            'UPLOAD_TYPE_NOT_ALLOWED'
        );
    });
    test('a refused content is never scanned', async () => {
        const f = tempFile('photo.png', Buffer.from('MZ\x90\x00 exe body'));
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['png'] }));
        expect(r.status).toBe(400);
        expect(ug.__test.deps.scanFile).not.toHaveBeenCalled();
    });
});

describe('antivirus gate', () => {
    test('clean: next(), the verdict rides on the file, nothing audited', async () => {
        const f = tempFile('ok.png', PNG);
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['png'] }));
        expect(r.status).toBe('next');
        expect(r.req.file.avScan).toEqual({ av: 'clean', engine: 'clamd' });
        expect(ug.__test.deps.scanFile).toHaveBeenCalledWith(path.resolve(f.path));
        expect(audit).not.toHaveBeenCalled();
    });

    test('threat: 422, temp file deleted, UPLOAD_REJECTED_AV audited without the client name', async () => {
        ug.__test.deps.scanFile.mockResolvedValue({
            verdict: 'infected',
            engine: 'clamd',
            signature: 'Test-Signature',
        });
        const f = tempFile('report-q3.pdf', PDF);
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['pdf'] }));
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('UPLOAD_REJECTED_AV');
        expect(r.body.error).toBe(catalogue('en').upload_err_av);
        await settle();
        expect(fs.existsSync(f.path)).toBe(false);
        expect(audit).toHaveBeenCalledTimes(1);
        const row = audit.mock.calls[0][0];
        expect(row).toMatchObject({
            action: 'UPLOAD_REJECTED_AV',
            actorRef: 'employee:7',
            entityType: 'upload',
            category: 'security',
            severity: 'warn',
            route: '/probe',
        });
        expect(JSON.parse(row.details)).toMatchObject({
            av: 'infected',
            engine: 'clamd',
            kind: 'pdf',
            signature: 'Test-Signature',
        });
        expect(row.details).not.toMatch(/report-q3/);
    });

    test('an admin actor is recorded as admin', async () => {
        ug.__test.deps.scanFile.mockResolvedValue({ verdict: 'infected', engine: 'clamd' });
        const f = tempFile('a.pdf', PDF);
        const mw = ug.guardUpload(fakeMulter(f), { kinds: ['pdf'] });
        await new Promise((resolve) => {
            const req = {
                headers: { accept: 'application/json', 'x-csrf-token': 'x' },
                user: { id: 3, userType: 'admin' },
                get: () => null,
            };
            const res = { status: () => res, json: resolve };
            mw(req, res, resolve);
        });
        expect(audit.mock.calls[0][0]).toMatchObject({ adminId: 3, actorRef: 'admin:3' });
    });

    test('the French catalogue gives the French threat message', async () => {
        ug.__test.deps.scanFile.mockResolvedValue({ verdict: 'infected', engine: 'defender' });
        const f = tempFile('cv.pdf', PDF);
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['pdf'] }), { lng: 'fr' });
        expect(r.body.error).toBe(catalogue('fr').upload_err_av);
    });

    test('file gone during the scan (a host real-time antivirus removed it): a threat', async () => {
        ug.__test.deps.scanFile.mockResolvedValue({ verdict: 'missing', engine: null });
        const f = tempFile('cv.pdf', PDF);
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['pdf'] }));
        expect(r.status).toBe(422);
        expect(JSON.parse(audit.mock.calls[0][0].details).engine).toBe('host');
    });

    test('no scanner, scan not required: accepted as not_scanned, one WARN, audited each time', async () => {
        ug.__test.deps.scanFile.mockResolvedValue({
            verdict: 'unscanned',
            engine: null,
            errors: ['clamd: connection refused'],
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        for (let i = 0; i < 2; i++) {
            const f = tempFile('ok.png', PNG);
            const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['png'] }));
            expect(r.status).toBe('next');
            expect(r.req.file.avScan).toEqual({ av: 'not_scanned', engine: null });
            expect(fs.existsSync(f.path)).toBe(true);
        }
        expect(warn.mock.calls.filter((c) => /upload-av/.test(c[0]))).toHaveLength(1);
        expect(ug.__test.warned()).toBe(true);
        expect(audit).toHaveBeenCalledTimes(2);
        expect(audit.mock.calls[0][0].action).toBe('UPLOAD_NOT_SCANNED');
        expect(JSON.parse(audit.mock.calls[0][0].details).av).toBe('not_scanned');
        // the scanner's error text is not written into the audit row
        expect(audit.mock.calls[0][0].details).not.toMatch(/refused/);
    });

    test('no scanner, scan REQUIRED (requireMalwareScan): refused 503, deleted, audited', async () => {
        ug.__test.deps.scanFile.mockResolvedValue({ verdict: 'unscanned', engine: null });
        ug.__test.deps.requireScan.mockResolvedValue(true);
        const f = tempFile('ok.png', PNG);
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['png'] }));
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('UPLOAD_AV_UNAVAILABLE');
        expect(r.body.error).toBe(catalogue('en').upload_err_av_unavailable);
        await settle();
        expect(fs.existsSync(f.path)).toBe(false);
        expect(audit.mock.calls[0][0].action).toBe('UPLOAD_REFUSED_NOT_SCANNED');
    });

    test('a scanner that throws is "no verdict": accepted unless a scan is required', async () => {
        ug.__test.deps.scanFile.mockRejectedValue(new Error('boom'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        let r = await run(ug.guardUpload(fakeMulter(tempFile('ok.png', PNG)), { kinds: ['png'] }));
        expect(r.status).toBe('next');
        expect(r.req.file.avScan.av).toBe('not_scanned');
        ug.__test.deps.requireScan.mockResolvedValue(true);
        r = await run(ug.guardUpload(fakeMulter(tempFile('ok.png', PNG)), { kinds: ['png'] }));
        expect(r.status).toBe(503);
    });

    test('requireScan failing reads as "not required" (the setting cannot be read)', async () => {
        ug.__test.deps.scanFile.mockResolvedValue({ verdict: 'unscanned', engine: null });
        ug.__test.deps.requireScan.mockRejectedValue(new Error('db down'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const r = await run(
            ug.guardUpload(fakeMulter(tempFile('ok.png', PNG)), { kinds: ['png'] })
        );
        expect(r.status).toBe('next');
    });

    test('uploadAvScan off: no scan at all, the file is marked off', async () => {
        ug.__test.deps.enabled.mockResolvedValue(false);
        const f = tempFile('ok.png', PNG);
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['png'] }));
        expect(r.status).toBe('next');
        expect(ug.__test.deps.scanFile).not.toHaveBeenCalled();
        expect(r.req.file.avScan.av).toBe('off');
    });

    test('the setting: absent or unreadable is ON, only an explicit false is off', async () => {
        const AppSettingsModel = require('../../src/models/AppSettingsModel');
        const spy = jest.spyOn(AppSettingsModel, 'getValue');
        try {
            for (const [v, on] of [
                [true, true],
                ['true', true],
                [null, true],
                [false, false],
                ['false', false],
                [0, false],
                ['0', false],
            ]) {
                spy.mockResolvedValueOnce(v);
                expect(await real.enabled()).toBe(on);
            }
            spy.mockRejectedValueOnce(new Error('db down'));
            expect(await real.enabled()).toBe(true);
            expect(spy).toHaveBeenCalledWith('uploadAvScan', true);
        } finally {
            spy.mockRestore();
        }
    });

    test('memory-storage file: scanned from its buffer', async () => {
        ug.__test.deps.scanBuffer = jest.fn(async (b) => {
            expect(b.equals(PNG)).toBe(true);
            return { verdict: 'infected', engine: 'clamd' };
        });
        const f = { buffer: PNG, originalname: 'ok.png', fieldname: 'file', size: PNG.length };
        const r = await run(ug.guardUpload(fakeMulter(f), { kinds: ['png'] }));
        expect(r.status).toBe(422);
        expect(ug.__test.deps.scanBuffer).toHaveBeenCalledTimes(1);
        expect(ug.__test.deps.scanFile).not.toHaveBeenCalled();
    });

    test('MalwareScanService.scanBuffer scans a private copy and removes it', async () => {
        const AV = require('../../src/services/MalwareScanService');
        const probes = () =>
            fs
                .readdirSync(os.tmpdir())
                .filter((n) => n.startsWith('app-av-probe-'))
                .sort();
        const before = probes();
        AV.__test.setExecFile((exe, args, opts, cb) =>
            cb(Object.assign(new Error('x'), { code: 5 }))
        );
        try {
            const r = await AV.scanBuffer(PNG);
            expect(['clean', 'infected', 'unscanned']).toContain(r.verdict);
            expect(await AV.scanBuffer('not a buffer')).toMatchObject({ verdict: 'missing' });
        } finally {
            AV.__test.setExecFile(null);
        }
        await settle();
        expect(probes()).toEqual(before);
    });

    test('a file outside every upload directory is never scanned by path (no verdict)', async () => {
        const avGate = ug.__test.avGate;
        const f = { path: '/etc/hostname', originalname: 'x.png', fieldname: 'file' };
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await avGate({}, [f])).toBeNull();
        expect(ug.__test.deps.scanFile).not.toHaveBeenCalled();
        expect(f.avScan.av).toBe('not_scanned');
    });

    test('several files: the first threat refuses the whole upload', async () => {
        ug.__test.deps.scanFile
            .mockResolvedValueOnce({ verdict: 'clean', engine: 'clamd' })
            .mockResolvedValueOnce({ verdict: 'infected', engine: 'clamd' });
        const a = tempFile('a.png', PNG);
        const b = tempFile('b.png', PNG);
        const multi = (req, res, cb) => {
            req.files = { logoFile: [a], faviconFile: [b] };
            cb();
        };
        const r = await run(ug.guardUpload(multi, { kinds: ['png'] }));
        expect(r.status).toBe(422);
        await settle();
        expect(fs.existsSync(a.path)).toBe(false);
        expect(fs.existsSync(b.path)).toBe(false);
    });
});

describe('MalwareScanService.scanAndRecord uses the gate verdict', () => {
    const AV = require('../../src/services/MalwareScanService');
    const db = require('../../src/config/database');

    test('gate clean: recorded clean with no second scan', async () => {
        const exec = jest.fn();
        AV.__test.setExecFile(exec);
        db.run.mockClear();
        try {
            const f = tempFile('ok.png', PNG);
            const out = await AV.scanAndRecord('assessment_evidence', 1, f.path, {
                av: 'clean',
                engine: 'clamd',
            });
            expect(out).toEqual({ avStatus: 'clean', engine: 'clamd' });
            expect(exec).not.toHaveBeenCalled();
            expect(db.run.mock.calls[0][0]).toMatch(/av_status = 'clean'/);
        } finally {
            AV.__test.setExecFile(null);
        }
    });

    test('gate not_scanned: recorded not_scanned when no scan is required', async () => {
        const prev = process.env.REQUIRE_MALWARE_SCAN;
        process.env.REQUIRE_MALWARE_SCAN = 'false';
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        db.run.mockClear();
        try {
            const f = tempFile('ok.png', PNG);
            const out = await AV.scanAndRecord('employee_certifications', 2, f.path, {
                av: 'not_scanned',
            });
            expect(out.avStatus).toBe('not_scanned');
            expect(db.run.mock.calls[0][0]).toMatch(/av_status = 'not_scanned'/);
        } finally {
            if (prev === undefined) delete process.env.REQUIRE_MALWARE_SCAN;
            else process.env.REQUIRE_MALWARE_SCAN = prev;
        }
    });
});

describe('live engine (runs only where clamd or Microsoft Defender answers)', () => {
    test('the antivirus test string is refused by the gate, or the not-scanned path applies', async () => {
        Object.assign(ug.__test.deps, { scanFile: real.scanFile });
        const AV = require('../../src/services/MalwareScanService');
        const engine = (await AV.detect({ force: true })).engine;
        // The industry-standard antivirus TEST string (harmless), assembled at run time.
        const sample = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
        const p = path.join(TMP, `av-sample-${process.pid}.txt`);
        try {
            fs.writeFileSync(p, sample);
        } catch (_) {
            /* a real-time host antivirus may refuse the write: still a detection */
        }
        const f = { path: p, originalname: 'sample.txt', fieldname: 'file', size: 68 };
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const r = await ug.__test.avGate({ method: 'POST' }, [f]);
        try {
            fs.unlinkSync(p);
        } catch (_) {
            /* already removed */
        }
        if (engine) expect(r).toEqual({ status: 422, code: 'UPLOAD_REJECTED_AV' });
        else {
            expect(r).toBeNull();
            expect(f.avScan.av).toBe('not_scanned');
        }
    });
});
