'use strict';
/**
 * HRIS connectors — normalisation per connector with MOCKED HTTP, pagination,
 * the SSRF guard on every outbound URL, timeouts, and the CSV drop folder.
 * No socket is ever opened: a `transport` seam replaces the network and a
 * `lookup` seam replaces DNS, while the URL guard itself runs for real.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const hris = require('../../src/integrations/hris');
const http = require('../../src/integrations/hris/http');

const NOW = '2026-09-30T12:00:00Z';
const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }];

/** A fake transport: routes by pathname+search, records every call. */
function fakeTransport(routes) {
    const calls = [];
    const fn = async (url, address, opts) => {
        calls.push({ url: url.toString(), address, opts });
        const key = url.pathname + url.search;
        const hit = Object.keys(routes).find((k) =>
            k.endsWith('*') ? key.startsWith(k.slice(0, -1)) : key === k
        );
        if (!hit) return { status: 404, headers: {}, text: '{"message":"no route"}' };
        const r = typeof routes[hit] === 'function' ? routes[hit](url, opts) : routes[hit];
        return {
            status: r.status || 200,
            headers: r.headers || {},
            text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
        };
    };
    fn.calls = calls;
    return fn;
}

const personioEmployee = (id, extra = {}) => ({
    type: 'Employee',
    attributes: {
        id: { label: 'ID', value: id },
        first_name: { label: 'First name', value: `First${id}` },
        last_name: { label: 'Last name', value: `Last${id}` },
        email: { label: 'Email', value: `P${id}@Example.com` },
        status: { label: 'Status', value: 'active' },
        position: { label: 'Position', value: 'Welder' },
        department: {
            label: 'Department',
            value: { type: 'Department', attributes: { id: 7, name: 'Mining' } },
        },
        office: {
            label: 'Office',
            value: { type: 'Office', attributes: { id: 3, name: 'Stonebridge' } },
        },
        team: { label: 'Team', value: { type: 'Team', attributes: { id: 9, name: 'Open Pit' } } },
        supervisor: {
            label: 'Supervisor',
            value: { type: 'Employee', attributes: { id: { label: 'ID', value: 1 } } },
        },
        hire_date: { label: 'Hire date', value: '2021-03-01T00:00:00+01:00' },
        termination_date: { label: 'Termination date', value: null },
        dynamic_555: { label: 'Staff no', value: `E-${id}` },
        ...extra,
    },
});

