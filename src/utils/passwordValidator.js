/**
 * Password Validator
 * Validates password strength and complexity
 * Enhanced security requirements
 */

const COMMON_PASSWORDS = [
    'password',
    'password123',
    'password1',
    'Password1',
    'Password123',
    'admin',
    'admin123',
    'Admin123',
    'administrator',
    'root',
    '12345678',
    '123456789',
    '1234567890',
    '12345678901',
    'qwerty',
    'qwerty123',
    'qwertyuiop',
    'letmein',
    'welcome',
    'welcome123',
    'Welcome123',
    'monkey',
    'dragon',
    'master',
    'sunshine',
    'princess',
    'abc123',
    'abc12345',
    'abcd1234',
    'iloveyou',
    'trustno1',
    'baseball',
    'football',
    'superman',
    'batman',
    'shadow',
    'mustang',
    'michael',
    'jordan',
    'tigger',
    'hunter',
    'jennifer',
    'joshua',
    'hannah',
    'michelle',
];

class PasswordValidator {
    /**
     * Validate password against complexity requirements
     * @param {string} password - Password to validate
     * @returns {object} - { valid: boolean, errors: string[], score: number }
     */
    validate(password) {
        const errors = [];

        if (!password) {
            errors.push('Password is required');
            return { valid: false, errors, score: 0 };
        }

        // Minimum length requirement (raised to 12 — length beats composition).
        if (password.length < 12) {
            errors.push('Password must be at least 12 characters long');
        }

        // Maximum length check (prevent DoS)
        if (password.length > 128) {
            errors.push('Password must not exceed 128 characters');
        }

        // Require at least one lowercase letter
        if (!/[a-z]/.test(password)) {
            errors.push('Password must contain at least one lowercase letter');
        }

        // Require at least one uppercase letter
        if (!/[A-Z]/.test(password)) {
            errors.push('Password must contain at least one uppercase letter');
        }

        // Require at least one number
        if (!/[0-9]/.test(password)) {
            errors.push('Password must contain at least one number');
        }

        // Require at least one special character
        if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password)) {
            errors.push(
                'Password must contain at least one special character (!@#$%^&*()_+-=[]{}|;:,.<>?)'
            );
        }

        // Check for common passwords (enhanced check)
        const lowerPassword = password.toLowerCase();
        if (COMMON_PASSWORDS.some((common) => lowerPassword.includes(common.toLowerCase()))) {
            errors.push('Password is too common. Please choose a stronger password');
        }

        // Check for repeated characters (e.g., "aaaa", "1111")
        if (/(.)\1{3,}/.test(password)) {
            errors.push('Password must not contain more than 3 repeated characters in a row');
        }

        // Check for sequential characters (e.g., "abcd", "1234", "qwerty")
        const sequences = [
            'abcdefghijklmnopqrstuvwxyz',
            'zyxwvutsrqponmlkjihgfedcba',
            '0123456789',
            '9876543210',
            'qwertyuiop',
            'poiuytrewq',
            'asdfghjkl',
            'lkjhgfdsa',
            'zxcvbnm',
            'mnbvcxz',
        ];

        for (const seq of sequences) {
            for (let i = 0; i <= seq.length - 4; i++) {
                const subseq = seq.substring(i, i + 4);
                if (lowerPassword.includes(subseq)) {
                    errors.push(
                        'Password must not contain sequential characters (e.g., "abcd", "1234", "qwerty")'
                    );
                    break;
                }
            }
            if (errors.some((e) => e.includes('sequential'))) break;
        }

        // Check if password contains username (if provided)
        // This will be checked separately in AuthService if username is available

        // Check for keyboard patterns
        const keyboardPatterns = ['qwerty', 'asdfgh', 'zxcvbn', 'qazwsx', '1qaz2wsx', '!qaz@wsx'];

        for (const pattern of keyboardPatterns) {
            if (lowerPassword.includes(pattern)) {
                errors.push('Password must not contain common keyboard patterns');
                break;
            }
        }

        // Check for common substitutions (e.g., "P@ssw0rd")
        const commonSubstitutions = {
            password: ['p@ssw0rd', 'p@ssword', 'passw0rd', 'p@$$w0rd'],
            admin: ['@dmin', '@dm1n', '4dm1n'],
            welcome: ['w3lc0m3', 'welc0me'],
        };

        for (const [base, variants] of Object.entries(commonSubstitutions)) {
            for (const variant of variants) {
                if (lowerPassword.includes(variant)) {
                    errors.push(
                        'Password contains common word substitutions. Please use a more unique password'
                    );
                    break;
                }
            }
            if (errors.some((e) => e.includes('substitutions'))) break;
        }

        const score = this.calculateStrength(password);

        return {
            valid: errors.length === 0,
            errors,
            score,
        };
    }

    /**
     * Calculate password strength score (0-100)
     * @param {string} password
     * @returns {number} Strength score
     */
    calculateStrength(password) {
        if (!password) return 0;

        let score = 0;

        // Length scoring
        if (password.length >= 8) score += 20;
        if (password.length >= 12) score += 10;
        if (password.length >= 16) score += 10;
        if (password.length >= 20) score += 5;

        // Character variety
        if (/[a-z]/.test(password)) score += 8;
        if (/[A-Z]/.test(password)) score += 8;
        if (/[0-9]/.test(password)) score += 8;
        if (/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password)) score += 12;

        // Multiple character types bonus
        const uniqueCharTypes = [
            /[a-z]/.test(password),
            /[A-Z]/.test(password),
            /[0-9]/.test(password),
            /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password),
        ].filter(Boolean).length;

        if (uniqueCharTypes >= 3) score += 10;
        if (uniqueCharTypes === 4) score += 8;

        // Bonus for mixed case and numbers
        const hasMixedCase = /[a-z]/.test(password) && /[A-Z]/.test(password);
        const hasNumbers = /[0-9]/.test(password);
        const hasSpecial = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password);

        if (hasMixedCase && hasNumbers && hasSpecial) {
            score += 5;
        }

        // Penalize common passwords
        const lowerPassword = password.toLowerCase();
        if (COMMON_PASSWORDS.some((common) => lowerPassword.includes(common.toLowerCase()))) {
            score -= 40;
        }

        // Penalize repeated characters
        if (/(.)\1{2,}/.test(password)) {
            score -= 15;
        }

        // Penalize sequential characters
        const sequences = ['abcdefgh', '01234567', 'qwertyui'];
        for (const seq of sequences) {
            if (lowerPassword.includes(seq.substring(0, 4))) {
                score -= 20;
                break;
            }
        }

        // Bonus for entropy (character diversity)
        const uniqueChars = new Set(password).size;
        const entropyBonus = Math.min(10, Math.floor(uniqueChars / 3));
        score += entropyBonus;

        return Math.max(0, Math.min(100, score));
    }

    /**
     * Get strength label from score
     * @param {number} score
     * @returns {string}
     */
    getStrengthLabel(score) {
        if (score < 30) return 'Weak';
        if (score < 60) return 'Fair';
        if (score < 80) return 'Good';
        return 'Strong';
    }
}

module.exports = new PasswordValidator();
