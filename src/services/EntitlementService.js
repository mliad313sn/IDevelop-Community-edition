'use strict';

/**
 * EntitlementService — the appliance-per-customer licensing layer.
 *
 * IDevelop ships as one hardened install per customer (no multi-tenancy), so
 * "licensing" here means: which customer this appliance is issued to, how many
 * seats (active employees) it covers, which feature modules are enabled, and when
 * the entitlement expires. Enforcement is deliberately SOFT — a sovereign, on-prem
 * customer must NEVER be locked out of their own data. Over-seat / expired raises a
 * banner and an audit note; a hard seat cap on NEW employee creation is opt-in only.
 *
 * The license is stored as an App Setting ('license', JSON) or the LICENSE_JSON env
 * var. With no license present the appliance is "unmanaged": everything enabled, no
 * limits, but flagged so an admin can formalise entitlement.
 */
const AppSettingsModel = require('../models/AppSettingsModel');
const db = require('../config/database');

/**
 * INVARIANT — "core never gated".
 *
 * The core talent workflows are the product. They must never sit behind an
 * entitlement check: a customer whose licence has lapsed, is over seat, or lists
 * only add-on modules keeps the full core workflow. `isFeatureEnabled()` returns
 * `true` for every slug below whatever the licence says, so a future caller that
 * wraps a core screen in an entitlement check cannot lock anyone out of it.
 * Entitlement may only gate optional add-on modules.
 *
 * Locked by tests/unit/entitlementCoreNeverGated.test.js — do not remove a slug
 * from this list without a product decision.
 */
const CORE_FEATURES = Object.freeze([
    'framework',
    'assessment',
    'readiness',
    'nine_box',
    'succession',
    'idp',
    'sso',
    'reports',
]);

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 60 * 1000;

class EntitlementService {
    _defaultLicense() {
        return {
            customer: null,
            seats: null,
            features: ['*'],
            expiresOn: null,
            issuedTo: null,
            unmanaged: true,
        };
    }

    async _license() {
        let raw = process.env.LICENSE_JSON || null;
        if (!raw) raw = await AppSettingsModel.getValue('license', null);
        if (!raw) return this._defaultLicense();
        try {
            const l = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const seats =
                l.seats === null || l.seats === undefined || l.seats === ''
                    ? null
                    : Number(l.seats);
            return {
                customer: l.customer || l.issuedTo || null,
                seats: Number.isFinite(seats) ? seats : null,
                features: Array.isArray(l.features) && l.features.length ? l.features : ['*'],
                expiresOn: l.expiresOn || l.expires || null,
                issuedTo: l.issuedTo || l.customer || null,
                unmanaged: false,
            };
        } catch {
            return this._defaultLicense();
        }
    }

    /** Cached (60s) entitlement status incl. live seat usage. Never throws. */
    async status(force = false) {
        const now = Date.now();
        if (!force && _cache && now - _cacheAt < TTL_MS) return _cache;
        const lic = await this._license();
        let seatsUsed = 0;
        try {
            const r = await db.get(
                'SELECT COUNT(*)::int AS n FROM employees WHERE is_active = true'
            );
            seatsUsed = (r && r.n) || 0;
        } catch {
            seatsUsed = 0;
        }
        const expired = lic.expiresOn ? new Date(lic.expiresOn).getTime() < now : false;
        const overSeat = lic.seats != null ? seatsUsed > lic.seats : false;
        const seatsRemaining = lic.seats != null ? Math.max(0, lic.seats - seatsUsed) : null;
        const status = {
            customer: lic.customer,
            issuedTo: lic.issuedTo,
            unmanaged: lic.unmanaged,
            seats: lic.seats,
            seatsUsed,
            seatsRemaining,
            overSeat,
            features: lic.features,
            expiresOn: lic.expiresOn,
            expired,
            valid: !expired,
            warn: !lic.unmanaged && (overSeat || expired),
        };
        _cache = status;
        _cacheAt = now;
        return status;
    }

    /** True when `slug` is a core workflow (never gated — see CORE_FEATURES). */
    isCoreFeature(slug) {
        return CORE_FEATURES.includes(String(slug || '').toLowerCase());
    }

    async isFeatureEnabled(slug) {
        // Core never gated: answered before the licence is even read, so neither an
        // expired/over-seat licence nor a restrictive feature list can disable it.
        if (this.isCoreFeature(slug)) return true;
        const s = await this.status();
        if (s.unmanaged) return true;
        return s.features.includes('*') || s.features.includes(slug);
    }

    /** Whether creating another active employee is allowed. Only blocks when the
     *  admin has explicitly turned on the hard cap AND the license is over-seat.
     *
     *  Returns a translation key (`reasonKey`) and its variables (`reasonVars`) as
     *  well as an English fallback sentence (`reason`): an HTTP caller translates
     *  the key into the session language, a caller with no request (script, job)
     *  keeps the fallback. */
    async canAddEmployee() {
        const s = await this.status();
        if (s.unmanaged || s.seats == null) return { ok: true };
        const enforce = await AppSettingsModel.getValue('enforceSeatLimit', false);
        const hard = enforce === true || enforce === 'true' || enforce === 1 || enforce === '1';
        if (hard && s.seatsUsed >= s.seats) {
            return {
                ok: false,
                reasonKey: 'flash:seat_limit_reached',
                reasonVars: { used: s.seatsUsed, seats: s.seats },
                reason: `Seat limit reached (${s.seatsUsed}/${s.seats}). Increase the licensed seats or deactivate an employee.`,
            };
        }
        return { ok: true, warn: s.overSeat };
    }

    invalidate() {
        _cache = null;
        _cacheAt = 0;
    }
}

module.exports = new EntitlementService();
module.exports.CORE_FEATURES = CORE_FEATURES;
