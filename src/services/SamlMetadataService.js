'use strict';
/**
 * SAML metadata, both directions (SSO facilitator, phase 1).
 *
 *   OUT — the values an IdP administrator pastes (Entity ID, Reply/ACS URL,
 *         Sign-on URL) and the SP metadata XML published at /saml/metadata,
 *         the address the settings page has always told admins to use.
 *   IN  — the IdP's federation metadata (URL or pasted XML): entity ID, SSO
 *         URL and EVERY signing certificate, so a certificate rotation on the
 *         IdP side no longer breaks sign-in (node-saml accepts an array).
 *
 * Fetching a URL server-side from an appliance on a corporate network is an
 * SSRF surface: https only, no redirects, 10 s / 1 MB caps, and the resolved
 * address must be public unless SSO_METADATA_ALLOW_PRIVATE=1 — checked on the
 * address actually connected to (the lookup is pinned, so DNS rebinding cannot
 * swap it between the check and the request).
 *
 * @module services/SamlMetadataService
 */
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10000;
const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

// ---------------------------------------------------------------------------
// OUT — what we publish
// ---------------------------------------------------------------------------

/**
 * The values an IdP admin pastes, built from the TRUSTED base URL (never the
 * raw Host header) unless an explicit value is configured.
 * @param {string} base  e.g. https://idevelop.example.com (no trailing slash)
 * @param {{issuer?:string, callbackUrl?:string}} [configured]
 */
function spValues(base, configured = {}) {
    const b = String(base || '').replace(/\/+$/, '');
    return {
        entityId: configured.issuer || `${b}/saml/metadata`,
        // ALWAYS the canonical ACS. The page used to echo the configured value,
        // so a mistyped reply URL (e.g. ".../auth/saml/saml/callback") was handed
        // back to the operator as the value to paste into the IdP. A configured
        // value that differs is named by the SSO page's mismatch warning instead
        // (SsoSettingsController.callbackMismatch).
        acsUrl: `${b}/auth/sso/saml/callback`,
        signOnUrl: `${b}/auth/sso/saml`,
        metadataUrl: `${b}/saml/metadata`,
        // Claims the app reads (config/sso.js SAML_CLAIMS), as named in Entra.
        claims: [
            // Unique User Identifier (Name ID): the app treats the e-mail as
            // verified only when the NameID IS that address — Entra's default
            // (user.userprincipalname) silently breaks e-mail matching wherever the
            // UPN differs from the mailbox.
            { name: 'nameid', source: 'user.mail', required: true, nameId: true },
            {
                name: 'http://schemas.microsoft.com/identity/claims/objectidentifier',
                source: 'user.objectid',
                required: true,
                entraDefault: true,
            },
            {
                name: 'http://schemas.microsoft.com/identity/claims/tenantid',
                source: 'user.tenantid',
                required: true,
                entraDefault: true,
            },
            {
                name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
                source: 'user.mail',
                required: true,
            },
            {
                name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
                source: 'user.userprincipalname',
                required: true,
            },
            { name: 'employeeid', source: 'user.employeeid', required: false },
        ],
    };
}

/** SP metadata XML (unsigned; no SP key pair until phase 2). */
function spMetadataXml(base, configured = {}) {
    // Re-exported by the declared dependency (node-saml itself is transitive).
    const { generateServiceProviderMetadata } = require('@node-saml/passport-saml');
    const v = spValues(base, configured);
    return generateServiceProviderMetadata({
        issuer: v.entityId,
        callbackUrl: v.acsUrl,
        identifierFormat: configured.identifierFormat || NAMEID_EMAIL,
        wantAssertionsSigned: true,
    });
}

// ---------------------------------------------------------------------------
// IN — reading the IdP's metadata
// ---------------------------------------------------------------------------

/** Normalise a certificate to its bare base64 body. */
function certBody(c) {
    return String(c || '')
        .replace(/-----BEGIN CERTIFICATE-----/g, '')
        .replace(/-----END CERTIFICATE-----/g, '')
        .replace(/\s+/g, '');
}

/** Split a stored cert value (one or several PEM blocks, or one bare body) into bodies. */
function splitCerts(value) {
    const s = String(value || '').trim();
    if (!s) return [];
    const blocks = s.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    const bodies = blocks ? blocks.map(certBody) : [certBody(s)];
    return [...new Set(bodies.filter(Boolean))];
}

