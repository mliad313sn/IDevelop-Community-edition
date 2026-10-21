'use strict';

/**
 * The LMS completion webhook passes the origin guard once its per-provider
 * secret validates (a server-to-server JSON POST carries no Origin). Tested by
 * behaviour: the helper, the credential factory server.js uses, and the guard.
 */

const mockVerify = jest.fn();
jest.mock('../../src/services/LmsService', () => ({
    verifyWebhookSecret: (...a) => mockVerify(...a),
}));

const fs = require('fs');
const path = require('path');
const { lmsWebhookCredential } = require('../../src/middleware/lmsWebhookCredential');
const { originGuard, makeValidatedApiCredential } = require('../../src/middleware/httpHardening');

const GOOD = 'webhook-secret-value-0123';
const P = '/integrations/lms/examplelms/webhook';

function req(p, headers = {}) {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        method: 'POST',
        path: p,
        query: {},
        headers: Object.assign({ 'content-type': 'application/json', host: 'x' }, h),
        get(name) {
            return this.headers[String(name).toLowerCase()];
        },
    };
}

beforeEach(() => {
    mockVerify.mockReset();
    mockVerify.mockImplementation(
        async (provider, secret) => provider === 'examplelms' && secret === GOOD
    );
});

describe('lmsWebhookCredential', () => {
    test('the right secret in X-Webhook-Secret → true (checked for that provider)', async () => {
        await expect(lmsWebhookCredential(req(P, { 'X-Webhook-Secret': GOOD }))).resolves.toBe(
            true
        );
        expect(mockVerify).toHaveBeenCalledWith('examplelms', GOOD);
    });

    test('the provider segment is matched case-insensitively; a trailing slash is the same path', async () => {
        await expect(
            lmsWebhookCredential(
                req('/integrations/lms/ExampleLMS/webhook/', { 'x-webhook-secret': GOOD })
            )
        ).resolves.toBe(true);
        expect(mockVerify).toHaveBeenCalledWith('examplelms', GOOD);
    });

    test('a wrong secret → false', async () => {
        await expect(lmsWebhookCredential(req(P, { 'x-webhook-secret': 'nope' }))).resolves.toBe(
            false
        );
    });

    test('no secret header → false, and the store is never asked', async () => {
        await expect(lmsWebhookCredential(req(P))).resolves.toBe(false);
        expect(mockVerify).not.toHaveBeenCalled();
    });

    test('the secret in another header does not count', async () => {
        await expect(
            lmsWebhookCredential(req(P, { 'x-lms-secret': GOOD, authorization: 'Bearer ' + GOOD }))
        ).resolves.toBe(false);
        expect(mockVerify).not.toHaveBeenCalled();
    });

    test('a verifier that throws fails closed → false', async () => {
        mockVerify.mockRejectedValue(new Error('db down'));
        await expect(lmsWebhookCredential(req(P, { 'x-webhook-secret': GOOD }))).resolves.toBe(
            false
        );
    });

    test('a truthy non-boolean verdict is not a validation', async () => {
        mockVerify.mockResolvedValue('yes');
        await expect(lmsWebhookCredential(req(P, { 'x-webhook-secret': GOOD }))).resolves.toBe(
            false
        );
    });

    test.each([
        '/integrations/lms/examplelms/sync',
        '/integrations/lms/examplelms/webhook/extra',
        '/integrations/lms//webhook',
        '/api/v1/integrations/lms/examplelms/webhook',
        '/employees',
        '',
    ])('other path %p → null (not handled), whatever the header', async (p) => {
        await expect(
            lmsWebhookCredential(req(p, { 'x-webhook-secret': GOOD }))
        ).resolves.toBeNull();
        expect(mockVerify).not.toHaveBeenCalled();
    });
});

describe('through the credential server.js uses and the origin guard', () => {
    const apiKeys = { validate: jest.fn(async () => null) };
    const apiAuth = {
        presentedApiKey: (r) => {
            const k = r.headers['x-api-key'];
            return k ? { key: k, source: 'header' } : null;
        },
        queryKeyAllowed: () => true,
        legacySharedKey: () => '',
    };
    const cred = makeValidatedApiCredential({ apiKeys: () => apiKeys, apiAuth: () => apiAuth });

    async function run(headers, p = P) {
        const guard = originGuard({ trustProxy: () => false, validatedCredential: cred });
        let status = null;
        let nexted = false;
        const res = { status: (s) => ((status = s), { json: () => {} }) };
        await guard(req(p, headers), res, () => (nexted = true));
        return { status, nexted };
    }

    test('the right secret reaches the route', async () => {
        expect(await run({ 'x-webhook-secret': GOOD })).toEqual({ status: null, nexted: true });
    });

    test('a wrong or missing secret is refused 403', async () => {
        for (const h of [{ 'x-webhook-secret': 'bad' }, {}]) {
            const r = await run(h);
            expect(r.nexted).toBe(false);
            expect(r.status).toBe(403);
        }
    });

    test('on the webhook path an API key is not a substitute for the secret', async () => {
        apiKeys.validate.mockResolvedValueOnce({ id: 1 });
        const r = await run({ 'x-api-key': 'ak_valid' });
        expect(r.nexted).toBe(false);
        expect(apiKeys.validate).not.toHaveBeenCalled();
    });

    test('server.js wires the factory into the origin guard', () => {
        const server = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
        expect(server).toMatch(/httpHardening\.makeValidatedApiCredential\(\)/);
        expect(server).toMatch(/validatedCredential: _validatedApiCredential/);
    });
});
