'use strict';

const db = require('../config/database');

/**
 *   CoachingService — schedule sessions, GROW notes, SMART objectives,
 *   auto-carry-forward of open objectives into the next session.
 */
class CoachingService {
    // A stand-alone session must declare a context (IDP / PIP / skill gap);
    // a plan-linked session (planId) inherits the plan's context.
    static async _resolveContext({ employeeId, planId, contextType, idpId, pipId, skillId }) {
        const ctx = { contextType: null, idpId: null, pipId: null, skillId: null };
        if (planId) return ctx; // inherited from the plan
        if (!['idp', 'pip', 'skill_gap'].includes(contextType)) {
            throw new Error(
                'A coaching session must be linked to a plan or a context: an IDP, a PIP, or a skill gap'
            );
        }
        if (contextType === 'idp') {
            const r = await db.get('SELECT employee_id FROM idp_plans WHERE id = ?', [idpId]);
            if (!r) throw new Error('Selected IDP not found');
            if (Number(r.employeeId) !== Number(employeeId))
                throw new Error('IDP does not belong to this employee');
            ctx.idpId = Number(idpId);
        } else if (contextType === 'pip') {
            const r = await db.get('SELECT employee_id FROM pips WHERE id = ?', [pipId]);
            if (!r) throw new Error('Selected PIP not found');
            if (Number(r.employeeId) !== Number(employeeId))
                throw new Error('PIP does not belong to this employee');
            ctx.pipId = Number(pipId);
        } else {
            const r = await db.get('SELECT id FROM skills WHERE id = ?', [skillId]);
            if (!r) throw new Error('Selected skill not found');
            ctx.skillId = Number(skillId);
        }
        ctx.contextType = contextType;
        return ctx;
    }

    static async createSession({
        employeeId,
        coachId,
        kind,
        sessionAt,
        agenda,
        planId,
        contextType,
        idpId,
        pipId,
        skillId,
    }) {
        const ctx = await this._resolveContext({
            employeeId,
            planId,
            contextType,
            idpId,
            pipId,
            skillId,
        });
        const r = await db.run(
            `INSERT INTO coaching_sessions (employee_id, coach_id, kind, session_at, agenda, plan_id, context_type, idp_id, pip_id, skill_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                employeeId,
                coachId,
                kind,
                sessionAt,
                agenda,
                planId || null,
                ctx.contextType,
                ctx.idpId,
                ctx.pipId,
                ctx.skillId,
            ]
        );
        // Bootstrap empty GROW row.
        await db.run(`INSERT INTO coaching_grow (session_id) VALUES (?)`, [r.lastID]);
        // Carry-forward: copy open objectives from the previous session.
        const prev = await db.get(
            `SELECT id FROM coaching_sessions
             WHERE employee_id = ? AND id <> ?
             ORDER BY session_at DESC LIMIT 1`,
            [employeeId, r.lastID]
        );
        if (prev) {
            const open = await db.all(
                `SELECT id, smart_text, due_on FROM coaching_objectives
                 WHERE session_id = ? AND state IN ('pending', 'in_progress')`,
                [prev.id]
            );
            for (const o of open) {
                await db.run(
                    `INSERT INTO coaching_objectives (session_id, smart_text, due_on, state, carry_forward_of)
                     VALUES (?, ?, ?, 'pending', ?)`,
                    [r.lastID, o.smartText ?? null, o.dueOn ?? null, o.id]
                );
            }
        }
        return r.lastID;
    }

    static async upsertGrow({ sessionId, goal, reality, options, wayForward }) {
        await db.run(
            `UPDATE coaching_grow SET goal = ?, reality = ?, options = ?, way_forward = ?
             WHERE session_id = ?`,
            [goal, reality, options, wayForward, sessionId]
        );
    }

    static async signOff({ sessionId, role, userId, ip, ua }) {
        await db.run(
            `INSERT INTO coaching_signoffs (session_id, role, user_id, ip, ua)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (session_id, role) DO NOTHING`,
            [sessionId, role, userId, ip, ua || null]
        );
    }
}

module.exports = CoachingService;
