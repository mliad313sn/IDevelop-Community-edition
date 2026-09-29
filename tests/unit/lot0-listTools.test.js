'use strict';

// Lot 0 F4 (L6-05 / L6-06 / L6-26 / L6-27 / L6-30 / L4-03): the shared list toolkit.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const L = require('../../src/utils/listTools');

describe('buildPager — links carry EVERY current query param', () => {
    const query = {
        status: 'all',
        page: '2',
        perPage: '25',
        siteId: '11',
        search: 'ka mé',
        sort: 'lastName',
        dir: 'desc',
    };
    const pg = L.buildPager(query, { page: 2, total: 120, perPage: 25, basePath: '/employees' });

    test('status, perPage, site, search and sort survive on every link', () => {
        const links = [pg.prevUrl, pg.nextUrl, ...pg.items.filter((i) => !i.gap).map((i) => i.url)];
        links.forEach((u) => {
            expect(u).toMatch(/^\/employees\?/);
            expect(u).toMatch(/status=all/);
            expect(u).toMatch(/perPage=25/);
            expect(u).toMatch(/siteId=11/);
            expect(u).toMatch(/search=ka\+m%C3%A9/);
            expect(u).toMatch(/sort=lastName/);
            expect(u).toMatch(/dir=desc/);
        });
        expect(pg.prevUrl).toMatch(/page=1(&|$)/);
        expect(pg.nextUrl).toMatch(/page=3(&|$)/);
    });

    test('range and bounds', () => {
        expect(pg).toMatchObject({
            page: 2,
            perPage: 25,
            total: 120,
            totalPages: 5,
            from: 26,
            to: 50,
            hasPrev: true,
            hasNext: true,
        });
        expect(pg.items.find((i) => i.active).n).toBe(2);
    });

    test('page is clamped, empty list has 0–0, a window gap is marked once', () => {
        expect(L.buildPager({}, { page: 99, total: 10, perPage: 5 })).toMatchObject({
            page: 2,
            totalPages: 2,
            from: 6,
            to: 10,
            hasNext: false,
        });
        expect(L.buildPager({}, { page: 1, total: 0, perPage: 50 })).toMatchObject({
            page: 1,
            totalPages: 1,
            from: 0,
            to: 0,
        });
        const wide = L.buildPager({}, { page: 10, total: 1000, perPage: 50 });
        const gaps = wide.items.filter((i) => i.gap).length;
        expect(gaps).toBe(2);
        expect(wide.items[0].n).toBe(1);
        expect(wide.items[wide.items.length - 1].n).toBe(20);
    });

    test('repeated params (siteId[]) are kept, nested objects dropped', () => {
        const p = L.buildPager(
            { siteId: ['1', '2'], filters: { a: 1 } },
            { page: 1, total: 100, perPage: 20 }
        );
        expect(p.urlFor(3)).toBe('?siteId=1&siteId=2&page=3');
    });
});

describe('parsePage / sortClause / sortLinks', () => {
    test('parsePage allow-lists perPage and never goes below page 1', () => {
        expect(
            L.parsePage(
                { page: '0', perPage: '999999' },
                { perPageOptions: [20, 50], defaultPerPage: 50 }
            )
        ).toEqual({ page: 1, perPage: 50, offset: 0 });
        expect(
            L.parsePage(
                { page: '3', perPage: '20' },
                { perPageOptions: [20, 50], defaultPerPage: 50 }
            )
        ).toEqual({ page: 3, perPage: 20, offset: 40 });
    });

    const WL = { lastName: 'e.lastName', site: 's.name' };
    test('sortClause only ever emits whitelisted expressions', () => {
        expect(L.sortClause({ sort: 'lastName', dir: 'desc' }, WL, 'site')).toMatchObject({
            key: 'lastName',
            dir: 'desc',
            orderBy: 'e.lastName DESC',
            isDefault: false,
        });
        expect(
            L.sortClause({ sort: 'lastName; DROP TABLE x', dir: 'desc' }, WL, 'site')
        ).toMatchObject({ key: 'site', dir: 'asc', orderBy: 's.name ASC', isDefault: true });
        expect(L.sortClause({ sort: 'lastName', dir: 'sideways' }, WL, 'site').dir).toBe('asc');
        expect(L.sortClause({}, WL, 'site', { tiebreak: 'e.lastName' }).orderBy).toBe(
            's.name ASC, e.lastName'
        );
    });

    test('sortLinks: active column flips direction, page resets, filters kept, aria-sort set', () => {
        const q = { status: 'all', page: '3', sort: 'lastName', dir: 'asc' };
        const links = L.sortLinks(
            q,
            WL,
            { key: 'lastName', dir: 'asc' },
            { basePath: '/employees' }
        );
        expect(links.lastName).toMatchObject({ active: true, dir: 'asc', ariaSort: 'ascending' });
        expect(links.lastName.url).toBe('/employees?status=all&sort=lastName&dir=desc');
        expect(links.site).toMatchObject({ active: false, ariaSort: 'none' });
        expect(links.site.url).toBe('/employees?status=all&sort=site&dir=asc');
        expect(L.sortLinks(q, WL, null).lastName.ariaSort).toBe('none');
    });
});

