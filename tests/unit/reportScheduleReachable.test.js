'use strict';

/**
 * Re-audit D6 — "report scheduling exists server-side but the schedule action is
 * unreachable from the report UI". In the current code the whole chain IS wired,
 * and this test guards it so a refactor cannot silently sever it again:
 *
 *   Builder header → a "Schedules" link (unconditional) → the schedules page,
 *   which has a create <form action="/reports/schedules"> whose template dropdown
 *   is populated from reportTemplates — the SAME table the builder's Save button
 *   POSTs to (/reports/templates → saveTemplate). So a report a user builds and
 *   saves is schedulable by that user.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('D6 — the schedule action is reachable from the report builder', () => {
    const builder = read('views/pages/reports/builder.ejs');
    const schedules = read('views/pages/reports/schedules.ejs');
    const routes = read('src/routes/index.js');
    const ctrl = read('src/controllers/ReportController.js');
    const rbJs = read('public/js/report-builder.js');

    test('the builder header links to the schedules page', () => {
        expect(builder).toMatch(/href="\/reports\/schedules"/);
    });

    test('the schedules page has a create form posting to /reports/schedules', () => {
        expect(schedules).toMatch(/<form method="POST" action="\/reports\/schedules"/);
        expect(schedules).toMatch(/name="templateId" required/);
        // the dropdown is fed by the templates passed to the page
        expect(schedules).toMatch(/templates\.forEach/);
    });

    test('the create/list/run routes are mounted', () => {
        expect(routes).toMatch(/router\.get\('\/reports\/schedules',[^\n]*listSchedules/);
        expect(routes).toMatch(/router\.post\('\/reports\/schedules',[^\n]*createSchedule/);
    });

    test('the builder Save POSTs to the same template store the scheduler reads', () => {
        expect(rbJs).toMatch(/fetch\(\s*'\/reports\/templates',\s*\{\s*method:\s*'POST'/);
        // saveTemplate inserts into reportTemplates; listSchedules reads its dropdown from it
        expect(ctrl).toMatch(/INSERT INTO reportTemplates/);
        expect(ctrl).toMatch(/SELECT id, name FROM reportTemplates/);
    });
});
