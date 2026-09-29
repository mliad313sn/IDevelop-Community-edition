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

    async isFeatureEnabled(slug) {
        const s = await this.status();
        if (s.unmanaged) return true;
        return s.features.includes('*') || s.features.includes(slug);
    }

    /** Whether creating another active employee is allowed. Only blocks when the
     *  admin has explicitly turned on the hard cap AND the license is over-seat.
     *
     *  LANGUE — mesuré le 16/09/2026 : `reason` est une phrase ANGLAISE en dur, et
     *  c'est elle que /employees/create affichait, y compris en session française
     *  (la clé de repli citée par le contrôleur, flash:seat_limit_reached,
     *  n'existait dans AUCUN des deux catalogues et sortait telle quelle).
     *  On rend donc aussi la clé et ses variables : un appelant HTTP traduit,
     *  un appelant sans requête (script, job) garde la phrase de repli. */
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
