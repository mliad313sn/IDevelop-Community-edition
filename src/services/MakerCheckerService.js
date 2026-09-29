'use strict';

/**
 *   MakerCheckerService — two-person-rule queue.
 *   submit inserts a pending request; decide approves or rejects;
 *   on approve, the registered handler is called inside a tx.
 *
 *   Sensitive kinds are registered in src/services/maker-checker-handlers.js
 *   (Phase 2+). Unknown kinds are rejected at submit time.
 */

const db = require('../config/database');

const handlers = new Map();

/**
 * UN REFUS DE RÈGLE N'EST PAS UNE PANNE.
 *
 * `decide` refusait par un `Error` nu : pas de `status`, pas de `code`, donc
 * `asyncHandler` — qui ne reclasse un refus que sur `status` 4xx + `expose` —
 * rendait un **500** pour trois refus parfaitement légitimes. Le cas mesuré sans
 * rien forger : deux administrateurs sur la file, A décide, B clique le bouton
 * que sa page affiche encore → « Request already applied » en 500, avec une
 * ligne `REQUEST_ERROR` / severity `error` en journal. La RÈGLE, elle, tenait
 * déjà (aucune écriture) : seul le statut était faux.
 *
 * Chaque refus porte désormais le statut que son sens impose — 404 absente,
 * 403 règle des quatre yeux, 409 déjà décidée — plus un code stable que la
 * route traduit (FR/EN). Ce qui reste un `Error` nu ici (type inconnu, aucun
 * gestionnaire enregistré, panne du gestionnaire) reste un 500 : ce sont de
 * vraies fautes, et les annoncer autrement serait mentir dans l'autre sens.
 */
function refuse(code, status, message, extra) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    e.expose = true;
    return Object.assign(e, extra || {});
}

class MakerCheckerService {
    static register(kind, handler) {
        if (handlers.has(kind)) throw new Error(`Maker-checker kind already registered: ${kind}`);
        handlers.set(kind, handler);
    }

    static knows(kind) {
        return handlers.has(kind);
    }

    /** Registered kinds — the queue's "kind" filter is built from this, never
     *  from a hand-written list that could drift. */
    static kinds() {
        return [...handlers.keys()].sort();
    }

    static async submit({ kind, payload, makerId }) {
        if (!handlers.has(kind)) throw new Error(`Unknown maker-checker kind: ${kind}`);
        const { lastID } = await db.run(
            `INSERT INTO maker_checker_requests (kind, payload, maker_id)
             VALUES (?, ?, ?)`,
            [kind, JSON.stringify(payload), makerId]
        );
        // Notify the approver audience that an action awaits their decision. The
        // decide route is requireSuperAdmin, so the approvers are the superadmins
        // (excluding the maker — a maker cannot be their own checker). Best-effort:
        // never let a notification failure block the submission. This is a CRITICAL
        // kind → emails immediately (an approval that no one sees blocks the org).
        MakerCheckerService._notifyApprovers(kind, makerId).catch(() => {});
        return lastID;
    }

    static async _notifyApprovers(kind, makerId) {
        try {
            const NotificationService = require('./NotificationService');
            const approvers = await db.all(
                "SELECT id FROM admins WHERE role = 'superadmin' AND COALESCE(is_active, true) = true AND id <> ?",
                [Number(makerId) || -1]
            );
            for (const a of approvers) {
                await NotificationService.notify({
                    userType: 'admin',
                    userId: Number(a.id),
                    kind: 'mc.submitted',
                    category: 'validation',
                    payload: {
                        request: kind,
                        link: '/v2/uam/maker-checker/queue',
                        cta: 'Examiner la demande / Review request',
                    },
                }).catch(() => {});
            }
        } catch (_) {
            /* never block submit on notification */
        }
    }

    static async decide({ id, checkerId, approve, reason }) {
        const r = await db.get(
            `SELECT id, kind, payload, maker_id, state
             FROM maker_checker_requests WHERE id = ?`,
            [id]
        );
        // statuts honnêtes (voir `refuse` en tête de fichier).
        if (!r) throw refuse('mc_not_found', 404, 'Maker-checker request not found');
        if (r.state !== 'pending') {
            throw refuse('mc_already_decided', 409, `Request already ${r.state}`, {
                mcState: r.state,
            });
        }
        if (Number(r.makerId ?? r.maker_id) === Number(checkerId)) {
            throw refuse('mc_maker_is_checker', 403, 'Maker cannot be checker');
        }

        const makerId = Number(r.makerId ?? r.maker_id);

        if (!approve) {
            // Guard the transition on state='pending' (like the approve branch) and
            // check the rowcount so two concurrent checkers can't both act, and an
            // in-flight-approved request can't be flipped to rejected.
            const { changes } = await db.run(
                `UPDATE maker_checker_requests
                 SET state = 'rejected', checker_id = ?, decided_at = now(), reason = ?
                 WHERE id = ? AND state = 'pending'`,
                [checkerId, reason || null, id]
            );
            // même refus que la garde d'entrée, vu une milliseconde plus
            // tard : un autre vérificateur a décidé entre la lecture et l'écriture.
            // C'est un 409, pas une panne. (Rien n'a été écrit : `changes` = 0.)
            if (!changes)
                throw refuse('mc_already_decided', 409, 'Maker-checker request already processed');
            // Notify the maker their submission was rejected (fire-and-forget).
            await require('./NotificationService')
                .notify({
                    userType: 'admin',
                    userId: makerId,
                    kind: 'mc.rejected',
                    category: 'validation',
                    payload: { request: r.kind, reason: reason || '(no reason given)' },
                })
                .catch(() => {});
            return { state: 'rejected' };
        }

        // Approve → run handler in a transaction
        const handler = handlers.get(r.kind);
        if (!handler) throw new Error(`No handler for kind: ${r.kind}`);

        try {
            await db.runTransaction(async () => {
                // Guard the transition on state='pending' + rowcount so two
                // concurrent checkers can't both approve (and double-run handler).
                const { changes } = await db.run(
                    `UPDATE maker_checker_requests
                     SET state = 'approved', checker_id = ?, decided_at = now(), reason = ?
                     WHERE id = ? AND state = 'pending'`,
                    [checkerId, reason || null, id]
                );
                if (!changes) throw new Error('Maker-checker request already processed');
                await handler({ payload: r.payload, makerId: r.makerId ?? r.maker_id, checkerId });
                await db.run(
                    `UPDATE maker_checker_requests
                     SET state = 'applied', applied_at = now()
                     WHERE id = ?`,
                    [id]
                );
            });
            // Notify the maker their submission was approved & applied (fire-and-forget).
            await require('./NotificationService')
                .notify({
                    userType: 'admin',
                    userId: makerId,
                    kind: 'mc.approved',
                    category: 'validation',
                    payload: { request: r.kind },
                })
                .catch(() => {});
            return { state: 'applied' };
        } catch (e) {
            await db.run(
                `UPDATE maker_checker_requests
                 SET state = 'failed', error = ?
                 WHERE id = ?`,
                [String(e.message || e), id]
            );
            throw e;
        }
    }
}

module.exports = MakerCheckerService;
