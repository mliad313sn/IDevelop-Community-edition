'use strict';
/**
 * Source-reading tests pin CODE, not its layout. The pre-commit hook reflows files
 * with prettier (a call split over lines, a trailing comma added, a comment moved),
 * which broke such tests on every release even though the code was unchanged.
 * flat() collapses that layout: whitespace runs become one space, and the space /
 * trailing comma prettier puts inside brackets disappears.
 */
function flat(src) {
    return (
        String(src)
            .replace(/\s+/g, ' ')
            .replace(/([([]) /g, '$1')
            .replace(/,? ([)\]])/g, '$1')
            // object literals keep their inner spaces ("{ a, b }"); only the
            // trailing comma prettier adds on a multi-line literal goes.
            .replace(/, \}/g, ' }')
    );
}

module.exports = { flat };