describe('Personio connector (mocked HTTP)', () => {
    test('client-credentials auth, pagination over /company/employees, normalisation', async () => {
        const page = (ids, total) => ({
            body: {
                success: true,
                metadata: { total_elements: total },
                data: ids.map((i) => personioEmployee(i)),
            },
        });
        const transport = fakeTransport({
            '/v1/auth': { body: { success: true, data: { token: 'tok-1' } } },
            '/v1/company/employees?limit=2&offset=0': page([1, 2], 3),
            '/v1/company/employees?limit=2&offset=2': page([3], 3),
        });
        const c = hris.getConnector(
            'personio',
            { page_size: 2, attributes: { employeeNumber: 'dynamic_555' } },
            { client_id: 'cid', client_secret: 'sec' },
            { transport, lookup: publicLookup, now: NOW }
        );
        const people = await c.listPeople();
        expect(people).toHaveLength(3);
        expect(people[1]).toEqual({
            externalId: '2',
            employeeNumber: 'E-2',
            firstName: 'First2',
            lastName: 'Last2',
            email: 'p2@example.com',
            jobTitle: 'Welder',
            department: 'Mining',
            site: 'Stonebridge',
            service: 'Open Pit',
            managerExternalId: '1',
            startDate: '2021-03-01',
            endDate: null,
            status: 'active',
        });
        const auth = transport.calls[0];
        expect(auth.opts.method).toBe('POST');
        expect(JSON.parse(auth.opts.body)).toEqual({ client_id: 'cid', client_secret: 'sec' });
        expect(transport.calls[1].opts.headers.Authorization).toBe('Bearer tok-1');
        expect(transport.calls).toHaveLength(3); // auth + 2 pages, no extra page
        // every call pinned to the checked (public) address
        expect(transport.calls.every((x) => x.address.address === '203.0.113.10')).toBe(true);
        expect(transport.calls.every((x) => x.opts.timeoutMs > 0)).toBe(true);
    });

    test('a termination date in the past or status inactive makes a leaver record', async () => {
        const transport = fakeTransport({
            '/v1/auth': { body: { success: true, data: { token: 't' } } },
            '/v1/company/employees*': {
                body: {
                    success: true,
                    data: [
                        personioEmployee(5, {
                            termination_date: { value: '2026-01-31T00:00:00+01:00' },
                        }),
                        personioEmployee(6, { status: { value: 'inactive' } }),
                        personioEmployee(7, { status: { value: 'leave' } }),
                    ],
                },
            },
        });
        const c = hris.getConnector(
            'personio',
            {},
            { client_id: 'a', client_secret: 'b' },
            {
                transport,
                lookup: publicLookup,
                now: NOW,
            }
        );
        const [a, b, d] = await c.listPeople();
        expect(a).toMatchObject({ status: 'inactive', endDate: '2026-01-31' });
        expect(b.status).toBe('inactive');
        expect(d.status).toBe('active'); // on leave is still employed
    });

    test('a rotated token in the Authorization header is used for the next page', async () => {
        const transport = fakeTransport({
            '/v1/auth': { body: { success: true, data: { token: 'first' } } },
            '/v1/company/employees?limit=1&offset=0': {
                headers: { authorization: 'Bearer second' },
                body: { success: true, data: [personioEmployee(1)] },
            },
            '/v1/company/employees?limit=1&offset=1': { body: { success: true, data: [] } },
        });
        const c = hris.getConnector(
            'personio',
            { page_size: 1 },
            { client_id: 'a', client_secret: 'b' },
            {
                transport,
                lookup: publicLookup,
            }
        );
        await c.listPeople();
        expect(transport.calls[2].opts.headers.Authorization).toBe('Bearer second');
    });

    test('missing credentials and a failed auth are reported, not thrown past testConnection', async () => {
        const none = hris.getConnector('personio', {}, {}, { lookup: publicLookup });
        await expect(none.testConnection()).resolves.toMatchObject({
            ok: false,
            code: 'hris_missing_credentials',
        });
        const transport = fakeTransport({
            '/v1/auth': { status: 401, body: { error: { message: 'bad' } } },
        });
        const bad = hris.getConnector(
            'personio',
            {},
            { client_id: 'a', client_secret: 'b' },
            {
                transport,
                lookup: publicLookup,
            }
        );
        const r = await bad.testConnection();
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/HTTP 401/);
    });
});

describe('Lucca connector (mocked HTTP)', () => {
    const user = (id, extra = {}) => ({
        id,
        firstName: `F${id}`,
        lastName: `L${id}`,
        mail: `u${id}@acme.test`,
        employeeNumber: `M${id}`,
        jobTitle: 'Foreman',
        dtContractStart: '2020-05-04T00:00:00',
        dtContractEnd: null,
        department: { id: 11, name: 'Mining' },
        legalEntity: { id: 2, name: 'Stonebridge' },
        manager: { id: 100 },
        ...extra,
    });

    test('API-key header, paging, departments and legal entities, normalisation', async () => {
        const transport = fakeTransport({
            '/api/v3/users*': (url) => {
                const paging = url.searchParams.get('paging');
                if (paging === '0,2') return { body: { data: { items: [user(1), user(2)] } } };
                return {
                    body: {
                        data: {
                            items: [
                                user(3, {
                                    department: null,
                                    departmentID: 12,
                                    legalEntity: null,
                                    legalEntityID: 4,
                                    dtContractEnd: '2026-06-30T00:00:00',
                                }),
                            ],
                        },
                    },
                };
            },
            '/api/v3/departments*': { body: { data: { items: [{ id: 12, name: 'Processing' }] } } },
            '/api/v3/legal-entities*': {
                body: { data: { items: [{ id: 4, name: 'Northgate' }] } },
            },
        });
        const c = hris.getConnector(
            'lucca',
            { base_url: 'https://acme.ilucca.net', page_size: 2 },
            { api_key: 'k-123' },
            { transport, lookup: publicLookup, now: NOW }
        );
        const people = await c.listPeople();
        expect(people).toHaveLength(3);
        expect(people[0]).toEqual({
            externalId: '1',
            employeeNumber: 'M1',
            firstName: 'F1',
            lastName: 'L1',
            email: 'u1@acme.test',
            jobTitle: 'Foreman',
            department: 'Mining',
            site: 'Stonebridge',
            service: null,
            managerExternalId: '100',
            startDate: '2020-05-04',
            endDate: null,
            status: 'active',
        });
        expect(people[2]).toMatchObject({
            department: 'Processing',
            site: 'Northgate',
            endDate: '2026-06-30',
            status: 'inactive',
        });
        const first = transport.calls[0];
        expect(first.opts.headers.Authorization).toBe('lucca application=k-123');
        expect(first.url).toContain('formerEmployees=true');
        expect(first.url).toContain('paging=0,2');
    });

    test('the tenant URL and the API key are required', async () => {
        const noBase = hris.getConnector('lucca', {}, { api_key: 'x' }, { lookup: publicLookup });
        await expect(noBase.testConnection()).resolves.toMatchObject({
            code: 'hris_missing_base_url',
        });
        const noKey = hris.getConnector(
            'lucca',
            { base_url: 'https://a.ilucca.net' },
            {},
            {
                lookup: publicLookup,
            }
        );
        await expect(noKey.testConnection()).resolves.toMatchObject({
            code: 'hris_missing_credentials',
        });
    });
});

