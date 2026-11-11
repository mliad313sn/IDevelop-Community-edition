'use strict';
/**
 * Outgoing webhooks carry only an allow-list of notification kinds, and their
 * payload is reduced to ids, dates and an in-app link.
 *
 *  - The pip, ninebox, retention and privacy families never leave.
 *  - 360° feedback, one-to-one and HRIS sync kinds leave only when a SuperAdmin
 *    lists them in the security-class setting `webhookOptInEvents`.
 *  - A subscription to '*' does not widen the allow-list.
 */
const mockDb = { all: jest.fn(), run: jest.fn(async () => ({})), get: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockSettings = { value: '' };
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async () => mockSettings.value),
}));

const Hook = require('../../src/services/WebhookService');
const { isSecurityClassSetting } = require('../../src/utils/securitySettings');

const SUB = { id: 7, url: 'https://hooks.example.test/x', events: ['*'], format: 'json' };

beforeEach(() => {
    mockSettings.value = '';
    mockDb.all.mockReset();
    mockDb.all.mockResolvedValue([SUB]);
});

describe('isEmittable', () => {
    test.each([
        'lifecycle.joiner',
        'lifecycle.leaver',
        'idp.created',
        'cert.expiry',
        'coverage.breach',
        'test.ping',
    ])('%s leaves', (ev) => {
        expect(Hook.isEmittable(ev)).toBe(true);
    });

    test.each([
        'pip.create',
        'ninebox.disclosed',
        'retention.risk_high',
        'privacy.request',
        'security.account_soft_locked',
        'recognition.received',
        'sa.change_request_raised_on_me',
        'feedback360.released',
        'oneonone.topic_added',
        'hris.sync.failed',
        '',
        undefined,
    ])('%s does not leave by default', (ev) => {
        expect(Hook.isEmittable(ev)).toBe(false);
    });

    test('a SuperAdmin opt-in lets a kind or a whole family leave, nothing else', () => {
        const opt = Hook.parseOptIn(
            'feedback360.*, oneonone.topic_added, pip.create, *, ninebox.*'
        );
        expect(opt).toEqual(['feedback360.*', 'oneonone.topic_added']);
        expect(Hook.isEmittable('feedback360.released', opt)).toBe(true);
        expect(Hook.isEmittable('feedback360.reminder', opt)).toBe(true);
        expect(Hook.isEmittable('oneonone.topic_added', opt)).toBe(true);
        expect(Hook.isEmittable('oneonone.other', opt)).toBe(false);
        expect(Hook.isEmittable('hris.sync.failed', opt)).toBe(false);
        expect(Hook.isEmittable('pip.create', opt)).toBe(false);
        expect(Hook.isEmittable('ninebox.disclosed', opt)).toBe(false);
    });

    test('the allow-list holds no blocked family', () => {
        for (const ev of Hook.EMITTABLE_EVENTS)
            expect(ev).not.toMatch(/^(pip|ninebox|retention|privacy|feedback360|oneonone|hris)/);
    });
});

describe('emit', () => {
    test('a confidential kind is not even looked up, whatever the subscription', async () => {
        const out = await Hook.emit('ninebox.disclosed', { payload: { box: 9 } });
        expect(out).toEqual({ delivered: 0, skipped: 'not_emittable' });
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('an opt-in kind leaves once the setting lists it', async () => {
        const spy = jest.spyOn(Hook, '_deliver').mockResolvedValue({ ok: true, status: 200 });
        expect((await Hook.emit('feedback360.released', {})).skipped).toBe('not_emittable');
        mockSettings.value = 'feedback360.*';
        const out = await Hook.emit('feedback360.released', { payload: { cycleId: 3 } });
        expect(out.delivered).toBe(1);
        spy.mockRestore();
    });

    test('an allowed kind is delivered with the minimised payload only', async () => {
        const spy = jest.spyOn(Hook, '_deliver').mockResolvedValue({ ok: true, status: 200 });
        await Hook.emit('lifecycle.leaver', {
            userType: 'admin',
            userId: 4,
            category: 'lifecycle',
            payload: Hook.minimisePayload({
                employeeId: 12,
                employeeName: 'Alex Sample',
                reason: 'personal reasons',
                score: 3.4,
                leftOn: '2026-10-01',
                link: '/employees/12',
            }),
        });
        const body = JSON.parse(spy.mock.calls[0][1]);
        expect(body.data.payload).toEqual({
            employeeId: 12,
            leftOn: '2026-10-01',
            link: '/employees/12',
        });
        expect(spy.mock.calls[0][2]['x-idevelop-event']).toBe('lifecycle.leaver');
        spy.mockRestore();
    });
});

describe('minimisePayload', () => {
    test('keeps ids, ISO dates and an in-app link; drops names, figures, free text', () => {
        const d = new Date('2026-10-02T08:00:00Z');
        expect(
            Hook.minimisePayload({
                id: '42',
                cycleId: 5,
                employee_id: 'x9',
                dueAt: d,
                startedOn: 'not a date',
                reviewDate: '2026-10-03',
                link: '//evil.example/x',
                name: 'Alex',
                comment: 'free text',
                rating: 4,
                nested: { employeeId: 1 },
            })
        ).toEqual({
            id: '42',
            cycleId: 5,
            dueAt: d.toISOString(),
            reviewDate: '2026-10-03',
        });
        expect(Hook.minimisePayload(null)).toEqual({});
        expect(Hook.minimisePayload([1, 2])).toEqual({});
    });
});

describe('the opt-in setting', () => {
    test('is security-class (SuperAdmin only) and has a default row and labels', () => {
        expect(isSecurityClassSetting('webhookOptInEvents', 'integrations')).toBe(true);
        const fs = require('fs');
        const path = require('path');
        const model = fs.readFileSync(
            path.join(__dirname, '../../src/models/AppSettingsModel.js'),
            'utf8'
        );
        expect(model).toMatch(/key: 'webhookOptInEvents',\s*value: '',/);
        for (const lng of ['fr', 'en']) {
            const admin = JSON.parse(
                fs.readFileSync(path.join(__dirname, `../../locales/${lng}/admin.json`), 'utf8')
            );
            expect(admin.set_name_webhookOptInEvents).toEqual(expect.any(String));
            expect(admin.set_desc_webhookOptInEvents).toEqual(expect.any(String));
        }
    });

    test('NotificationService hands the webhook a minimised payload', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/NotificationService.js'),
            'utf8'
        );
        expect(src).toMatch(/Hook\.minimisePayload\(payload\)/);
        expect(src).not.toMatch(/emit\(kind, \{ userType, userId, category, payload \}\)/);
    });
});
