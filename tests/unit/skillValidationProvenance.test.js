'use strict';
/**
 * skill_assessments.validation says where an official level comes from, and
 * every writer states it:
 *  - SkillAssessmentModel.upsert carries it and RESETS it on update: a level
 *    written without a stated provenance is 'self', so an earlier
 *    'manager_validated' never sticks to a level nobody validated;
 *  - an assessor's entry, a reviewed or approved self-assessment, a dispute
 *    decision, a validated training completion, an action uplift and an
 *    accepted suggestion write 'manager_validated';
 *  - an import that CHANGES a level writes 'self'; an unchanged one keeps its
 *    provenance.
 */
const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ lastID: 9, changes: 1 })),
};
jest.mock('../../src/config/database', () => mockDb);

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const flat = (s) => String(s).replace(/\s+/g, ' ');

describe('SkillAssessmentModel.upsert', () => {
    const Model = require('../../src/models/SkillAssessmentModel');

    beforeEach(() => jest.restoreAllMocks());

    test('a new row carries the stated provenance, or self', async () => {
        const create = jest.spyOn(Model, 'create').mockResolvedValue({ id: 1 });
        jest.spyOn(Model, 'findByEmployeeIdAndSkillId').mockResolvedValue(undefined);
        await Model.upsert({ employeeId: 1, skillId: 2, currentLevel: 3, assessedBy: 1 });
        await Model.upsert({
            employeeId: 1,
            skillId: 2,
            currentLevel: 3,
            assessedBy: 1,
            validation: 'manager_validated',
        });
        await Model.upsert({
            employeeId: 1,
            skillId: 2,
            currentLevel: 3,
            assessedBy: 1,
            validation: 'made-up',
        });
        expect(create.mock.calls.map((c) => c[0].validation)).toEqual([
            'self',
            'manager_validated',
            'self',
        ]);
    });

    test('an update RESETS it: no stated provenance means self', async () => {
        const update = jest.spyOn(Model, 'update').mockResolvedValue({ id: 5 });
        jest.spyOn(Model, 'findByEmployeeIdAndSkillId').mockResolvedValue({
            id: 5,
            validation: 'manager_validated',
        });
        await Model.upsert({ employeeId: 1, skillId: 2, currentLevel: 1, assessedBy: 1 });
        expect(update.mock.calls[0][1].validation).toBe('self');
    });
});

describe('every writer states the provenance', () => {
    test('assessor entry, review promotion, approval promotion and dispute decision', () => {
        expect(flat(read('src/services/SkillAssessmentService.js'))).toMatch(
            /SkillAssessmentModel\.upsert\(\{[^}]*validation: 'manager_validated'/
        );
        const sas = flat(read('src/services/SelfAssessmentService.js'));
        const k = sas.indexOf('Validated by supervisor review. Gap:');
        expect(sas.slice(k, k + 200)).toContain("validation: 'manager_validated'");
        expect(flat(read('src/services/SelfAssessmentWorkflowService.js'))).toMatch(
            /'Set from approved self-assessment',[^}]*validation: 'manager_validated'/
        );
        expect(flat(read('src/services/DisputeServiceV2.js'))).toMatch(
            /'Set by dispute resolution \(final decided rating\)\.',\s*validation: 'manager_validated'/
        );
    });

    test.each([
        ['src/services/LmsService.js', 'Set from a supervisor-validated training completion'],
        ['src/services/ActionEffectivenessService.js', 'auto: action close uplift'],
        ['src/services/SkillsIntelligenceService.js', 'Accepted skill suggestion'],
    ])('%s inserts and updates the provenance', (file, note) => {
        const s = flat(read(file));
        const i = s.indexOf(note);
        const stmt = s.slice(s.lastIndexOf('INSERT INTO skill_assessments', i), i + 400);
        expect(stmt).toMatch(/, validation\)/);
        expect(stmt).toContain("'manager_validated'");
        expect(stmt).toMatch(/validation\s*=\s*EXCLUDED\.validation/);
    });

    test('an import that changes a level writes self; an unchanged one keeps its provenance', () => {
        const imp = flat(read('src/services/UnifiedImportService.js'));
        expect(imp).toContain("validation = 'self'");
        expect(
            imp.match(/validation = CASE WHEN currentLevel = \? THEN validation ELSE 'self' END/g)
        ).toHaveLength(2);
        expect(flat(read('src/services/SkillMatrixWorkbookService.js'))).toMatch(
            /validation = CASE WHEN currentLevel = \? THEN validation ELSE 'self' END/
        );
    });
});
