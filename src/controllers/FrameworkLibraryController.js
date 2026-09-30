'use strict';

/**
 * Skills library (/framework/library): ready-made sector packs and the ESCO
 * import, both through the same dry run → confirm flow of
 * FrameworkPackService. Every route is gated on manage_domains_skills
 * (SuperAdmins hold it implicitly), see src/routes/index.js.
 */
const FrameworkPackService = require('../services/FrameworkPackService');
const EscoImportService = require('../services/EscoImportService');

const t = (req, k, o) => (req.t ? req.t(k, o) : k);
const langOf = (req) => (String(req.language || req.lng || 'fr').startsWith('en') ? 'en' : 'fr');
const nameLang = (raw, req) => (raw === 'en' || raw === 'fr' ? raw : langOf(req));
const back = (res, tab) =>
    res.redirect(`/framework/library?tab=${tab === 'esco' ? 'esco' : 'packs'}`);

/** Literal keys only (the static-key test reads them). */
function kindLabels(req) {
    return {
        pillars: t(req, 'framework:lib_kind_pillars'),
        'sub-domains': t(req, 'framework:lib_kind_subdomains'),
        skills: t(req, 'framework:lib_kind_skills'),
        'level anchors': t(req, 'framework:lib_kind_anchors'),
        'role families': t(req, 'framework:lib_kind_families'),
        'family links': t(req, 'framework:lib_kind_family_links'),
        roles: t(req, 'framework:lib_kind_roles'),
        'role requirements': t(req, 'framework:lib_kind_requirements'),
    };
}

function escoErrorMessage(req, e) {
    switch (e && e.code) {
        case 'esco_missing_files':
            return t(req, 'framework:lib_esco_err_missing', {
                files: (e.missing || []).join(', '),
            });
        case 'esco_zip_refused':
            return t(req, 'framework:lib_esco_err_zip');
        case 'esco_bad_csv':
            return t(req, 'framework:lib_esco_err_csv', { detail: e.detail || '' });
        case 'esco_bad_columns':
            return t(req, 'framework:lib_esco_err_columns', { detail: e.detail || '' });
        case 'esco_no_skills':
            return t(req, 'framework:lib_esco_err_empty');
        case 'no_file':
            return t(req, 'framework:lib_esco_err_no_file');
        default:
            return t(req, 'framework:lib_err_generic');
    }
}

function escoState(req) {
    const s = req.session && req.session.escoUpload;
    if (!s || !s.token) return null;
    const stored = EscoImportService.fetchStored(s.token);
    if (!stored) {
        delete req.session.escoUpload;
        return null;
    }
    return { session: s, stored };
}

class FrameworkLibraryController {
    constructor() {
        // Handlers are passed to the router detached from the instance.
        for (const k of Object.getOwnPropertyNames(FrameworkLibraryController.prototype)) {
            if (k !== 'constructor' && typeof this[k] === 'function') this[k] = this[k].bind(this);
        }
    }

    async render(req, res, extra = {}) {
        const lang = langOf(req);
        const tab = extra.tab || (req.query.tab === 'esco' ? 'esco' : 'packs');
        const packs = FrameworkPackService.listPacks();
        const previewId =
            extra.previewId || (typeof req.query.pack === 'string' ? req.query.pack : null);
        const previewPack = previewId ? FrameworkPackService.getPack(previewId) : null;
        const esco = escoState(req);
        let history = [];
        try {
            history = await FrameworkPackService.history(10);
        } catch (e) {
            console.error('Skills library history:', e.message);
        }
        res.render('pages/framework/library', {
            title: t(req, 'framework:lib_title'),
            tab,
            uiLang: lang,
            packs,
            preview: previewPack
                ? {
                      id: previewPack.id,
                      title: (previewPack.title || {})[lang] || previewPack.name,
                      tree: FrameworkPackService.preview(previewPack, lang),
                  }
                : null,
            report: extra.report || null,
            kindLabels: kindLabels(req),
            kinds: FrameworkPackService.KINDS,
            esco: esco
                ? {
                      files: esco.stored.files || [],
                      skills: esco.stored.skills || 0,
                      hasFrench: !!esco.stored.hasFrench,
                      storedAt: esco.stored.storedAt,
                      groups: EscoImportService.groupsOf(esco.stored.fw),
                      selected: (esco.session.selection && esco.session.selection.keys) || [],
                      limit:
                          (esco.session.selection && esco.session.selection.limit) ||
                          EscoImportService.DEFAULT_LIMIT,
                      nameLang: (esco.session.selection && esco.session.selection.lang) || lang,
                  }
                : null,
            escoMaxLimit: EscoImportService.MAX_LIMIT,
            escoAttribution: EscoImportService.ESCO_ATTRIBUTION,
            escoUrl: EscoImportService.ESCO_URL,
            history,
        });
    }

    async page(req, res) {
        try {
            await this.render(req, res);
        } catch (e) {
            console.error('Skills library page:', e);
            req.flash('error', t(req, 'framework:lib_err_generic'));
            res.redirect('/domains-skills');
        }
    }

    // ---- Sector packs ----------------------------------------------------
    async packDryRun(req, res) {
        const fw = FrameworkPackService.getPack(req.params.id);
        if (!fw) {
            req.flash('error', t(req, 'framework:lib_err_unknown_pack'));
            return back(res, 'packs');
        }
        try {
            const lang = nameLang(req.body.lang, req);
            const report = await FrameworkPackService.dryRun(fw, { lang });
            await this.render(req, res, {
                tab: 'packs',
                previewId: fw.id,
                report: {
                    kind: 'pack',
                    id: fw.id,
                    title: (fw.title || {})[langOf(req)] || fw.name,
                    lang,
                    ...report,
                    totalNew: FrameworkPackService.totalCreated(report),
                },
            });
        } catch (e) {
            console.error('Pack dry run:', e);
            req.flash('error', t(req, 'framework:lib_err_generic'));
            back(res, 'packs');
        }
    }