describe('csvResponse — Excel-safe (BOM + sep + formula guard) through the one shared helper', () => {
    function res() {
        const r = { headers: {}, body: null };
        r.setHeader = (k, v) => {
            r.headers[k] = v;
        };
        r.send = (b) => {
            r.body = b;
            return r;
        };
        return r;
    }
    test('BOM, sep hint, quoted cells, formula-injection prefix, dated filename', () => {
        const r = res();
        L.csvResponse(
            r,
            'journaux 2026-09-01 é.csv',
            ['Nom', 'Note'],
            [
                ['Lambért', '=1+1'],
                ['O"Neil', '-x'],
            ]
        );
        expect(r.body.charCodeAt(0)).toBe(0xfeff);
        // \uFEFF spelled out: the assertion is that the CSV opens with a BOM, and
        // a LITERAL byte-order mark inside a regex is invisible in every editor
        // and refused by eslint (no-irregular-whitespace).
        expect(r.body).toMatch(
            /^\uFEFFsep=,\r\n"Nom","Note"\r\n"Lambért","'=1\+1"\r\n"O""Neil","'-x"\r\n$/
        );
        expect(r.headers['Content-Type']).toBe('text/csv; charset=utf-8');
        expect(r.headers['Content-Disposition']).toBe(
            'attachment; filename="journaux-2026-09-01-e.csv"'
        );
    });
    test('reuses ReportBuilderService.excelCsv (source pin)', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/utils/listTools.js'), 'utf8');
        expect(src).toMatch(/require\('\.\.\/services\/ReportBuilderService'\)/);
        expect(src).toMatch(/excelCsv\(/);
    });
});

describe('/employees wiring (source pins)', () => {
    const ctrl = fs.readFileSync(
        path.join(__dirname, '../../src/controllers/EmployeeController.js'),
        'utf8'
    );
    const model = fs.readFileSync(
        path.join(__dirname, '../../src/models/EmployeeModel.js'),
        'utf8'
    );
    const view = fs.readFileSync(
        path.join(__dirname, '../../views/pages/employees/index.ejs'),
        'utf8'
    );

    test('controller builds the pager from req.query and passes a whitelisted sort to the model', () => {
        expect(ctrl).toMatch(
            /buildPager\(req\.query, \{ page, total, perPage, basePath: '\/employees' \}\)/
        );
        expect(ctrl).toMatch(/sortClause\(req\.query, EmployeeModel\.SORT_COLUMNS, 'site'\)/);
        expect(ctrl).toMatch(/orderBy: grouped \? null : `\$\{sort\.key\}:\$\{sort\.dir\}`/);
    });
    test('model resolves the key against SORT_COLUMNS only (no raw client SQL)', () => {
        expect(model).toMatch(/const sortExpr = SORT_COLUMNS\[sortKey\];/);
        expect(model).toMatch(/lastName: 'e\.lastName'/);
        expect(model).not.toMatch(/ORDER BY \$\{orderBy\}/);
    });
    test('view: pager from `pager`, headers carry aria-sort, separators only when grouped and marked data-ts-skip', () => {
        expect(view).not.toMatch(/const queryParams=/);
        expect(view).toMatch(/pg\.items\.forEach/);
        expect(view).toMatch(/aria-sort="<%= c \? c\.ariaSort : 'none' %>"/);
        expect(view).toMatch(/if \(isGrouped && currentSite !==employee\.siteName\)/);
        expect(view).toMatch(/class="site-separator" data-ts-skip/);
        expect(view).toMatch(/data-filter-memory/);
        expect(view).toMatch(/data-per-page/);
    });
});

describe('client toolkit (source pins)', () => {
    const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public/js', f), 'utf8');
    test('main.js binds the client filter only to [data-client-search] (+ legacy non-form inputs) and no longer sorts', () => {
        const src = pub('main.js');
        expect(src).toMatch(/querySelectorAll\('\[data-client-search\]'\)/);
        // The legacy selector survives only behind a filter that excludes server
        // (GET-form) search boxes and table-search.js-driven inputs.
        // \s* on purpose: prettier breaks the call across lines after the
        // selector string. The rule pinned is WHICH inputs the legacy path picks
        // up and that it filters them — not where the line breaks fall.
        expect(src).toMatch(
            /querySelectorAll\('input\[type="search"\], \.search-input'\)\s*\)\s*\.filter\(/
        );
        expect(src).toMatch(/!el\.closest\('form\[method="GET"\], form\[method="get"\]'\)/);
        expect(src).toMatch(/!el\.hasAttribute\('data-table-search'\)/);
        expect(src).not.toMatch(/a\.children\[columnIndex\]\.textContent/);
    });
    test('list-tools.js: sortable headers skip separators, aria-sort, filter memory, per-page', () => {
        const src = pub('list-tools.js');
        expect(src).toMatch(
            /\[data-ts-skip\], \.site-separator, \.empty-row, \[data-ts-noresults\]/
        );
        expect(src).toMatch(/setAttribute\('aria-sort'/);
        expect(src).toMatch(/'filters:' \+ path/);
        expect(src).toMatch(/reset=1/);
        expect(src).toMatch(/select\[data-per-page\], \[data-auto-submit\]/);
    });
    test('the layout loads list-tools.js after table-search.js', () => {
        const layout = fs.readFileSync(
            path.join(__dirname, '../../views/layouts/main.ejs'),
            'utf8'
        );
        expect(layout.indexOf('/js/list-tools.js')).toBeGreaterThan(
            layout.indexOf('/js/table-search.js')
        );
    });
});
