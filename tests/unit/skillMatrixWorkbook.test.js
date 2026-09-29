'use strict';

// Unit tests for SkillMatrixWorkbookService pure logic: helpers + workbook
// parsing (no DB connection). The service module requires the DB config at
// load time (which needs DATABASE_URL), so the suite is skipped when it is
// absent — parsing itself never touches the database.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ExcelJS = require('exceljs');

const HAS_DB = !!process.env.DATABASE_URL;
const suite = HAS_DB ? describe : describe.skip;

suite('SkillMatrixWorkbookService — pure helpers', () => {
    let svc;
    beforeAll(() => {
        svc = require('../../src/services/SkillMatrixWorkbookService');
    });

    test('parseEmployeeName splits first/last and handles single token', () => {
        expect(svc.parseEmployeeName('Ange Bouadi')).toEqual({
            firstName: 'Ange',
            lastName: 'Bouadi',
        });
        expect(svc.parseEmployeeName('Maria del Carmen Diaz')).toEqual({
            firstName: 'Maria',
            lastName: 'del Carmen Diaz',
        });
        expect(svc.parseEmployeeName('  Cher  ')).toEqual({ firstName: 'Cher', lastName: 'Cher' });
        expect(svc.parseEmployeeName('')).toEqual({ firstName: '', lastName: '' });
    });

    test('normalizeLevel accepts 0..4 and rejects out-of-range/blank', () => {
        expect(svc.normalizeLevel(0)).toBe(0);
        expect(svc.normalizeLevel('4')).toBe(4);
        expect(svc.normalizeLevel(2)).toBe(2);
        expect(svc.normalizeLevel('')).toBeNull();
        expect(svc.normalizeLevel(null)).toBeNull();
        expect(svc.normalizeLevel(5)).toBeNull();
        expect(svc.normalizeLevel(-1)).toBeNull();
        expect(svc.normalizeLevel('x')).toBeNull();
    });

    test('normalizeHeader strips case and punctuation', () => {
        expect(svc.normalizeHeader('Required Level (0-4)')).toBe('requiredlevel04');
        expect(svc.normalizeHeader('Role (original)')).toBe('roleoriginal');
        expect(svc.normalizeHeader('Domain ID')).toBe('domainid');
    });
});

suite('SkillMatrixWorkbookService — parseWorkbook', () => {
    let svc;
    let parsed;

    beforeAll(async () => {
        svc = require('../../src/services/SkillMatrixWorkbookService');

        const wb = new ExcelJS.Workbook();

        const dom = wb.addWorksheet('Domains');
        dom.addRow(['Domain ID', 'Domain Name']);
        dom.addRow(['DOM-01', 'Audit Methodology']);

        const sk = wb.addWorksheet('Skills');
        sk.addRow(['Skill ID', 'Skill Name', 'Domain ID', 'Domain Name']);
        sk.addRow(['SKL-001', 'Audit Planning & Scoping', 'DOM-01', 'Audit Methodology']);
        sk.addRow(['SKL-002', 'Risk-Based Audit Approach', 'DOM-01', 'Audit Methodology']);

        const ro = wb.addWorksheet('Roles');
        ro.addRow(['Role ID', 'Role Name', 'Career Level']);
        ro.addRow(['ROL-00', 'Intern Internal Auditor', 'Entry']);

        const rr = wb.addWorksheet('Role_Requirements');
        rr.addRow(['Role ID', 'Skill ID', 'Skill Name', 'Domain ID', 'Required Level (0-4)']);
        rr.addRow(['ROL-00', 'SKL-001', 'Audit Planning & Scoping', 'DOM-01', 1]);
        rr.addRow(['ROL-00', 'SKL-002', 'Risk-Based Audit Approach', 'DOM-01', 7]); // invalid -> error

        const emp = wb.addWorksheet('Employees');
        emp.addRow([
            'Employee ID',
            'Employee Name',
            'Site',
            'Department',
            'Service',
            'Role ID',
            'Role (original)',
            'Manager',
            'Supervisor',
        ]);
        emp.addRow([
            'EMP-001',
            'Ange Bouadi',
            'EMSA',
            'Internal Audit',
            'Internal Audit',
            'ROL-00',
            'Junior Auditor',
            'Maimouna Marte',
            'Yann Kouame',
        ]);

        const as = wb.addWorksheet('Assessment');
        as.addRow([
            'Employee ID',
            'Employee Name',
            'Role ID',
            'Skill ID',
            'Skill Name',
            'Domain ID',
            'Required Level',
            'Current Level',
            'Gap',
            'Priority',
            'Development Action',
            'Target Date',
            'Evidence Reference',
        ]);
        as.addRow([
            'EMP-001',
            'Ange Bouadi',
            'ROL-00',
            'SKL-001',
            'Audit Planning & Scoping',
            'DOM-01',
            1,
            2,
            '',
            '',
            '',
            '',
            '',
        ]);
        as.addRow([
            'EMP-001',
            'Ange Bouadi',
            'ROL-00',
            'SKL-002',
            'Risk-Based Audit Approach',
            'DOM-01',
            1,
            '',
            '',
            '',
            '',
            '',
            '',
        ]); // blank current level -> skipped

        parsed = svc.parseWorkbook(wb);
    });

    test('domains/skills/roles parsed', () => {
        expect(parsed.domains).toEqual([{ name: 'Audit Methodology' }]);
        expect(parsed.skills).toHaveLength(2);
        expect(parsed.skills[0]).toEqual({
            name: 'Audit Planning & Scoping',
            domainName: 'Audit Methodology',
        });
        expect(parsed.roles).toEqual([{ name: 'Intern Internal Auditor', careerLevel: 'Entry' }]);
    });

    test('requirements resolve workbook IDs to names; invalid level recorded as error', () => {
        expect(parsed.requirements).toEqual([
            {
                roleName: 'Intern Internal Auditor',
                skillName: 'Audit Planning & Scoping',
                domainName: 'Audit Methodology',
                requiredLevel: 1,
                isCritical: false,
            },
        ]);
        expect(parsed.errors.some((e) => /invalid required level/i.test(e))).toBe(true);
    });

    test('employees resolve role ID and split name', () => {
        expect(parsed.employees).toHaveLength(1);
        const e = parsed.employees[0];
        expect(e.employeeNumber).toBe('EMP-001');
        expect(e.firstName).toBe('Ange');
        expect(e.lastName).toBe('Bouadi');
        expect(e.roleName).toBe('Intern Internal Auditor');
        expect(e.managerName).toBe('Maimouna Marte');
        expect(e.supervisorName).toBe('Yann Kouame');
    });

    test('assessments keep only rows with a valid current level', () => {
        expect(parsed.assessments).toEqual([
            // assessedAt rides along so a re-import restores the original assessment
            // date; this sheet carries none, so it is null and the write uses now().
            {
                employeeNumber: 'EMP-001',
                skillName: 'Audit Planning & Scoping',
                domainName: 'Audit Methodology',
                currentLevel: 2,
                assessedAt: null,
            },
        ]);
    });
});

