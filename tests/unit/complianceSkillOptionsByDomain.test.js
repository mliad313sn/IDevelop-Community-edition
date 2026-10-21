'use strict';
/**
 * The skill pickers of the compliance page tell homonyms apart (4.0.0 port,
 * wave 6): the options are grouped by DOMAIN, one <optgroup> each, the page's
 * three skill selects use the partial and the searchable box, and that box
 * also matches a group's label (a skill is found by its domain).
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PARTIAL = path.join(ROOT, 'views', 'partials', 'skill-options-by-domain.ejs');
const render = (skills) =>
    ejs.render(fs.readFileSync(PARTIAL, 'utf8'), {
        skills,
        __: (k) => `[${k}]`,
    });

describe('partials/skill-options-by-domain', () => {
    test('two skills with one name in two domains land in two groups', () => {
        const html = render([
            { id: 1, name: 'Availability', domainName: 'Maintenance' },
            { id: 2, name: 'Pumps', domainName: 'Maintenance' },
            { id: 3, name: 'Availability', domainName: 'Operations' },
            { id: 4, name: 'Orphan', domainName: null },
        ]);
        const groups = [...html.matchAll(/<optgroup label="([^"]*)">([\s\S]*?)<\/optgroup>/g)];
        expect(groups.map((g) => g[1])).toEqual([
            'Maintenance',
            'Operations',
            '[compliance:no_domain]',
        ]);
        expect(groups[0][2]).toContain('<option value="1">Availability</option>');
        expect(groups[0][2]).toContain('<option value="2">Pumps</option>');
        expect(groups[1][2]).toContain('<option value="3">Availability</option>');
        expect(groups[2][2]).toContain('<option value="4">Orphan</option>');
    });

    test('names and domains are escaped, and an empty list renders nothing', () => {
        const html = render([{ id: 9, name: '<b>x</b>', domainName: '"D"&' }]);
        expect(html).not.toContain('<b>');
        expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
        expect(html).toContain('label="&#34;D&#34;&amp;"');
        expect(render([]).trim()).toBe('');
    });
});

describe('the compliance page and its controller', () => {
    test('the three skill selects use the grouped partial and the searchable box', () => {
        const v = read('views/pages/compliance/index.ejs');
        for (const id of ['rule-skill', 'cert-skill', 'policy-skill'])
            expect(v).toMatch(
                new RegExp(
                    `<select name="skillId" id="${id}" required class="form-control" data-searchable>\\s*<%- include\\('../../partials/skill-options-by-domain'`
                )
            );
        expect(v).not.toMatch(/skills\.forEach\(function \(s\) \{ %><option/);
    });

    test('the controller reads the domain with the skill, ordered by domain', () => {
        const c = read('src/controllers/ComplianceController.js');
        expect(c).toMatch(
            /d\.name AS domain_name[\s\S]{0,120}LEFT JOIN domains d ON d\.id = s\.domain_id/
        );
        expect(c).toMatch(/ORDER BY d\.name NULLS LAST, s\.name, s\.id/);
    });

    test('the searchable select matches a group label and hides an empty group', () => {
        const js = read('public/js/table-search.js');
        expect(js).toMatch(/o\.group && o\.group\.indexOf\(q\) !== -1/);
        expect(js).toMatch(/g\.hidden = !Array\.prototype\.some\.call\(g\.children/);
    });
});