    async packCommit(req, res) {
        const fw = FrameworkPackService.getPack(req.params.id);
        if (!fw) {
            req.flash('error', t(req, 'framework:lib_err_unknown_pack'));
            return back(res, 'packs');
        }
        if (String(req.body.confirm || '') !== '1') {
            req.flash('error', t(req, 'framework:lib_err_confirm'));
            return back(res, 'packs');
        }
        try {
            const report = await FrameworkPackService.commit(fw, {
                lang: nameLang(req.body.lang, req),
                actor: req.user,
                source: `pack:${fw.id}`,
                action: 'FRAMEWORK_PACK_IMPORTED',
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : null,
            });
            req.flash(
                'success',
                t(req, 'framework:lib_done', {
                    created: FrameworkPackService.totalCreated(report),
                    skills: report.stats.skills.created,
                    roles: report.stats.roles.created,
                })
            );
        } catch (e) {
            console.error('Pack import:', e);
            req.flash('error', t(req, 'framework:lib_err_generic'));
        }
        back(res, 'packs');
    }

    // ---- ESCO ------------------------------------------------------------
    /** JSON answer: the page posts the files with fetch + x-csrf-token. */
    async escoUpload(req, res) {
        const files = (req.files || []).map((f) => ({
            originalname: f.originalname,
            buffer: f.buffer,
        }));
        if (!files.length)
            return res
                .status(400)
                .json({ ok: false, message: escoErrorMessage(req, { code: 'no_file' }) });
        try {
            const parsed = EscoImportService.parseUpload(files);
            const previous = req.session.escoUpload && req.session.escoUpload.token;
            if (previous) EscoImportService.discard(previous);
            req.session.escoUpload = { token: EscoImportService.store(parsed) };
            res.json({
                ok: true,
                message: t(req, 'framework:lib_esco_parsed', {
                    skills: parsed.skills,
                    groups: parsed.fw.pillars.length,
                }),
                redirect: '/framework/library?tab=esco',
            });
        } catch (e) {
            if (!e || !e.expose) console.error('ESCO upload:', e);
            res.status(e && e.expose ? 400 : 500).json({
                ok: false,
                code: (e && e.code) || 'generic',
                message: escoErrorMessage(req, e),
            });
        }
    }

    async escoDryRun(req, res) {
        const esco = escoState(req);
        if (!esco) {
            req.flash('error', t(req, 'framework:lib_esco_err_expired'));
            return back(res, 'esco');
        }
        const raw = req.body.groups;
        const keys = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(String);
        if (!keys.length) {
            req.flash('error', t(req, 'framework:lib_esco_err_none_selected'));
            return back(res, 'esco');
        }
        try {
            const lang = nameLang(req.body.lang, req);
            const limit = EscoImportService.clampLimit(req.body.limit);
            const sel = EscoImportService.select(esco.stored.fw, keys, limit);
            req.session.escoUpload.selection = { keys, limit, lang };
            const report = await FrameworkPackService.dryRun(sel.fw, { lang });
            await this.render(req, res, {
                tab: 'esco',
                report: {
                    kind: 'esco',
                    title: 'ESCO',
                    lang,
                    selected: sel.selected,
                    truncated: sel.truncated,
                    limit: sel.limit,
                    ...report,
                    totalNew: FrameworkPackService.totalCreated(report),
                },
            });
        } catch (e) {
            console.error('ESCO dry run:', e);
            req.flash('error', t(req, 'framework:lib_err_generic'));
            back(res, 'esco');
        }
    }

    async escoCommit(req, res) {
        const esco = escoState(req);
        const selection = esco && esco.session.selection;
        if (!esco || !selection) {
            req.flash('error', t(req, 'framework:lib_esco_err_expired'));
            return back(res, 'esco');
        }
        if (String(req.body.confirm || '') !== '1') {
            req.flash('error', t(req, 'framework:lib_err_confirm'));
            return back(res, 'esco');
        }
        try {
            const sel = EscoImportService.select(esco.stored.fw, selection.keys, selection.limit);
            const report = await FrameworkPackService.commit(sel.fw, {
                lang: selection.lang,
                actor: req.user,
                source: 'esco',
                action: 'FRAMEWORK_ESCO_IMPORTED',
                detail:
                    `ESCO files: ${(esco.stored.files || []).join(', ')}; ` +
                    `${sel.selected} skill(s) selected in ${selection.keys.length} group(s), ` +
                    `cap ${sel.limit}${sel.truncated ? `, ${sel.truncated} left out by the cap` : ''}`,
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : null,
            });
            req.flash(
                'success',
                t(req, 'framework:lib_done', {
                    created: FrameworkPackService.totalCreated(report),
                    skills: report.stats.skills.created,
                    roles: report.stats.roles.created,
                })
            );
        } catch (e) {
            console.error('ESCO import:', e);
            req.flash('error', t(req, 'framework:lib_err_generic'));
        }
        back(res, 'esco');
    }

    async escoDiscard(req, res) {
        const s = req.session && req.session.escoUpload;
        if (s && s.token) EscoImportService.discard(s.token);
        if (req.session) delete req.session.escoUpload;
        req.flash('success', t(req, 'framework:lib_esco_discarded'));
        back(res, 'esco');
    }
}

module.exports = new FrameworkLibraryController();
