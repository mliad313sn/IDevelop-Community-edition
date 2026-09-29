'use strict';

/**
 * « Qualité du référentiel » (3.23.21, D12/D13) — HR tools for skill
 * descriptions and level anchors. Read: view_domains_skills. Every write:
 * manage_domains_skills (enforced on the routes). Nothing here adds or removes
 * a skill.
 */
const SkillDescriptionService = require('../services/SkillDescriptionService');

const toId = (raw) => {
    const n = Number(String(raw ?? '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
};
const t = (req, k, o) => (req.t ? req.t(k, o) : k);
const back = (res) => res.redirect('/framework/quality');

function flashError(req, e) {
    const code = e && e.code ? e.code : 'error';
    const known = [
        'proposal_empty',
        'proposal_not_open',
        'reason_required',
        'text_too_long',
        'anchor_too_long',
        'starter_file_missing',
        'starter_file_invalid',
    ];
    if (!known.includes(code)) console.error('Skill quality:', e);
    req.flash(
        'error',
        t(req, known.includes(code) ? `framework:sq_err_${code}` : 'framework:sq_err_generic')
    );
}

class SkillQualityController {
    async page(req, res) {
        try {
            const status = ['proposed', 'approved', 'rejected'].includes(req.query.status)
                ? req.query.status
                : 'proposed';
            const [quality, proposals, openCount] = await Promise.all([
                SkillDescriptionService.qualityReport(),
                SkillDescriptionService.listProposals(status),
                SkillDescriptionService.countOpenProposals(),
            ]);
            res.render('pages/framework/quality', {
                title: t(req, 'framework:sq_title'),
                quality,
                proposals,
                openCount,
                status,
                starterAvailable: require('fs').existsSync(SkillDescriptionService.STARTER_FILE),
            });
        } catch (e) {
            console.error('Skill quality page:', e);
            req.flash('error', t(req, 'framework:sq_err_generic'));
            res.redirect('/domains-skills');
        }
    }

    async loadStarter(req, res) {
        try {
            const r = await SkillDescriptionService.loadStarter({ actor: req.user });
            req.flash(
                'success',
                t(req, 'framework:sq_starter_done', {
                    inserted: r.inserted,
                    described: r.skippedDescribed,
                    existing: r.skippedExisting,
                    unmatched: r.unmatched.length,
                })
            );
        } catch (e) {
            flashError(req, e);
        }
        back(res);
    }

    async update(req, res) {
        const id = toId(req.params.id);
        if (!id) return back(res);
        try {
            await SkillDescriptionService.updateProposal(
                id,
                { textFr: req.body.textFr, textEn: req.body.textEn },
                req.user
            );
            req.flash('success', t(req, 'framework:sq_saved'));
        } catch (e) {
            flashError(req, e);
        }
        back(res);
    }

    async approve(req, res) {
        const id = toId(req.params.id);
        if (!id) return back(res);
        try {
            await SkillDescriptionService.approve(id, req.user);
            req.flash('success', t(req, 'framework:sq_approved'));
        } catch (e) {
            flashError(req, e);
        }
        back(res);
    }

    async reject(req, res) {
        const id = toId(req.params.id);
        if (!id) return back(res);
        try {
            await SkillDescriptionService.reject(id, req.body.reason, req.user);
            req.flash('success', t(req, 'framework:sq_rejected'));
        } catch (e) {
            flashError(req, e);
        }
        back(res);
    }

    /** Bulk approval needs an explicit confirmation box ticked in the form. */
    async bulkApprove(req, res) {
        if (String(req.body.confirm || '') !== '1') {
            req.flash('error', t(req, 'framework:sq_err_confirm_required'));
            return back(res);
        }
        const raw = req.body.ids;
        const ids = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(toId).filter(Boolean);
        if (!ids.length) {
            req.flash('error', t(req, 'framework:sq_err_none_selected'));
            return back(res);
        }
        try {
            const r = await SkillDescriptionService.bulkApprove(ids, req.user);
            req.flash(
                'success',
                t(req, 'framework:sq_bulk_done', { approved: r.approved, skipped: r.skipped })
            );
        } catch (e) {
            flashError(req, e);
        }
        back(res);
    }

    async exportXlsx(req, res) {
        try {
            const buf = await SkillDescriptionService.exportWorkbook();
            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader('Content-Disposition', 'attachment; filename="skill-texts.xlsx"');
            res.send(Buffer.from(buf));
        } catch (e) {
            console.error('Skill texts export:', e);
            req.flash('error', t(req, 'framework:sq_err_generic'));
            back(res);
        }
    }

    /** JSON answer: the page posts the file with fetch + x-csrf-token. */
    async importXlsx(req, res) {
        if (!req.file || !req.file.buffer)
            return res.status(400).json({ ok: false, code: 'no_file' });
        try {
            const r = await SkillDescriptionService.importWorkbook(req.file.buffer, req.user);
            res.json({
                ok: true,
                message: t(req, 'framework:sq_import_done', {
                    rows: r.rows,
                    updated: r.skillsUpdated,
                    unmatched: r.unmatched.length,
                    errors: r.errors.length,
                }),
                report: r,
            });
        } catch (e) {
            const KNOWN = [
                'workbook_unreadable',
                'workbook_empty',
                'workbook_missing_columns',
                'workbook_too_large',
            ];
            const code = e && KNOWN.includes(e.code) ? e.code : 'generic';
            if (code === 'generic') console.error('Skill texts import:', e);
            res.status(code === 'generic' ? 500 : 400).json({
                ok: false,
                code,
                message: t(req, `framework:sq_err_${code}`),
            });
        }
    }
}

module.exports = new SkillQualityController();
