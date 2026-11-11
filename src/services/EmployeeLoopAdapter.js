'use strict';
/**
 * EmployeeLoopAdapter — the employee's side of the development loop (4.0.0
 * port, wave 5). The employee home, « My progress » and « My development »
 * read the loop (DevelopmentLoopService, wave 4) through this thin adapter so
 * they never repeat its SQL.
 *
 * Rule: an answer that could not be established is NULL ("not available"),
 * never an empty list dressed as "nothing happened". The callers then hide
 * the block instead of printing a 0 or « nothing new » they do not know.
 *
 * What depends on the development module (src/config/modules.js): the plan
 * actions done and the development step (they point at /v2/idp). The levels
 * validated are core (assessments) and are read whatever the module says.
 */

function core() {
    try {
        return require('./DevelopmentLoopService');
    } catch (_) {
        return null;
    }
}

/** True when the development module is on (a failing read: off). */
async function available() {
    try {
        return Boolean(await require('./ModuleService').isOn('development'));
    } catch (_) {
        return false;
    }
}

async function call(fn, args) {
    const svc = core();
    if (!svc || typeof svc[fn] !== 'function') return null;
    try {
        const v = await svc[fn](...args);
        return v == null ? null : v;
    } catch (_) {
        return null;
    }
}

/** `[{skillId, skillName, from, to, at, source}]`, or null when unreadable. */
async function validatedUpliftsSince(employeeId, since) {
    const v = await call('validatedUpliftsSince', [Number(employeeId), since]);
    return Array.isArray(v) ? v : null;
}

/** `[{id, idpId, title, completedAt}]`, or null (unreadable, or the module off). */
async function actionsDoneSince(employeeId, since) {
    if (!(await available())) return null;
    const v = await call('actionsDoneSince', [Number(employeeId), since]);
    return Array.isArray(v) ? v : null;
}

/** `{available, open, awaitingValidation, overdue}`; `available: false` when unknown. */
async function actionStates(employeeId) {
    const v = await call('actionStates', [Number(employeeId)]);
    if (!v || typeof v !== 'object' || v.available === false) {
        return { available: false, open: [], awaitingValidation: null, overdue: null };
    }
    return {
        available: true,
        open: Array.isArray(v.open) ? v.open : [],
        awaitingValidation: v.awaitingValidation == null ? null : Number(v.awaitingValidation),
        overdue: v.overdue == null ? null : Number(v.overdue),
    };
}

/** `{kind, href, vars}`, or null (none, unreadable, or the module off). */
async function nextDevelopmentStep(employeeId) {
    if (!(await available())) return null;
    const v = await call('nextDevelopmentStep', [Number(employeeId)]);
    if (!v || typeof v !== 'object' || !v.kind || v.kind === 'none') return null;
    return v;
}

module.exports = {
    available,
    validatedUpliftsSince,
    actionsDoneSince,
    actionStates,
    nextDevelopmentStep,
};
