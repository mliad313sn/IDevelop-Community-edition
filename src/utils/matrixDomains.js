'use strict';

/**
 * The skill matrix draws ONE domain of skill columns at a time.
 *
 * Every skill of every domain as a column grows with the framework: a few
 * hundred skills across a page of people is tens of thousands of cells, slow to
 * render on a site laptop and unreadable on a tablet. The framework itself is
 * never reduced; only how many columns are drawn at once changes, and « All
 * domains » stays one choice away.
 *
 * Default domain: the one holding the most skills REQUIRED by the roles of the
 * people on this page (ties: the larger domain, then the framework's order).
 * A requested domain is honoured only if it is one of the options; anything
 * else falls back to the default, so a typed query value can never select
 * columns that do not exist.
 *
 * @param {object} skillsByDomain  { [domainId]: { domain: {id, name}, skills: [{id, domainId}] } }
 * @param {object} roleRequirementsMap  { [roleId]: { [skillId]: requirement } }
 * @param {string} wanted  the `domain` query value ('all', a domain id, or '')
 * @returns {{ domainOptions: Array, activeDomain: string, shown: object }}
 */
function chooseDomainColumns(skillsByDomain, roleRequirementsMap, wanted) {
    const groups = Object.values(skillsByDomain || {}).filter(
        (d) => d && d.domain && Array.isArray(d.skills) && d.skills.length > 0
    );
    const domainOfSkill = new Map();
    for (const d of groups)
        for (const s of d.skills) domainOfSkill.set(String(s.id), String(d.domain.id));

    const required = new Map();
    for (const reqs of Object.values(roleRequirementsMap || {})) {
        for (const skillId of Object.keys(reqs || {})) {
            const dom = domainOfSkill.get(String(skillId));
            if (dom) required.set(dom, (required.get(dom) || 0) + 1);
        }
    }

    const domainOptions = groups.map((d, order) => ({
        id: String(d.domain.id),
        name: d.domain.name,
        skills: d.skills.length,
        required: required.get(String(d.domain.id)) || 0,
        order,
    }));

    const ask = String(wanted == null ? '' : wanted).trim();
    let activeDomain = 'all';
    if (ask !== 'all' && domainOptions.length) {
        const hit = domainOptions.find((o) => o.id === ask);
        const best = domainOptions
            .slice()
            .sort((a, b) => b.required - a.required || b.skills - a.skills || a.order - b.order)[0];
        activeDomain = hit ? hit.id : best.id;
    }

    let shown = skillsByDomain || {};
    if (activeDomain !== 'all') {
        // activeDomain is one of the option ids here, never a raw query value
        const g = groups.find((d) => String(d.domain.id) === activeDomain);
        shown = Object.fromEntries([[activeDomain, g]]);
    }
    return {
        domainOptions: domainOptions.map(({ order: _order, ...o }) => o),
        activeDomain,
        shown,
    };
}

module.exports = { chooseDomainColumns };
