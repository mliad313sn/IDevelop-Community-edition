'use strict';
/**
 * Upload content checks (ASVS 12.2.1): what an uploaded file REALLY is (magic
 * bytes, OOXML content types, macro parts) and the zip-bomb guard. The ZIP
 * directory is read by importGuards.zipDirectory, the app's one ZIP reader.
 * Pure: no DB, no network.
 */
const zlib = require('zlib');
const ExcelJS = require('exceljs');
const { detectKind, inspectZip, checkFile } = require('../../src/utils/fileSignature');
const { readZipEntries } = require('../../src/utils/importGuards');

/** Minimal ZIP writer: entries [{ name, data, method (0|8), declared? }]. */
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const method = e.method === undefined ? 8 : e.method;
        const comp = method === 8 ? zlib.deflateRawSync(e.data) : e.data;
        const declared = e.declared === undefined ? e.data.length : e.declared;
        const crc = zlib.crc32 ? zlib.crc32(e.data) : 0;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0, 6);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt32LE(crc >>> 0, 14);
        lh.writeUInt32LE(comp.length, 18);
        lh.writeUInt32LE(declared, 22);
        lh.writeUInt16LE(name.length, 26);
        lh.writeUInt16LE(0, 28);
        locals.push(lh, name, comp);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(e.flags || 0, 8);
        ch.writeUInt16LE(method, 10);
        ch.writeUInt32LE(crc >>> 0, 16);
        ch.writeUInt32LE(comp.length, 20);
        ch.writeUInt32LE(declared, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(offset, 42);
        centrals.push(ch, name);
        offset += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

const CT_XLSX =
    '<?xml version="1.0"?><Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
const CT_DOCX =
    '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const CT_XLSM =
    '<?xml version="1.0"?><Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>';

const mem = (originalname, buffer) => ({ originalname, buffer });

describe('detectKind — magic bytes', () => {
    test.each([
        ['pdf', Buffer.from('%PDF-1.7\n...')],
        ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])],
        ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])],
        ['zip', makeZip([{ name: 'a.txt', data: Buffer.from('x') }])],
        ['cfb', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])],
        ['text', Buffer.from('id,name\n1,Ana\n')],
    ])('%s', (kind, buf) => expect(detectKind(buf)).toBe(kind));

    test('a Windows executable is never text', () => {
        expect(detectKind(Buffer.from('MZ\x90\x00\x03\x00\x00\x00'))).toBeNull();
    });
    test('binary with NUL bytes is not text', () => {
        expect(detectKind(Buffer.from([0x41, 0x00, 0x42, 0x13]))).toBeNull();
    });
});

