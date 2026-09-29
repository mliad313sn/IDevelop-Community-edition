/**
 * MovementController — the one-page movement & activity view.
 * Everything it serves is RBAC-scoped inside MovementService.
 */
const MovementService = require('../services/MovementService');
const { csvCell } = require('../utils/csvSafe');

function readFilters(req) {
    return {
        days: req.query.days || 30,
        stream: req.query.stream || '',
        kind: req.query.kind || '',
        siteName: req.query.site || '',
        departmentName: req.query.dept || '',
        q: (req.query.q || '').trim(),
        limit: req.query.limit || 200,
    };
}

const MovementController = {
    async page(req, res) {
        try {
            const filters = readFilters(req);
            const [summary, feed, options] = await Promise.all([
                MovementService.summary(req.user, filters),
                MovementService.feed(req.user, filters),
                MovementService.filterOptions(req.user, filters),
            ]);
            res.render('pages/movements/index', {
                title: req.t ? req.t('chrome:nav_movements') : 'Movements',
                summary,
                feed,
                options,
                filters,
                kinds: MovementService.KINDS,
                streams: MovementService.STREAMS,
            });
        } catch (e) {
            console.error('[movements] page failed:', e && e.message);
            req.flash(
                'error',
                req.t ? req.t('flash:generic_error') : 'Could not load the movement view.'
            );
            res.redirect('/dashboard');
        }
    },

    async api(req, res) {
        try {
            const filters = readFilters(req);
            const [summary, feed] = await Promise.all([
                MovementService.summary(req.user, filters),
                MovementService.feed(req.user, filters),
            ]);
            res.json({ summary, feed });
        } catch (e) {
            console.error('[movements] api failed:', e && e.message);
            res.status(500).json({ error: 'movement_feed_failed' });
        }
    },

    /** CSV of exactly what the page shows — same scope, same filters. */
    async exportCsv(req, res) {
        try {
            const filters = readFilters(req);
            // Everything the filter matched, not the first 500. The comment
            // above promised the page's contents; on a 30-day window with 3068
            // matching rows this silently shipped 500 and said nothing, so a
            // reconciliation done from the file was wrong AND looked complete.
            // MovementService.MAX_ROWS is the only bound.
            filters.limit = MovementService.MAX_ROWS;
            const feed = await MovementService.feed(req.user, filters);
            const head = [
                'When',
                'Stream',
                'Event',
                'Employee',
                'Number',
                'Site',
                'Department',
                'From',
                'To',
                'Skill',
                'Actor',
            ];
            // csvCell (utils/csvSafe) — the same cell writer every sibling exporter
            // uses: RFC-4180 quoting PLUS formula-injection neutralisation. The
            // private escaper here only doubled quotes, so a name or skill starting
            // with =, +, - or @ executed as a formula when the export was opened.
            const esc = csvCell;
            const lines = [head.map(esc).join(';')];
            feed.forEach((r) =>
                lines.push(
                    [
                        new Date(r.occurredAt).toISOString(),
                        r.stream,
                        r.eventKind,
                        r.employeeName,
                        r.employeeNumber,
                        r.siteName,
                        r.departmentName,
                        r.fromLabel,
                        r.toLabel,
                        r.skillName,
                        r.actorName || 'system',
                    ]
                        .map(esc)
                        .join(';')
                )
            );
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="movements-${new Date().toISOString().slice(0, 10)}.csv"`
            );
            res.send('﻿' + lines.join('\r\n'));
        } catch (e) {
            console.error('[movements] export failed:', e && e.message);
            res.status(500).send('export failed');
        }
    },
};

module.exports = MovementController;
