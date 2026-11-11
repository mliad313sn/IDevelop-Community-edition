'use strict';
/**
 * « À traiter » (/tasks) — everything waiting on the person, grouped by kind,
 * each line with a count, a verb and a link to a page they CAN open (its route
 * guard and its module are checked by the collector). Fed by the very collector
 * behind the bell and /api/my-actions (TalentActionsController.collectTasks),
 * so the three never disagree.
 *
 * For managers and for admins who can act. An employee's to-do list is their
 * dashboard, and a read-only account (role 'viewer') cannot act: both are sent
 * to their own home page, without an error.
 */
const { collectTasks, ACTION_KINDS } = require('./TalentActionsController');
const navigation = require('../config/navigation');

/** May this person use « À traiter »? (a manager, or an admin who is not read-only) */
function isEligible(user) {
    if (!user) return false;
    if (user.userType === 'manager') return true;
    return user.userType === 'admin' && user.role !== 'viewer';
}

/** Group the items by kind, in the fixed order of ACTION_KINDS. */
function groupItems(items) {
    const byKind = new Map();
    for (const it of items || []) {
        const kind = ACTION_KINDS.includes(it.kind) ? it.kind : 'info';
        if (!byKind.has(kind)) byKind.set(kind, []);
        byKind.get(kind).push(it);
    }
    return ACTION_KINDS.filter((k) => byKind.has(k)).map((kind) => {
        const list = byKind.get(kind);
        return {
            kind,
            items: list,
            // `info` lines are not tasks: their group carries no count.
            count: kind === 'info' ? null : list.reduce((a, i) => a + (i.info ? 0 : i.count), 0),
        };
    });
}

async function page(req, res) {
    if (!isEligible(req.user)) return res.redirect(navigation.homeUrl(req.user));
    const translate = (key, fallback, params) =>
        req.t ? req.t(key, { defaultValue: fallback, ...(params || {}) }) : fallback;
    let data = { total: 0, items: [], complete: false };
    try {
        data = await collectTasks(req.user, translate);
    } catch (_) {
        /* rendered as « could not be read », never as « nothing to do » */
    }
    res.set('Cache-Control', 'no-store');
    res.render('pages/tasks/index', {
        title: req.t ? req.t('chrome:nav_tasks') : 'Tasks',
        groups: groupItems(data.items),
        total: data.total,
        complete: data.complete !== false,
    });
}

/**
 * /action-center was the old name of the action list. Eligible people get a
 * PERMANENT redirect to « À traiter »; employees keep their dashboard (their
 * to-do), read-only accounts their own home. Fixed relative targets only.
 */
function legacyActionCenter(req, res) {
    if (isEligible(req.user)) return res.redirect(301, '/tasks');
    return res.redirect(302, navigation.homeUrl(req.user));
}

module.exports = { page, legacyActionCenter, isEligible, groupItems };