function toPem(body) {
    const lines = certBody(body).match(/.{1,64}/g) || [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

/** Fingerprint + validity of one certificate body (null fields if unreadable). */
function describeCert(body) {
    const b = certBody(body);
    const out = { body: b, sha256: null, notAfter: null, subject: null };
    try {
        const der = Buffer.from(b, 'base64');
        out.sha256 = crypto
            .createHash('sha256')
            .update(der)
            .digest('hex')
            .toUpperCase()
            .match(/.{2}/g)
            .join(':');
        const x = new crypto.X509Certificate(der);
        out.notAfter = x.validTo;
        out.subject = x.subject;
    } catch (_) {
        /* reported as unreadable by the caller */
    }
    return out;
}

/**
 * Parse IdP metadata XML. DTDs/entities refused. Accepts an EntityDescriptor
 * or an EntitiesDescriptor (takes the first entity with an IDPSSODescriptor).
 * @returns {{ok:true, entityId:string, ssoUrl:string, sloUrl:string|null, certs:Array}|{ok:false, code:string}}
 */
function parseIdpMetadata(xml) {
    const s = String(xml || '');
    if (!s.trim()) return { ok: false, code: 'ssof_md_empty' };
    if (s.length > MAX_BYTES) return { ok: false, code: 'ssof_md_too_big' };
    if (/<!DOCTYPE|<!ENTITY/i.test(s)) return { ok: false, code: 'ssof_md_dtd' };
    const { XMLParser } = require('fast-xml-parser');
    let doc;
    try {
        doc = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            removeNSPrefix: true,
            processEntities: false,
            parseTagValue: false,
            parseAttributeValue: false,
            isArray: (name) =>
                [
                    'EntityDescriptor',
                    'SingleSignOnService',
                    'SingleLogoutService',
                    'KeyDescriptor',
                    'X509Certificate',
                    'IDPSSODescriptor',
                ].includes(name),
        }).parse(s);
    } catch (_) {
        return { ok: false, code: 'ssof_md_unreadable' };
    }
    const entities =
        doc.EntityDescriptor ||
        (doc.EntitiesDescriptor && doc.EntitiesDescriptor.EntityDescriptor) ||
        [];
    const ent = entities.find((e) => e && e.IDPSSODescriptor);
    if (!ent) return { ok: false, code: 'ssof_md_no_idp' };
    const idp = ent.IDPSSODescriptor[0];
    const pick = (list, binding) =>
        (list || []).find((x) => String(x['@_Binding'] || '').endsWith(binding));
    const sso =
        pick(idp.SingleSignOnService, 'HTTP-Redirect') ||
        pick(idp.SingleSignOnService, 'HTTP-POST');
    const slo =
        pick(idp.SingleLogoutService, 'HTTP-Redirect') ||
        pick(idp.SingleLogoutService, 'HTTP-POST');
    const bodies = [];
    for (const kd of idp.KeyDescriptor || []) {
        const use = String(kd['@_use'] || 'signing');
        if (use !== 'signing') continue;
        const x509 = kd.KeyInfo && kd.KeyInfo.X509Data;
        const datas = Array.isArray(x509) ? x509 : [x509];
        for (const d of datas)
            for (const c of (d && d.X509Certificate) || []) {
                const b = certBody(typeof c === 'object' ? c['#text'] : c);
                if (b && !bodies.includes(b)) bodies.push(b);
            }
    }
    if (!ent['@_entityID'] || !sso || !sso['@_Location'])
        return { ok: false, code: 'ssof_md_incomplete' };
    if (!bodies.length) return { ok: false, code: 'ssof_md_no_cert' };
    const certs = bodies.map(describeCert);
    if (certs.some((c) => !c.sha256)) return { ok: false, code: 'ssof_md_bad_cert' };
    return {
        ok: true,
        entityId: String(ent['@_entityID']),
        ssoUrl: String(sso['@_Location']),
        sloUrl: slo ? String(slo['@_Location']) : null,
        certs,
    };
}

