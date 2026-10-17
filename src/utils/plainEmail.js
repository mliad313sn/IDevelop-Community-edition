'use strict';
/**
 * local@domain.tld with one "@", no white space, and a dot inside the domain.
 * Checked by splitting rather than by one regex, so a long hostile string
 * cannot make the check backtrack (js/polynomial-redos).
 * @param {unknown} email
 * @returns {boolean}
 */
function plainEmail(email) {
    if (typeof email !== 'string' || !email || email.length > 254 || /\s/.test(email)) return false;
    const at = email.indexOf('@');
    if (at < 1 || at !== email.lastIndexOf('@')) return false;
    const domain = email.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    return dot > 0 && dot < domain.length - 1;
}

module.exports = { plainEmail };
