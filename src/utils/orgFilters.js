'use strict';

/**
 * Helpers for org (site / department / service) FILTER dropdowns.
 *
 * The org hierarchy is site-scoped: the same department or service NAME
 * legitimately exists under many parents (e.g. an "IT" department under every
 * site, each with its own "Infrastructure" service). A FILTER dropdown that lists
 * those by name should show each name ONCE — selecting "IT" then filters every IT
 * department across sites. (This is only for filters: an ASSIGNMENT form must stay
 * cascaded site -> department -> service so the employee lands on the exact unit.)
 */

/**
 * De-duplicate a list of {name, ...} by name, case-insensitively and trimming
 * surrounding whitespace, preserving the first occurrence and returning the list
 * sorted by name. Non-string / empty names are dropped.
 */
function distinctByName(items) {
    const seen = new Set();
    return (items || [])
        .filter((item) => {
            const raw = item && item.name != null ? String(item.name).trim() : '';
            if (!raw) return false;
            const key = raw.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = { distinctByName };
