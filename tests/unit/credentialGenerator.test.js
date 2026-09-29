'use strict';

const {
    generatePassword,
    baseUsername,
    uniqueUsername,
} = require('../../src/utils/credentialGenerator');
const passwordValidator = require('../../src/utils/passwordValidator');

describe('credentialGenerator.generatePassword', () => {
    test('produces a policy-valid password every time', () => {
        for (let i = 0; i < 50; i++) {
            const pw = generatePassword();
            expect(pw.length).toBeGreaterThanOrEqual(12);
            expect(passwordValidator.validate(pw).valid).toBe(true);
        }
    });

    test('passwords are not trivially repeated', () => {
        const set = new Set(Array.from({ length: 20 }, () => generatePassword()));
        expect(set.size).toBeGreaterThan(15);
    });
});

describe('credentialGenerator.baseUsername', () => {
    test('builds first.last, lowercased', () => {
        expect(baseUsername({ firstName: 'Clara Beatrice', lastName: 'NOVAK' })).toBe(
            'clarabeatrice.novak'
        );
    });

    test('strips accents and illegal characters', () => {
        expect(baseUsername({ firstName: 'José', lastName: "N'Guéssan" })).toBe('jose.nguessan');
    });

    test('falls back to employee number, then to "user"', () => {
        expect(baseUsername({ employeeNumber: 'EMP-123' })).toBe('emp-123');
        expect(baseUsername({})).toBe('user');
    });

    test('honours an explicit username', () => {
        expect(baseUsername({ username: 'custom.name', firstName: 'X', lastName: 'Y' })).toBe(
            'custom.name'
        );
    });
});

describe('credentialGenerator.uniqueUsername', () => {
    test('returns the base when free', async () => {
        const name = await uniqueUsername('jane.doe', async () => false);
        expect(name).toBe('jane.doe');
    });

    test('appends an incrementing suffix when taken', async () => {
        const taken = new Set(['jane.doe', 'jane.doe1']);
        const name = await uniqueUsername('jane.doe', async (n) => taken.has(n));
        expect(name).toBe('jane.doe2');
    });
});
