'use strict';

/**
 *   BullMQ worker: dispute-escalator.
 *   Runs every hour. Promotes overdue L0 disputes to L1 and notifies
 *   site/department managers via the notifications queue (Phase 6).
 *
 *   Boot from src/jobs/index.js once Phase 4 lands BullMQ.
 */

const DisputeServiceV2 = require('../services/DisputeServiceV2');

async function tick() {
    // Walk the whole ladder each run: L0→L1, L1→L2 (HR), the reminder to HR two
    // days before a level-2 deadline (once per dispute), then the level-2
    // auto-finalisation — OFF unless an administrator switched it on
    // (dispute.autoFinalizeOnExpiry, migration 194): a contested rating stays
    // provisional until HR decides, and a campaign may still close. SLAs come
    // from Settings (category 'disputes').
    const l0 = await DisputeServiceV2.escalateOverdueL0();
    const l1 = await DisputeServiceV2.escalateOverdueL1();
    const reminded = await DisputeServiceV2.remindHrBeforeL2Deadline().catch(() => 0);
    const l2 = await DisputeServiceV2.autoFinalizeOverdueL2();
    if (l0 || l1 || l2 || reminded) {
        console.log(
            `[dispute-escalator] L0→L1: ${l0}, L1→L2(HR): ${l1}, HR reminded: ${reminded}, L2 auto-finalized: ${l2}`
        );
    }
    return { l0, l1, l2, reminded };
}

module.exports = { tick };

if (require.main === module) {
    tick()
        .then(() => process.exit(0))
        .catch((e) => {
            console.error(e);
            process.exit(1);
        });
}
