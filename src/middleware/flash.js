'use strict';
/**
 * In-house flash messages, replacing express-flash (unmaintained since 2013)
 * and its connect-flash dependency. The SAME `req.flash` API:
 *
 *   req.flash('info', 'sent')          queue, returns the queue length
 *   req.flash('info', 'to %s', name)   util.format, like connect-flash
 *   req.flash('info', ['a', 'b'])      queue every item
 *   req.flash('info')                  the queued messages (then cleared), [] if none
 *   req.flash()                        { type: [messages] } (then cleared)
 *
 * and, like express-flash, `res.locals.messages = req.flash()` right before a
 * render. The storage shape is unchanged: session.flash[type] = [messages].
 *
 * Two differences, both on purpose:
 *  - READING never writes: a request with no queued message leaves the session
 *    untouched (connect-flash created `session.flash = {}` on every read, which
 *    made express-session persist a session row for an anonymous hit).
 *  - an ANONYMOUS visitor whose session was never established (nothing stored
 *    in it yet) gets no flash stored: a message cannot create a session.
 *    Signed-in users and visitors whose session already holds something (the
 *    CSRF token of a form page) are unaffected.
 */
const { format } = require('util');

/** A session that holds something besides its cookie, or a signed-in user. */
function sessionEstablished(req) {
    if (req.user) return true;
    const s = req.session;
    if (!s) return false;
    return Object.keys(s).some((k) => k !== 'cookie');
}

function flashFn(type, msg, ...rest) {
    const req = this;
    const s = req.session;
    if (type && msg) {
        // WRITE
        if (!s) throw new Error('req.flash() requires sessions');
        if (!sessionEstablished(req)) return 0; // never creates an anonymous session
        const all = s.flash || (s.flash = {});
        const queue = all[type] || (all[type] = []);
        if (rest.length) queue.push(format(msg, ...rest));
        else if (Array.isArray(msg)) msg.forEach((m) => queue.push(m));
        else queue.push(msg);
        return queue.length;
    }
    // READ (and clear): never creates anything.
    if (!s || !s.flash) return type ? [] : {};
    if (type) {
        const arr = s.flash[type];
        if (arr === undefined) return [];
        delete s.flash[type];
        if (!Object.keys(s.flash).length) delete s.flash;
        return arr;
    }
    const all = s.flash;
    delete s.flash;
    return all;
}
flashFn.__inHouse = true;

/** The middleware: `req.flash` and `res.locals.messages` at render time. */
function flash() {
    return function flashMiddleware(req, res, next) {
        if (typeof req.flash !== 'function' || !req.flash.__inHouse) {
            req.flash = flashFn;
        }
        const render = res.render;
        res.render = function renderWithFlash(...args) {
            res.locals.messages = req.flash();
            return render.apply(res, args);
        };
        next();
    };
}

module.exports = flash;
module.exports.flash = flash;
module.exports.sessionEstablished = sessionEstablished;
