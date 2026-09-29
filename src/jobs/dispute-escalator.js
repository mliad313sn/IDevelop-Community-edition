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
    // Walk the whole ladder each run: L0→L1, L1→L2 (HR), then auto-finalize
    // overdue L2 so a dispute can never block cycle close. SLAs come from
    // Settings (category 'disputes'); auto-finalize is toggleable.
    const l0 = await DisputeServiceV2.escalateOverdueL0();
    const l1 = await DisputeServiceV2.escalateOverdueL1();
    const l2 = await DisputeServiceV2.autoFinalizeOverdueL2();
    if (l0 || l1 || l2) {
        console.log(`[dispute-escalator] L0→L1: ${l0}, L1→L2(HR): ${l1}, L2 auto-finalized: ${l2}`);
    }
    return { l0, l1, l2 };
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
