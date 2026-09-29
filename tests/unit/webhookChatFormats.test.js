'use strict';
/**
 * Outbound webhooks can post a chat-ready message to Slack or Microsoft Teams
 * instead of the raw JSON envelope. Chat channels are wide audiences, so the
 * message must never carry a rating, a talent label, a risk or contact details.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const { renderPayload, FORMATS } = require('../../src/services/WebhookService');

const DATA = {
    employeeId: 42,
    site: 'Riverside',
    email: 'someone@example.invalid',
    riskScore: 0.8,
    nineBoxLabel: 'Concern',
    rating: 1,
    nested: { a: 1 },
};
const TS = '2026-09-29T12:00:00.000Z';

describe('webhook payload formats', () => {
    test('json keeps the event envelope unchanged', () => {
        expect(renderPayload('json', 'employee.created', DATA, TS)).toEqual({
            event: 'employee.created',
            data: DATA,
            ts: TS,
        });
    });

    test('slack renders Block Kit with a text fallback and a link', () => {
        const p = renderPayload('slack', 'cycle.opened', DATA, TS, 'https://hr.example.org/');
        expect(p.text).toBe('IDevelop · cycle.opened');
        expect(p.blocks[0].type).toBe('section');
        expect(JSON.stringify(p)).toContain('<https://hr.example.org|Open IDevelop>');
    });

    test('teams renders an Adaptive Card message', () => {
        const p = renderPayload('teams', 'cycle.opened', DATA, TS, 'https://hr.example.org');
        expect(p.type).toBe('message');
        const card = p.attachments[0];
        expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
        expect(card.content.type).toBe('AdaptiveCard');
        expect(card.content.actions[0].url).toBe('https://hr.example.org');
    });

    test.each(['slack', 'teams'])('%s never carries sensitive or nested fields', (fmt) => {
        const s = JSON.stringify(renderPayload(fmt, 'x', DATA, TS));
        expect(s).toContain('Riverside');
        for (const leak of ['someone@example.invalid', 'Concern', '0.8', 'riskScore', 'rating']) {
            expect(s).not.toContain(leak);
        }
    });

    test('the migration constrains the column to the supported formats', () => {
        const sql = fs.readFileSync(
            path.join(__dirname, '../../db/postgres/158_webhook_format.sql'),
            'utf8'
        );
        expect(FORMATS).toEqual(['json', 'slack', 'teams']);
        expect(sql).toMatch(/CHECK \(format IN \('json', 'slack', 'teams'\)\)/);
        expect(sql).toMatch(/DEFAULT 'json'/);
    });
});
