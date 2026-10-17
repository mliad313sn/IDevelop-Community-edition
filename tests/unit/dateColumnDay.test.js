'use strict';
/**
 * DATE columns are printed as the stored day. node-pg parses a DATE into a Date
 * at LOCAL midnight of the server, so `toISOString().slice(0, 10)` printed the
 * previous day on a server east of UTC (the Power BI certification feed's
 * IssuedOn / ExpiresOn). appDayIso gives the app-zone day of an instant.
 *
 * The server zone is process-wide (jest sandboxes process.env), so the zone
 * cases run in a child node process with TZ set.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MOD = path.join(__dirname, '../../src/utils/dateFormat.js');

function inZone(tz, code) {
    return execFileSync(process.execPath, ['-e', code], {
        env: { ...process.env, TZ: tz, APP_TIMEZONE: '' },
        encoding: 'utf8',
    }).trim();
}

describe('sqlDateIso', () => {
    test.each(['Asia/Tokyo', 'Pacific/Auckland', 'UTC', 'America/Los_Angeles'])(
        'a DATE parsed at local midnight keeps its day on a %s server',
        (tz) => {
            // what node-pg builds for '2026-10-01'
            const out = inZone(
                tz,
                `const d = new Date(2026, 9, 1);
                 const { sqlDateIso } = require(${JSON.stringify(MOD)});
                 console.log(JSON.stringify([sqlDateIso(d), d.toISOString().slice(0, 10)]));`
            );
            const [fixed, old] = JSON.parse(out);
            expect(fixed).toBe('2026-10-01');
            // the old form shifted it east of UTC (the defect)
            if (tz === 'Asia/Tokyo' || tz === 'Pacific/Auckland') expect(old).toBe('2026-09-30');
        }
    );

    test('strings, empties and garbage', () => {
        const { sqlDateIso } = require(MOD);
        expect(sqlDateIso('2026-10-01')).toBe('2026-10-01');
        expect(sqlDateIso('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
        expect(sqlDateIso(null)).toBe(null);
        expect(sqlDateIso('')).toBe(null);
        expect(sqlDateIso('not a date')).toBe(null);
    });
});

describe('appDayIso', () => {
    test('the calendar day of an instant in APP_TIMEZONE', () => {
        const code = (tz) =>
            `process.env.APP_TIMEZONE = ${JSON.stringify(tz)};
             const { appDayIso } = require(${JSON.stringify(MOD)});
             console.log(appDayIso(new Date('2026-10-01T22:30:00Z')));`;
        expect(inZone('UTC', code('Asia/Tokyo'))).toBe('2026-10-02');
        expect(inZone('UTC', code('America/Los_Angeles'))).toBe('2026-10-01');
        expect(require(MOD).appDayIso(null)).toBe(null);
    });
});

test('the certification feed formats its DATE columns with sqlDateIso', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/index.js'), 'utf8');
    expect(src).toMatch(/IssuedOn: sqlDateIso\(r\.issuedOn\)/);
    expect(src).toMatch(/ExpiresOn: sqlDateIso\(r\.expiresOn\)/);
    expect(src).not.toMatch(/IssuedOn: r\.issuedOn \? new Date\(r\.issuedOn\)\.toISOString/);
});