suite('SkillMatrixWorkbookService — multi-format symmetry (Excel/JSON/XML/CSV)', () => {
    let svc;
    // Canonical model (the shape _collectModel builds from the DB).
    const model = {
        meta: { format: 'idevelop-skill-matrix', version: 1 },
        competencyScale: [
            { level: 0, definition: 'None' },
            { level: 1, definition: 'Basic' },
            { level: 2, definition: 'Intermediate' },
            { level: 3, definition: 'Advanced' },
            { level: 4, definition: 'Expert' },
        ],
        domains: [{ domainId: 'DOM-01', domainName: 'Audit Methodology' }],
        skills: [
            {
                skillId: 'SKL-001',
                skillName: 'Audit Planning & Scoping',
                domainId: 'DOM-01',
                domainName: 'Audit Methodology',
            },
        ],
        roles: [{ roleId: 'ROL-00', roleName: 'Intern Internal Auditor', careerLevel: 'Entry' }],
        roleRequirements: [
            {
                roleId: 'ROL-00',
                skillId: 'SKL-001',
                skillName: 'Audit Planning & Scoping',
                domainId: 'DOM-01',
                requiredLevel: 1,
            },
        ],
        employees: [
            {
                employeeId: 'EMP-001',
                employeeName: 'Ange Bouadi',
                site: 'EMSA',
                department: 'Internal Audit',
                service: 'Internal Audit',
                roleId: 'ROL-00',
                roleOriginal: 'Junior Auditor',
                manager: 'Maimouna Marte',
                supervisor: 'Yann Kouame',
            },
        ],
        assessments: [
            {
                employeeId: 'EMP-001',
                employeeName: 'Ange Bouadi',
                roleId: 'ROL-00',
                skillId: 'SKL-001',
                skillName: 'Audit Planning & Scoping',
                domainId: 'DOM-01',
                requiredLevel: 1,
                currentLevel: 2,
                gap: '',
                priority: '',
                developmentAction: '',
                targetDate: '',
                evidenceReference: '',
            },
        ],
    };

    const expected = {
        domains: [{ name: 'Audit Methodology' }],
        skills: [{ name: 'Audit Planning & Scoping', domainName: 'Audit Methodology' }],
        roles: [{ name: 'Intern Internal Auditor', careerLevel: 'Entry' }],
        requirements: [
            {
                roleName: 'Intern Internal Auditor',
                skillName: 'Audit Planning & Scoping',
                domainName: 'Audit Methodology',
                requiredLevel: 1,
                isCritical: false,
            },
        ],
        employees: [
            {
                employeeNumber: 'EMP-001',
                fullName: 'Ange Bouadi',
                firstName: 'Ange',
                lastName: 'Bouadi',
                site: 'EMSA',
                department: 'Internal Audit',
                service: 'Internal Audit',
                roleName: 'Intern Internal Auditor',
                roleOriginal: 'Junior Auditor',
                managerName: 'Maimouna Marte',
                supervisorName: 'Yann Kouame',
            },
        ],
        // `assessedAt` is carried through so a re-import restores WHEN a skill was
        // assessed instead of restamping it with today (AMDEC L4-2). This fixture
        // has no date, which pins the fallback: absent -> null -> now() at the write.
        assessments: [
            {
                employeeNumber: 'EMP-001',
                skillName: 'Audit Planning & Scoping',
                domainName: 'Audit Methodology',
                currentLevel: 2,
                assessedAt: null,
            },
        ],
    };

    beforeAll(() => {
        svc = require('../../src/services/SkillMatrixWorkbookService');
    });

    // These tests assert that every format produces the SAME internal shape.
    // `errors` and `notRated` are diagnostics about the source document, not
    // part of that shape — notRated counts scaffold rows deliberately left
    // blank, which differs per fixture and is asserted separately.
    const strip = (internal) => {
        const { errors, notRated, ...rest } = internal; // eslint-disable-line no-unused-vars
        return rest;
    };

    test('detectFormat maps extensions', () => {
        expect(svc.detectFormat('x.xlsx')).toBe('excel');
        expect(svc.detectFormat('x.json')).toBe('json');
        expect(svc.detectFormat('x.xml')).toBe('xml');
        expect(svc.detectFormat('x.csv')).toBe('csv');
        expect(svc.detectFormat('x.yaml')).toBe('yaml');
        expect(svc.detectFormat('x.yml')).toBe('yaml');
        expect(svc.detectFormat('x.txt')).toBeNull();
    });

    test('JSON round-trips to the same internal shape', () => {
        const json = svc._modelToJson(model);
        const internal = svc._modelToInternal(svc._jsonToModel(json));
        expect(strip(internal)).toEqual(expected);
    });

    test('XML round-trips (and escapes & correctly)', () => {
        const xml = svc._modelToXml(model);
        expect(xml).toContain('Audit Planning &amp; Scoping');
        const internal = svc._modelToInternal(svc._xmlToModel(xml));
        expect(strip(internal)).toEqual(expected);
    });

    test('CSV round-trips to the same internal shape', () => {
        const csv = svc._modelToCsv(model);
        expect(csv).toContain('### DOMAINS ###');
        expect(csv).toContain('### ASSESSMENT ###');
        const internal = svc._modelToInternal(svc._csvToModel(csv));
        expect(strip(internal)).toEqual(expected);
    });

    test('YAML round-trips to the same internal shape', () => {
        const yaml = svc._modelToYaml(model);
        expect(yaml).toContain('domains:');
        const internal = svc._modelToInternal(svc._yamlToModel(yaml));
        expect(strip(internal)).toEqual(expected);
    });
});

