'use strict';

const passwordValidator = require('../../src/utils/passwordValidator');

describe('passwordValidator.validate', () => {
    test('accepts a strong password meeting every rule', () => {
        const r = passwordValidator.validate('StrongP@ss9x');
        expect(r.valid).toBe(true);
        expect(r.errors).toHaveLength(0);
    });

    test.each([
        ['empty', '', 'Password is required'],
        ['too short', 'Ab1!', 'at least 12'],
        ['no uppercase', 'alllower9!', 'uppercase'],
        ['no lowercase', 'ALLUPPER9!', 'lowercase'],
        ['no number', 'NoNumber@x', 'number'],
        ['no special', 'NoSpecial9x', 'special'],
    ])('rejects %s', (_label, pw, fragment) => {
        const r = passwordValidator.validate(pw);
        expect(r.valid).toBe(false);
        expect(r.errors.join(' ').toLowerCase()).toContain(fragment.toLowerCase());
    });
});