/** True for loopback, link-local, private, CGNAT, ULA, unspecified and metadata addresses. */
function isPrivateAddress(ip) {
    // Every IPv4/IPv6 special-purpose range, via Node's BlockList (covers the
    // forms the explicit checks below miss: NAT64, 6to4, IPv4-compatible,
    // deprecated site-local, benchmarking, the full-length mapped form…).
    // One list PER FAMILY: a single BlockList also tests an IPv4 address against
    // IPv6 rules in mapped form, so '::ffff:0:0/96' flagged every IPv4 address.
    try {
        const fam = net.isIP(ip);
        if (fam === 4) {
            const v4 = new net.BlockList();
            for (const [a, p] of [
                ['0.0.0.0', 8],
                ['10.0.0.0', 8],
                ['100.64.0.0', 10],
                ['127.0.0.0', 8],
                ['169.254.0.0', 16],
                ['172.16.0.0', 12],
                ['192.0.0.0', 24],
                ['192.168.0.0', 16],
                ['198.18.0.0', 15],
                ['224.0.0.0', 3],
            ])
                v4.addSubnet(a, p, 'ipv4');
            if (v4.check(ip, 'ipv4')) return true;
        } else if (fam === 6) {
            const low = ip.toLowerCase();
            // IPv4-mapped / IPv4-compatible: judge the embedded IPv4 address.
            const m = /^(?:0*:){0,5}(?:0*:)?(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/.exec(
                low.replace(/^::/, '0:')
            );
            if (m) return isPrivateAddress(m[1]);
            const v6 = new net.BlockList();
            for (const [a, p] of [
                ['::', 96],
                ['::ffff:0:0', 96],
                ['64:ff9b::', 96],
                ['100::', 64],
                ['2002::', 16],
                ['fc00::', 7],
                ['fe80::', 10],
                ['fec0::', 10],
                ['ff00::', 8],
            ])
                v6.addSubnet(a, p, 'ipv6');
            if (v6.check(ip, 'ipv6')) return true;
        }
    } catch (_) {
        /* fall through to the explicit checks */
    }
    const v = net.isIP(ip);
    if (v === 4) {
        const [a, b] = ip.split('.').map(Number);
        return (
            a === 10 ||
            a === 127 ||
            a === 0 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||
            a >= 224
        );
    }
    if (v === 6) {
        const s = ip.toLowerCase();
        if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
        return (
            s === '::' ||
            s === '::1' ||
            s.startsWith('fc') ||
            s.startsWith('fd') ||
            s.startsWith('fe8') ||
            s.startsWith('fe9') ||
            s.startsWith('fea') ||
            s.startsWith('feb') ||
            s.startsWith('ff')
        );
    }
    return true;
}

/**
 * Fetch IdP metadata over https with the SSRF guards above.
 * @returns {Promise<{ok:true, xml:string}|{ok:false, code:string}>}
 */
async function fetchMetadata(
    url,
    { allowPrivate = process.env.SSO_METADATA_ALLOW_PRIVATE === '1' } = {}
) {
    let u;
    try {
        u = new URL(String(url || '').trim());
    } catch (_) {
        return { ok: false, code: 'ssof_md_bad_url' };
    }
    if (u.protocol !== 'https:') return { ok: false, code: 'ssof_md_https_only' };
    if (u.username || u.password) return { ok: false, code: 'ssof_md_bad_url' };
    let addrs;
    try {
        addrs = await dns.promises.lookup(u.hostname, { all: true, verbatim: true });
    } catch (_) {
        return { ok: false, code: 'ssof_md_dns' };
    }
    if (!addrs.length) return { ok: false, code: 'ssof_md_dns' };
    if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address)))
        return { ok: false, code: 'ssof_md_private' };
    const pinned = addrs[0];
    const https = require('https');
    return new Promise((resolve) => {
        const req = https.get(
            u,
            {
                timeout: TIMEOUT_MS,
                headers: { Accept: 'application/samlmetadata+xml, application/xml, text/xml' },
                // Connect to the address that was CHECKED, never a fresh lookup.
                // Node >= 22 (autoSelectFamily) calls lookup with {all:true} and wants
                // an array: the single-address form made every URL fetch fail.
                lookup: (_host, opts, cb) =>
                    opts && opts.all
                        ? cb(null, [{ address: pinned.address, family: pinned.family }])
                        : cb(null, pinned.address, pinned.family),
            },
            (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400) {
                    res.resume();
                    return resolve({ ok: false, code: 'ssof_md_redirect' });
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return resolve({ ok: false, code: 'ssof_md_http', status: res.statusCode });
                }
                let size = 0;
                const chunks = [];
                res.on('data', (c) => {
                    size += c.length;
                    if (size > MAX_BYTES) {
                        req.destroy();
                        resolve({ ok: false, code: 'ssof_md_too_big' });
                    } else chunks.push(c);
                });
                res.on('end', () =>
                    resolve({ ok: true, xml: Buffer.concat(chunks).toString('utf8') })
                );
            }
        );
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, code: 'ssof_md_timeout' });
        });
        req.on('error', () => resolve({ ok: false, code: 'ssof_md_unreachable' }));
    });
}

/**
 * What changes if this metadata is applied: certificates added and removed
 * relative to what is configured now. A changed signing certificate is never
 * applied silently — the caller must confirm.
 */
function certDiff(currentValue, parsed) {
    const current = splitCerts(currentValue).map(describeCert);
    const incoming = parsed.certs;
    const curSet = new Set(current.map((c) => c.body));
    const inSet = new Set(incoming.map((c) => c.body));
    return {
        current,
        added: incoming.filter((c) => !curSet.has(c.body)),
        removed: current.filter((c) => !inSet.has(c.body)),
        needsConfirmation: current.length > 0 && incoming.some((c) => !curSet.has(c.body)),
    };
}

module.exports = {
    spValues,
    spMetadataXml,
    parseIdpMetadata,
    fetchMetadata,
    certDiff,
    splitCerts,
    toPem,
    describeCert,
    certBody,
    isPrivateAddress,
    NAMEID_EMAIL,
};