suite('SkillMatrixWorkbookService — roles_template_IA layout (name-based + Is Critical)', () => {
    let svc;
    let parsed;

    beforeAll(async () => {
        svc = require('../../src/services/SkillMatrixWorkbookService');
        const wb = new ExcelJS.Workbook();

        // Instructions sheet (ignored).
        const ins = wb.addWorksheet('Instructions');
        ins.addRow(['Roles & Skill Requirements Import Template']);

        // Roles sheet uses Name / Description (no Role ID).
        const ro = wb.addWorksheet('Roles');
        ro.addRow(['Name', 'Description']);
        ro.addRow(['Internal Auditor', 'Performs audit testing and fieldwork.']);

        // Requirements live in a "Skill Requirements" sheet, keyed by name.
        const sr = wb.addWorksheet('Skill Requirements');
        sr.addRow(['Role Name', 'Skill Name', 'Required Level', 'Is Critical']);
        sr.addRow(['Internal Auditor', 'Audit Planning & Scoping', 2, 'No']);
        sr.addRow(['Internal Auditor', 'Risk-Based Audit Approach', 4, 'Yes']);

        parsed = svc.parseWorkbook(wb);
    });

    test('reads Name/Description role columns', () => {
        expect(parsed.roles).toEqual([
            { name: 'Internal Auditor', careerLevel: 'Performs audit testing and fieldwork.' },
        ]);
    });

    test('reads the "Skill Requirements" sheet, name-based, with Is Critical', () => {
        expect(parsed.requirements).toEqual([
            {
                roleName: 'Internal Auditor',
                skillName: 'Audit Planning & Scoping',
                domainName: '',
                requiredLevel: 2,
                isCritical: false,
            },
            {
                roleName: 'Internal Auditor',
                skillName: 'Risk-Based Audit Approach',
                domainName: '',
                requiredLevel: 4,
                isCritical: true,
            },
        ]);
    });
});
