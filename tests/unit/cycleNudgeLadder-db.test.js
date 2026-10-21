'use strict';

/**
 * The campaign reminder ladder, proved against the real test database inside
 * ONE transaction that is always rolled back (nothing written survives).
 *
 *   A 42-day campaign is replayed day by day through cycle-nudge.tick({ now }):
 *   - a person who never starts gets AT MOST 3 job mails (D+3, D-7, D-2) — with
 *     the launch announcement, at most 4 per person (the former cadence was a
 *     weekly mail from day one plus D-7 and D-2: about 8);
 *   - the D+3 « not started » mail stops on start; the D-7 and D-2 deadline
 *     mails go to everyone not yet SUBMITTED — a person who starts on day 10
 *     still gets them, a person who submits on day 20 gets nothing after that;
 *   - weekly « not started » mails already sent under the former cadence count
 *     towards the ceiling (an upgrade in the middle of a campaign);
 *   - a campaign shorter than 10 days gets launch + D-2 only;
 *   - every mail: a calendar date, a link, no html/subject, no ISO date, in the
 *     recipient's language; D-7 and D-2 carry the deadline .ics.
 */
const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;

const ROLLBACK = new Error('cycle-nudge-ladder-rollback');
const DAY = 86400000;
const db = HAS_DB ? require('../../src/config/database') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
}, 30000);
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function inRollback(fn) {
    try {
        await db.runTransaction(async () => {
            await fn();
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

const ISO_DAY = /\b\d{4}-\d{2}-\d{2}\b/;
const CAL_DAY = /\b\d{2}\/\d{2}\/\d{4}\b/;

/** The mail a `content` builder writes in `lang`. */
function built(args, lang = 'fr') {
    const { blocks } = require('../../src/utils/emailTemplate');
    return typeof args.content === 'function' ? args.content(blocks(lang)) : args;
}

/** Every text a mail carries (intro, preheader, block values). */
function textsOf(mail) {
    const out = [mail.intro, mail.preheader, mail.title, mail.ctaLabel];
    for (const b of mail.blocks || []) {
        if (b.text) out.push(b.text);
        for (const r of b.rows || []) out.push(...r.map(String));
        for (const i of b.items || []) out.push(String(i));
    }
    return out.filter((x) => x != null).map(String);
}

async function mkEmployee(tag, stamp) {
    const tpl = await db.get(
        `SELECT site_id, department_id, service_id, role_id FROM employees
          WHERE is_active AND role_id IS NOT NULL ORDER BY id LIMIT 1`
    );
    return Number(
        (
            await db.get(
                `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id, service_id, role_id, is_active)
                 VALUES (?, ?, 'Ladder', ?, ?, ?, ?, true) RETURNING id`,
                [
                    `LADDER-${tag}-${stamp}`,
                    tag,
                    tpl.siteId,
                    tpl.departmentId,
                    tpl.serviceId,
                    tpl.roleId,
                ]
            )
        ).id
    );
}

async function mkCycle(code, openedAt, closesAt) {
    const admin = await db.get(
        "SELECT id FROM admins WHERE role::text = 'superadmin' ORDER BY id LIMIT 1"
    );
    return Number(
        (
            await db.get(
                `INSERT INTO assessment_cycles (code, label, status, opened_at, closes_at, created_by)
                 VALUES (?, ?, 'open', ?, ?, ?) RETURNING id`,
                [code, code, openedAt, closesAt, Number(admin.id)]
            )
        ).id
    );
}

function harness() {
    const NotificationService = require('../../src/services/NotificationService');
    const CycleService = require('../../src/services/CycleService');
    const sent = [];
    const spyN = jest.spyOn(NotificationService, 'notify').mockImplementation(async (args) => {
        sent.push(args);
        return { inapp: 'queued', email: 'sent' };
    });
    // The roster self-heal would enrol the whole test population into the
    // fixture campaign; it is not what this suite measures.
    const spyR = jest
        .spyOn(CycleService, 'reconcileParticipants')
        .mockImplementation(async () => ({ reincluded: 0 }));
    return { sent, restore: () => (spyN.mockRestore(), spyR.mockRestore()) };
}

suite('the person’s ladder on a 42-day campaign', () => {
    test('≤ 4 mails per person with the launch; D+3 stops on start, deadlines stop on submit', async () => {
        await inRollback(async () => {
            const stamp = Date.now();
            const T0 = new Date(Date.now() - 3600000); // opened an hour ago
            const closes = new Date(T0.getTime() + 42 * DAY);
            const C = await mkCycle(`LADDER-42-${stamp}`, T0, closes);
            const never = await mkEmployee('NEVER', stamp);
            const starter = await mkEmployee('STARTER', stamp);
            const submitter = await mkEmployee('SUBMITTER', stamp);
            const skill = await db.get('SELECT id FROM skills ORDER BY id LIMIT 1');
            await db.run(
                `INSERT INTO cycle_participants (cycle_id, employee_id, expected_skills)
                 VALUES (?, ?, 12), (?, ?, 12), (?, ?, 12)`,
                [C, never, C, starter, C, submitter]
            );
            const { sent, restore } = harness();
            try {
                const tick = require('../../src/jobs/cycle-nudge').tick;
                for (let d = 0; d <= 44; d++) {
                    if (d === 10) {
                        // the starter opens the page and rates a first skill
                        await db.run(
                            `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, cycle_id)
                             VALUES (?, ?, 2, 'draft', 'draft', ?)`,
                            [starter, Number(skill.id), C]
                        );
                    }
                    if (d === 20) {
                        // the submitter rates and SUBMITS
                        await db.run(
                            `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, cycle_id)
                             VALUES (?, ?, 3, 'submitted', 'submitted', ?)`,
                            [submitter, Number(skill.id), C]
                        );
                    }
                    for (const h of [0, 6, 12]) {
                        await tick({ now: new Date(T0.getTime() + d * DAY + h * 3600000) });
                    }
                    for (const s of sent) if (s.__day == null) s.__day = d;
                }
            } finally {
                restore();
            }
            const mine = sent.filter((s) => s.payload && Number(s.payload.cycleId) === C);
            const to = (id) => mine.filter((s) => Number(s.userId) === id);

            expect(to(never).map((s) => s.payload.stage)).toEqual([
                'not_started',
                'reminder_7',
                'reminder_2',
            ]);
            expect(to(never).map((s) => s.__day)).toEqual([3, 35, 40]);
            // started on day 10 but never submitted: D+3, then the two deadline mails
            expect(to(starter).map((s) => s.payload.stage)).toEqual([
                'not_started',
                'reminder_7',
                'reminder_2',
            ]);
            expect(built(to(starter).find((s) => s.payload.stage === 'reminder_2')).intro).toMatch(
                /pas encore soumise/
            );
            // submitted on day 20: nothing after that day
            expect(to(submitter).map((s) => s.__day)).toEqual([3]);

            for (const s of mine) {
                expect(s).not.toHaveProperty('html');
                expect(s).not.toHaveProperty('subject');
                expect(s).not.toHaveProperty('text');
                expect(s.payload.link).toBe('/employee/self-assessment');
                for (const lang of ['fr', 'en']) {
                    const m = built(s, lang);
                    expect(m.ctaUrl).toBe('/employee/self-assessment');
                    const texts = textsOf(m);
                    expect(texts.some((x) => CAL_DAY.test(x))).toBe(true);
                    for (const x of texts) {
                        expect(x).not.toMatch(ISO_DAY);
                        expect(x).not.toMatch(/GMT|\(s\)/);
                    }
                }
                if (s.payload.stage === 'not_started') expect(s.calendar).toBeUndefined();
                else
                    expect(s.calendar).toMatchObject({
                        type: 'campaign_deadline',
                        uid: `cycle-${C}-deadline`,
                    });
            }
            // English is really English
            expect(built(to(never)[2], 'en').intro).toMatch(/Last reminder/);
        });
    }, 120000);

    test('mails of the former weekly cadence count towards the ceiling', async () => {
        await inRollback(async () => {
            const stamp = Date.now();
            const T0 = new Date(Date.now() - 3600000);
            const C = await mkCycle(`LADDER-UPG-${stamp}`, T0, new Date(T0.getTime() + 42 * DAY));
            const p = await mkEmployee('UPGRADE', stamp);
            await db.run(
                'INSERT INTO cycle_participants (cycle_id, employee_id, expected_skills) VALUES (?, ?, 5)',
                [C, p]
            );
            // three weekly « not started » mails already went out before the upgrade
            for (const wk of ['w1', 'w2', 'w3'])
                await db.run(
                    `INSERT INTO reminder_log (kind, target_type, target_id, ref_id, period)
                     VALUES ('cycle.not_started', 'employee', ?, ?, ?)`,
                    [p, C, `2026-01-0${wk.slice(1)}`]
                );
            const { sent, restore } = harness();
            try {
                const tick = require('../../src/jobs/cycle-nudge').tick;
                for (let d = 0; d <= 43; d++)
                    await tick({ now: new Date(T0.getTime() + d * DAY + 7200000) });
            } finally {
                restore();
            }
            const mine = sent.filter(
                (s) => Number(s.userId) === p && Number(s.payload.cycleId) === C
            );
            expect(mine).toHaveLength(0); // launch + 3 = 4 already
        });
    }, 60000);

    test('a campaign shorter than 10 days: launch + D-2 only', async () => {
        await inRollback(async () => {
            const stamp = Date.now();
            const T0 = new Date(Date.now() - 3600000);
            const C = await mkCycle(`LADDER-8-${stamp}`, T0, new Date(T0.getTime() + 8 * DAY));
            const p = await mkEmployee('SHORT', stamp);
            await db.run(
                'INSERT INTO cycle_participants (cycle_id, employee_id, expected_skills) VALUES (?, ?, 5)',
                [C, p]
            );
            const { sent, restore } = harness();
            try {
                const tick = require('../../src/jobs/cycle-nudge').tick;
                for (let d = 0; d <= 9; d++)
                    await tick({ now: new Date(T0.getTime() + d * DAY + 7200000) });
            } finally {
                restore();
            }
            const mine = sent.filter(
                (s) => Number(s.userId) === p && Number(s.payload.cycleId) === C
            );
            expect(mine.map((s) => s.payload.stage)).toEqual(['reminder_2']);
        });
    }, 60000);
});

suite('the D-7 line message (4.0.0 port, wave 7)', () => {
    test('the reviewer gets ONE count of the people who have not started, never a name', async () => {
        await inRollback(async () => {
            const stamp = Date.now();
            const T0 = new Date(Date.now() - 3600000);
            const closes = new Date(T0.getTime() + 42 * DAY);
            const C = await mkCycle(`LADDER-TEAM-${stamp}`, T0, closes);
            const lead = await mkEmployee('LEAD', stamp);
            const quiet1 = await mkEmployee('QUIETONE', stamp);
            const quiet2 = await mkEmployee('QUIETTWO', stamp);
            const busy = await mkEmployee('BUSY', stamp);
            await db.run('UPDATE employees SET supervisor_id = ? WHERE id IN (?, ?, ?)', [
                lead,
                quiet1,
                quiet2,
                busy,
            ]);
            await db.run(
                `INSERT INTO cycle_participants (cycle_id, employee_id, expected_skills)
                 VALUES (?, ?, 6), (?, ?, 6), (?, ?, 6)`,
                [C, quiet1, C, quiet2, C, busy]
            );
            const skills = await db.all('SELECT id FROM skills ORDER BY id LIMIT 2');
            // `busy` has rated two of six skills: started, not submitted
            for (const sk of skills)
                await db.run(
                    `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, cycle_id)
                     VALUES (?, ?, 2, 'draft', 'draft', ?)`,
                    [busy, Number(sk.id), C]
                );
            const { sent, restore } = harness();
            try {
                const tick = require('../../src/jobs/cycle-nudge').tick;
                // D-7, then again an hour later and the next day: still ONE line message
                for (const h of [0, 1, 24])
                    await tick({ now: new Date(closes.getTime() - 6.5 * DAY + h * 3600000) });
            } finally {
                restore();
            }
            const mine = sent.filter((s) => s.payload && Number(s.payload.cycleId) === C);
            const team = mine.filter((s) => s.kind === 'cycle.team_reminder');
            expect(team).toHaveLength(1);
            expect(team[0]).toMatchObject({ userType: 'employee', userId: lead });
            expect(team[0].payload).toMatchObject({ count: 2, link: '/dashboard' });
            for (const lang of ['fr', 'en']) {
                const texts = textsOf(built(team[0], lang)).join(' ');
                expect(texts).not.toMatch(/QUIET|BUSY|Ladder/);
                expect(texts).toMatch(CAL_DAY);
            }
            expect(built(team[0], 'en').intro).toMatch(/^2 people in your team/);
            // the people's own ladder is untouched, and `busy` reads where they stand
            const own = mine.filter((s) => s.kind === 'cycle.reminder');
            expect(own.map((s) => Number(s.userId)).sort()).toEqual([quiet1, quiet2, busy].sort());
            const busyMail = built(
                own.find((s) => Number(s.userId) === busy),
                'en'
            );
            expect(textsOf(busyMail).join(' ')).toMatch(/already rated 2 of 6 skills/);
            expect(busyMail.ctaLabel).toBe('Open my self-assessment');
            const quietMail = built(
                own.find((s) => Number(s.userId) === quiet1),
                'fr'
            );
            expect(quietMail.ctaLabel).toBe('Commencer mon auto-évaluation');
            expect(textsOf(quietMail).join(' ')).toMatch(/plan de développement/);
        });
    }, 60000);
});