describe('checkFile — extension must be proven by content', () => {
    test('an executable renamed .pdf is refused (type mismatch)', async () => {
        const r = await checkFile(mem('certificate.pdf', Buffer.from('MZ\x90\x00payload')), [
            'pdf',
        ]);
        expect(r).toMatchObject({ ok: false, code: 'UPLOAD_TYPE_MISMATCH' });
    });
    test('a PNG renamed .pdf is refused', async () => {
        const r = await checkFile(
            mem('a.pdf', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
            ['pdf', 'png']
        );
        expect(r.code).toBe('UPLOAD_TYPE_MISMATCH');
    });
    test('an extension outside the route allow-list is refused', async () => {
        const r = await checkFile(mem('a.csv', Buffer.from('a,b')), ['pdf']);
        expect(r.code).toBe('UPLOAD_TYPE_NOT_ALLOWED');
    });
    test('a real PDF / CSV passes and gets the canonical MIME', async () => {
        expect(await checkFile(mem('a.pdf', Buffer.from('%PDF-1.4 x')), ['pdf'])).toEqual({
            ok: true,
            kind: 'pdf',
            mime: 'application/pdf',
        });
        expect((await checkFile(mem('a.csv', Buffer.from('a;b\n1;2')), ['text'])).ok).toBe(true);
    });
    test('a real ExcelJS workbook passes as xlsx', async () => {
        const wb = new ExcelJS.Workbook();
        wb.addWorksheet('Certifications').addRow(['Employee Number', 'Skill Name']);
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        const r = await checkFile(mem('import.xlsx', buf), ['xlsx']);
        expect(r).toMatchObject({ ok: true, kind: 'xlsx' });
    });
    test('a zip that is not a spreadsheet (docx content types) is refused as .xlsx', async () => {
        const buf = makeZip([{ name: '[Content_Types].xml', data: Buffer.from(CT_DOCX) }]);
        expect((await checkFile(mem('a.xlsx', buf), ['xlsx'])).code).toBe('UPLOAD_TYPE_MISMATCH');
        expect((await checkFile(mem('a.docx', buf), ['docx'])).ok).toBe(true);
    });
    test('a macro-enabled workbook renamed .xlsx is refused', async () => {
        const buf = makeZip([{ name: '[Content_Types].xml', data: Buffer.from(CT_XLSM) }]);
        expect((await checkFile(mem('a.xlsx', buf), ['xlsx'])).code).toBe('UPLOAD_TYPE_MISMATCH');
    });
    test('a plain zip without [Content_Types].xml is refused as .docx', async () => {
        const buf = makeZip([{ name: 'evil.exe', data: Buffer.from('MZ') }]);
        expect((await checkFile(mem('a.docx', buf), ['docx'])).code).toBe('UPLOAD_TYPE_MISMATCH');
    });
});

describe('inspectZip — zip-bomb guard before ExcelJS', () => {
    const ct = { name: '[Content_Types].xml', data: Buffer.from(CT_XLSX) };

    test('an entry that inflates past its DECLARED size is refused (lying header)', async () => {
        const bomb = Buffer.alloc(5 * 1024 * 1024, 0x41); // 5 MB of 'A', ~5 KB deflated
        const buf = makeZip([ct, { name: 'xl/worksheets/sheet1.xml', data: bomb, declared: 1000 }]);
        await expect(inspectZip(buf)).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' });
        const r = await checkFile(mem('a.xlsx', buf), ['xlsx']);
        expect(r.code).toBe('ZIP_TOO_LARGE');
    });

    test('a total uncompressed size over the cap is refused', async () => {
        const big = Buffer.alloc(3 * 1024 * 1024, 0x42);
        const buf = makeZip([ct, { name: 'a.xml', data: big }, { name: 'b.xml', data: big }]);
        await expect(inspectZip(buf, { maxUncompressed: 4 * 1024 * 1024 })).rejects.toMatchObject({
            code: 'ZIP_TOO_LARGE',
        });
        // the same archive under a larger cap is accepted, with its real size measured
        const ok = await inspectZip(buf, { maxUncompressed: 10 * 1024 * 1024 });
        expect(ok.entries).toBe(3);
        expect(ok.uncompressed).toBe(6 * 1024 * 1024 + CT_XLSX.length);
    });

    test('too many entries is refused', async () => {
        const many = [ct];
        for (let i = 0; i < 30; i++) many.push({ name: `x/${i}.xml`, data: Buffer.from('<a/>') });
        await expect(inspectZip(makeZip(many), { maxEntries: 20 })).rejects.toMatchObject({
            code: 'ZIP_TOO_MANY_ENTRIES',
        });
    });

    test('encrypted entries and unknown methods are refused', async () => {
        await expect(
            inspectZip(makeZip([{ name: 'a', data: Buffer.from('x'), method: 0, flags: 1 }]))
        ).rejects.toMatchObject({ code: 'ZIP_UNSUPPORTED' });
    });

    test('a truncated archive is malformed, not a crash', async () => {
        const buf = makeZip([ct]).subarray(0, 40);
        await expect(inspectZip(buf)).rejects.toMatchObject({ code: 'ZIP_MALFORMED' });
    });
});

describe('macro parts and the zip kind (skills-library ESCO package)', () => {
    test('a workbook carrying vbaProject.bin is refused even with xlsx content types', async () => {
        const buf = makeZip([
            { name: '[Content_Types].xml', data: Buffer.from(CT_XLSX) },
            { name: 'xl/vbaProject.bin', data: Buffer.from('macro') },
        ]);
        expect((await checkFile(mem('a.xlsx', buf), ['xlsx'])).code).toBe('UPLOAD_TYPE_MISMATCH');
    });
    test('a sane .zip passes as kind zip, with the canonical MIME', async () => {
        const buf = makeZip([{ name: 'skills_en.csv', data: Buffer.from('conceptUri,label\n') }]);
        expect(await checkFile(mem('esco.zip', buf), ['text', 'zip'])).toEqual({
            ok: true,
            kind: 'zip',
            mime: 'application/zip',
        });
        // and the importer's capped reader still extracts it
        expect(readZipEntries(buf, (b) => b.endsWith('.csv')).has('skills_en.csv')).toBe(true);
    });
    test('a CSV renamed .zip is refused', async () => {
        expect((await checkFile(mem('esco.zip', Buffer.from('a,b\n')), ['zip'])).code).toBe(
            'UPLOAD_TYPE_MISMATCH'
        );
    });
    test('an encrypted or truncated .zip is refused', async () => {
        const enc = makeZip([{ name: 'a.csv', data: Buffer.from('x'), method: 0, flags: 1 }]);
        expect((await checkFile(mem('e.zip', enc), ['zip'])).code).toBe('ZIP_UNSUPPORTED');
        const cut = makeZip([{ name: 'a.csv', data: Buffer.from('x') }]).subarray(0, 30);
        expect((await checkFile(mem('e.zip', cut), ['zip'])).code).toBe('ZIP_MALFORMED');
    });
    test('a .zip with more entries than the cap is refused', async () => {
        const many = [];
        for (let i = 0; i < 12; i++) many.push({ name: `${i}.csv`, data: Buffer.from('a') });
        const r = await checkFile(mem('m.zip', makeZip(many)), ['zip'], { maxEntries: 10 });
        expect(r.code).toBe('ZIP_TOO_MANY_ENTRIES');
    });
    test('an executable renamed .csv is refused (HRIS and ESCO CSV uploads)', async () => {
        const r = await checkFile(mem('people.csv', Buffer.from('MZ\x90\x00')), ['text']);
        expect(r.code).toBe('UPLOAD_TYPE_MISMATCH');
    });
    test('a .tsv export is text', async () => {
        expect((await checkFile(mem('p.tsv', Buffer.from('a\tb\n')), ['text'])).ok).toBe(true);
    });
});