describe('SSRF guard on every outbound HRIS URL', () => {
    const never = jest.fn(async () => {
        throw new Error('transport must not be reached');
    });

    test.each([
        ['http://127.0.0.1/', 'hris_url_private'],
        ['https://localhost/', 'hris_url_private'],
        ['https://169.254.169.254/latest/meta-data', 'hris_url_private'],
        ['https://[::ffff:127.0.0.1]/', 'hris_url_private'],
        ['https://10.0.0.5/', 'hris_url_private'],
        ['https://hr.corp.internal/', 'hris_url_private'],
        ['ftp://api.personio.de/', 'hris_url_scheme'],
        ['http://api.personio.de/', 'hris_url_scheme'],
        ['https://user:pw@api.personio.de/', 'hris_url_credentials'],
    ])('%s is refused (%s)', async (url, codeWanted) => {
        await expect(
            http.requestJson(url, { transport: never, lookup: publicLookup })
        ).rejects.toMatchObject({ code: codeWanted });
        expect(never).not.toHaveBeenCalled();
    });

    test('a public NAME that resolves to a private address is refused', async () => {
        await expect(
            http.requestJson('https://evil.example/', {
                transport: never,
                lookup: async () => [{ address: '127.0.0.1', family: 4 }],
            })
        ).rejects.toMatchObject({ code: 'hris_url_private' });
    });

    test('the Lucca connector refuses a private tenant URL before any request', async () => {
        const c = hris.getConnector(
            'lucca',
            { base_url: 'https://192.168.1.10' },
            { api_key: 'k' },
            {
                transport: never,
                lookup: publicLookup,
            }
        );
        await expect(c.listPeople()).rejects.toMatchObject({ code: 'hris_url_private' });
    });

    test('a redirect is refused, never followed', async () => {
        const t = fakeTransport({
            '/x': { status: 302, headers: { location: 'http://127.0.0.1/' }, body: '' },
        });
        await expect(
            http.requestJson('https://api.example.com/x', { transport: t, lookup: publicLookup })
        ).rejects.toMatchObject({ code: 'hris_redirect_refused' });
    });

    test('HRIS_ALLOW_PRIVATE=1 is the operator opt-in for an on-prem gateway', () => {
        process.env.HRIS_ALLOW_PRIVATE = '1';
        try {
            expect(() => http.assertSafeHrisUrl('http://10.1.2.3/api')).not.toThrow();
        } finally {
            delete process.env.HRIS_ALLOW_PRIVATE;
        }
    });

    test('the real transport times out a silent server', async () => {
        const net = require('net');
        const server = net.createServer(() => {
            /* accept and never answer */
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;
        process.env.HRIS_ALLOW_PRIVATE = '1';
        try {
            await expect(
                http.requestJson(`http://127.0.0.1:${port}/`, { timeoutMs: 150 })
            ).rejects.toMatchObject({ code: 'hris_timeout' });
        } finally {
            delete process.env.HRIS_ALLOW_PRIVATE;
            server.close();
        }
    });
});

describe('CSV / TSV connector', () => {
    const HEAD =
        'external_id;employee_number;first_name;last_name;email;job_title;department;site;service;manager_external_id;start_date;end_date;status';

    test('default headers, ";" detected, quotes, dd/mm/yyyy dates, status words', async () => {
        const text = [
            '﻿' + HEAD,
            'X1;E1;Ana;"Diallo; Jr";ANA@acme.test;Welder;Mining;Stonebridge;Open Pit;X2;01/02/2024;;actif',
            'X2;E2;Ben;Koné;ben@acme.test;Foreman;Mining;Stonebridge;;;2020-01-01;;',
            'X3;E3;Old;Timer;;Welder;Mining;;;;;2025-12-31;',
            'X4;E4;Gone;Person;;Welder;Mining;;;;;;terminated',
        ].join('\r\n');
        const c = hris.getConnector('csv', {}, {}, { text, now: NOW });
        const p = await c.listPeople();
        expect(p).toHaveLength(4);
        expect(p[0]).toMatchObject({
            externalId: 'X1',
            lastName: 'Diallo; Jr',
            email: 'ana@acme.test',
            startDate: '2024-02-01',
            managerExternalId: 'X2',
            status: 'active',
            row: 2,
        });
        expect(p[1].service).toBeNull();
        expect(p[2].status).toBe('inactive'); // ended
        expect(p[3].status).toBe('inactive'); // status word
    });

    test('TSV with custom column names; the employee number stands in for a missing id', async () => {
        const text = [
            'Matricule\tPrénom\tNom\tPoste\tService RH',
            'M9\tÉlise\tBa\tWelder\tMining',
        ].join('\n');
        const c = hris.getConnector(
            'csv',
            {
                columns: {
                    employeeNumber: 'Matricule',
                    firstName: 'Prenom',
                    lastName: 'nom',
                    jobTitle: 'poste',
                    department: 'service_rh',
                },
            },
            {},
            { text }
        );
        const [p] = await c.listPeople();
        expect(p).toMatchObject({
            externalId: 'M9',
            employeeNumber: 'M9',
            firstName: 'Élise',
            jobTitle: 'Welder',
            department: 'Mining',
        });
    });

    test('a file without an identifier column is refused with a stable code', async () => {
        const c = hris.getConnector('csv', {}, {}, { text: 'first_name,last_name\nA,B' });
        await expect(c.listPeople()).rejects.toMatchObject({ code: 'hris_csv_no_id_column' });
    });

    test('the drop folder: the newest export is read; HRIS_DROP_ROOT confines the folder', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hris-drop-'));
        try {
            fs.writeFileSync(path.join(dir, 'old.csv'), 'external_id,first_name\nA,Old');
            const newer = path.join(dir, 'new.tsv');
            fs.writeFileSync(newer, 'external_id\tfirst_name\nB\tNew');
            fs.utimesSync(newer, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
            fs.writeFileSync(path.join(dir, 'ignore.xlsx'), 'x');
            const c = hris.getConnector('csv', { folder_path: dir });
            const p = await c.listPeople();
            expect(p.map((x) => x.externalId)).toEqual(['B']);
            expect(c.sourceLabel).toBe('new.tsv');

            process.env.HRIS_DROP_ROOT = path.join(os.tmpdir(), 'somewhere-else');
            await expect(
                hris.getConnector('csv', { folder_path: dir }).listPeople()
            ).rejects.toMatchObject({
                code: 'hris_csv_folder_outside_root',
            });
        } finally {
            delete process.env.HRIS_DROP_ROOT;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('an empty folder is reported', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hris-empty-'));
        try {
            const r = await hris.getConnector('csv', { folder_path: dir }).testConnection();
            expect(r).toMatchObject({ ok: false, code: 'hris_csv_no_file' });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test('registry: unknown provider is refused; the three connectors are listed', () => {
    expect(hris.listProviders().sort()).toEqual(['csv', 'lucca', 'personio']);
    expect(() => hris.getConnector('workday')).toThrow(/Unknown HRIS provider/);
});
