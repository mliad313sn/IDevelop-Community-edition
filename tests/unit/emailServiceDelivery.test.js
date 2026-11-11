'use strict';

/**
 * EmailService with the one renderer: the SMTP test mail is rendered like any
 * other mail, in one language; extra headers and the CID logo are forwarded
 * (CR/LF stripped, bad names dropped); the plain-text fallback is a real text
 * part; the sender name defaults to the configured app name; SMTP waits are
 * bounded. And the dead BullMQ « notifications » worker, whose handler marked a
 * row sent without sending anything, is gone.
 */
jest.mock('bullmq', () => {
    class FakeQueue {
        constructor(name) {
            this.name = name;
            FakeQueue.instances.push(this);
        }
        add() {
            return Promise.resolve();
        }
    }
    FakeQueue.instances = [];
    class FakeWorker {
        constructor(name, processor) {
            this.name = name;
            this.processor = processor;
            FakeWorker.instances.push(this);
        }
    }
    FakeWorker.instances = [];
    return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: class {} };
});
jest.mock('ioredis', () => class FakeRedis {});
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
    runInSavepoint: jest.fn(async (fn) => fn()),
}));
const mockSettings = {
    appName: 'Nimbus RH',
    smtpHost: 'smtp.example.test',
    smtpPort: 587,
    smtpFromAddress: 'no-reply@example.test',
    enableEmailNotifications: true,
};
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) =>
        Object.prototype.hasOwnProperty.call(mockSettings, k) ? mockSettings[k] : d
    ),
    setValue: jest.fn(async () => true),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));

process.env.APP_BASE_URL = 'https://app.example.test';

const EmailService = require('../../src/services/EmailService');
const N = require('../../src/services/NotificationService');

function fakeTransport() {
    const sendMail = jest.fn(async () => ({ messageId: 'm1' }));
    EmailService._getTransport = async () => ({ sendMail });
    return sendMail;
}

describe('the SMTP test mail goes through the one renderer', () => {
    test('French by default: catalogue subject, lang fr, server details, sender = the app name', async () => {
        const sendMail = fakeTransport();
        const r = await EmailService.sendTest('admin@example.test');
        expect(r.sent).toBe(true);
        const m = sendMail.mock.calls[0][0];
        expect(m.subject).toBe('Nimbus RH — E-mail de test');
        expect(m.html).toMatch(/<html lang="fr"/);
        expect(m.html).toContain('smtp.example.test');
        expect(m.html).toContain('STARTTLS exigé');
        expect(m.text).toContain('Serveur : smtp.example.test');
        expect(`${m.subject}${m.html}${m.text}`).not.toMatch(/test email|This is a test/);
        expect(m.from).toBe('"Nimbus RH" <no-reply@example.test>');
        expect(m.headers['Auto-Submitted']).toBe('auto-generated');
        expect(m.headers['List-Unsubscribe']).toBeUndefined(); // an administrator's own test
    });

    test('English on request', async () => {
        const sendMail = fakeTransport();
        await EmailService.sendTest('admin@example.test', { locale: 'en' });
        const m = sendMail.mock.calls[0][0];
        expect(m.subject).toBe('Nimbus RH — Test e-mail');
        expect(m.text).toContain('Server: smtp.example.test');
    });
});

describe('EmailService.send', () => {
    test('headers (CR/LF stripped, bad names dropped) and the CID logo reach nodemailer; a real text part', async () => {
        const sendMail = fakeTransport();
        const logo = {
            filename: 'logo.png',
            content: Buffer.from('x'),
            cid: 'brand-logo@notifications',
        };
        await EmailService.send({
            to: 'a@example.test',
            subject: 's',
            html: '<p>A &amp; B</p><a href="https://x/y">Lien</a>',
            attachments: [logo],
            headers: {
                'Auto-Submitted': 'auto-generated',
                'List-Unsubscribe': '<https://x/p>\r\nBcc: evil@example.test',
                'Bad Header': 'x',
                'X-Empty': null,
            },
        });
        const m = sendMail.mock.calls[0][0];
        expect(m.attachments).toEqual([logo]);
        expect(m.headers).toEqual({
            'Auto-Submitted': 'auto-generated',
            'List-Unsubscribe': '<https://x/p> Bcc: evil@example.test',
        });
        expect(m.text).toBe('A & B\nLien (https://x/y)');
    });

    test('no header at all → nodemailer gets none', async () => {
        const sendMail = fakeTransport();
        await EmailService.send({ to: 'a@example.test', subject: 's', html: '<p>x</p>' });
        expect(sendMail.mock.calls[0][0].headers).toBeUndefined();
    });

    test('the global e-mail switch OFF stops every mail', async () => {
        const sendMail = fakeTransport();
        mockSettings.enableEmailNotifications = false;
        try {
            const r = await EmailService.send({ to: 'a@example.test', subject: 's', html: 'x' });
            expect(r).toEqual({ sent: false, skipped: 'disabled' });
            expect(sendMail).not.toHaveBeenCalled();
        } finally {
            mockSettings.enableEmailNotifications = true;
        }
    });

    test('SMTP waits are bounded (a stalled relay cannot hold the outbox past its lease)', () => {
        const o = EmailService.transportOptions({
            host: 'smtp.example.test',
            port: 587,
            secure: false,
        });
        expect(o).toMatchObject({
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 30000,
            requireTLS: true,
        });
    });
});

describe('no dead « notifications » worker, no send() stub', () => {
    test('BullMQ boot creates no notifications queue or worker; the outbox drains in the release tick', () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        try {
            const jobs = require('../../src/jobs/index');
            jobs.boot();
            const { Queue, Worker } = require('bullmq');
            expect(Worker.instances.map((w) => w.name)).not.toContain('notifications');
            expect(Queue.instances.map((q) => q.name)).not.toContain('notifications');
            expect(N.send).toBeUndefined();
            expect(jobs.TICKS.map((t) => t.name)).toContain('notifications.release-snoozed');
        } finally {
            delete process.env.REDIS_URL;
        }
    });
});
