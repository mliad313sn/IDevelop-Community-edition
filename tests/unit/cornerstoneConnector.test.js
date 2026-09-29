'use strict';

/**
 * Cornerstone OnDemand (CSOD) connector compatibility.
 * Simulates real CSOD behaviour with an injected fetch:
 *  - OAuth2 client_credentials (client_secret_post AND client_secret_basic)
 *  - OData pagination via @odata.nextLink (full catalogue / transcript set)
 *  - snake_case reporting-view columns (vw_rpt_training_object / vw_rpt_transcript)
 *  - outbound assignment + inbound webhook normalisation
 */
const { getConnector } = require('../../src/integrations/lms');

function res(status, obj) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}

// A fresh fetch + connector per test so the module-level token cache (keyed by
// base_url|client_id) never masks a token-mode assertion.
function makeFetch(record = {}) {
    return function csodFetch(url, opts) {
        url = String(url);
        if (url.includes('/oauth2/token')) {
            const basic =
                opts.headers &&
                opts.headers.Authorization &&
                String(opts.headers.Authorization).startsWith('Basic');
            record.tokenMode = basic
                ? 'basic'
                : String(opts.body || '').includes('client_id=')
                  ? 'body'
                  : '?';
            return Promise.resolve(
                res(200, { access_token: 'CSOD-TOK', token_type: 'Bearer', expires_in: 3600 })
            );
        }
        if (url.includes('vw_rpt_training_object')) {
            return url.includes('skip=1')
                ? Promise.resolve(
                      res(200, {
                          value: [
                              {
                                  lo_object_id: 'LO-2',
                                  lo_title: 'Cloud Security',
                                  lo_duration_min: 120,
                                  lo_subjects: ['Security'],
                              },
                          ],
                      })
                  )
                : Promise.resolve(
                      res(200, {
                          value: [
                              {
                                  lo_object_id: 'LO-1',
                                  lo_title: 'Incident Response',
                                  lo_type: 'Curriculum',
                              },
                          ],
                          '@odata.nextLink':
                              '/services/api/x/odata/api/views/vw_rpt_training_object?skip=1',
                      })
                  );
        }
        if (url.includes('vw_rpt_transcript')) {
            return url.includes('skip=1')
                ? Promise.resolve(
                      res(200, {
                          value: [
                              {
                                  user_email: 'b@corp.com',
                                  lo_object_id: 'LO-2',
                                  transc_status: 'Completed',
                                  transc_id: 'T-2',
                                  transc_comp_dt: '2026-06-10',
                                  transc_score: 95,
                              },
                          ],
                      })
                  )
                : Promise.resolve(
                      res(200, {
                          value: [
                              {
                                  user_email: 'a@corp.com',
                                  lo_object_id: 'LO-1',
                                  transc_status: 'Completed',
                                  transc_id: 'T-1',
                                  transc_comp_dt: '2026-06-01',
                              },
                          ],
                          '@odata.nextLink':
                              '/services/api/x/odata/api/views/vw_rpt_transcript?skip=1',
                      })
                  );
        }
        if (url.includes('/transcripts') && opts.method === 'POST')
            return Promise.resolve(res(201, { TranscriptId: 'T-NEW' }));
        return Promise.resolve(res(404, {}));
    };
}

function connector(authExtra = {}, record = {}, clientId = 'cid') {
    return getConnector('cornerstone', {
        base_url: 'https://acme.csod.com',
        auth_config: { client_id: clientId, client_secret: 'sec', scope: 'all', ...authExtra },
        _fetch: makeFetch(record),
    });
}

describe('CornerstoneConnector — CSOD compatibility', () => {
    test('OAuth2 client_secret_post by default; client_secret_basic when configured', async () => {
        const r1 = {};
        await getConnector('cornerstone', {
            base_url: 'https://acme.csod.com',
            auth_config: { client_id: 'post-cid', client_secret: 's' },
            _fetch: makeFetch(r1),
        }).testConnection();
        expect(r1.tokenMode).toBe('body');

        const r2 = {};
        await getConnector('cornerstone', {
            base_url: 'https://acme.csod.com',
            auth_config: { client_id: 'basic-cid', client_secret: 's', token_auth: 'basic' },
            _fetch: makeFetch(r2),
        }).testConnection();
        expect(r2.tokenMode).toBe('basic');
    });

    test('fetchCatalog follows @odata.nextLink and parses snake_case reporting columns', async () => {
        const cat = await connector({}, {}, 'cat-cid').fetchCatalog();
        expect(cat).toHaveLength(2); // both pages
        const lo2 = cat.find((c) => c.externalId === 'LO-2');
        const lo1 = cat.find((c) => c.externalId === 'LO-1');
        expect(lo2.title).toBe('Cloud Security');
        expect(lo2.durationMinutes).toBe(120);
        expect(lo1.type).toBe('Curriculum');
    });

    test('fetchCompletions paginates and normalises snake_case transcript columns', async () => {
        const comps = await connector({}, {}, 'comp-cid').fetchCompletions(new Date('2026-05-01'));
        expect(comps).toHaveLength(2);
        expect(comps.find((c) => c.externalRef === 'T-2').score).toBe(95);
        expect(comps.find((c) => c.externalRef === 'T-1').employeeEmail).toBe('a@corp.com');
    });

    test('assignCourse posts to the transcript endpoint and returns the external ref', async () => {
        const out = await connector({}, {}, 'assign-cid').assignCourse(
            { email: 'a@corp.com' },
            'LO-1'
        );
        expect(out).toEqual({ supported: true, externalRef: 'T-NEW' });
    });

    test('normalizeWebhook handles snake_case completion payloads', () => {
        const n = connector({}, {}, 'wh-cid').normalizeWebhook({
            user_email: 'c@corp.com',
            lo_object_id: 'LO-9',
            transc_status: 'Completed',
            transc_id: 'WH-1',
            transc_comp_dt: '2026-06-20',
        });
        expect(n).toMatchObject({
            externalRef: 'WH-1',
            employeeEmail: 'c@corp.com',
            externalCourseId: 'LO-9',
            completedAt: '2026-06-20',
        });
    });

    test('ignores non-completion transcript rows', () => {
        expect(
            connector({}, {}, 'ig-cid')._normalizeTranscript({
                user_email: 'x@y.com',
                lo_object_id: 'LO-1',
                transc_status: 'InProgress',
            })
        ).toBeNull();
    });
});
