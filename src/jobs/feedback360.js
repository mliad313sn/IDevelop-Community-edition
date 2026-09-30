'use strict';
/**
 * feedback360 — hourly tick of the 360° feedback rounds (development module):
 *   - closes the rounds whose deadline has passed (the report is then produced
 *     and, per round, released at once or handed to the manager to release);
 *   - reminds the raters who have not answered, at most once every six days
 *     each (three days after the invitation for the first one).
 *
 * Every message goes through NotificationService.notify, so the recipient's
 * quiet hours and the digest tier of the 'feedback360.*' kinds apply. Does
 * nothing while the development module is off.
 */
async function tick() {
    const ModuleService = require('../services/ModuleService');
    if (!(await ModuleService.isOn('development'))) return { skipped: 'module_off' };
    return require('../services/Feedback360Service').tick();
}

module.exports = { tick };
