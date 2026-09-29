const { translatePlaceholders, renameIdentifiers } = require('../../src/database/sql-compat');

describe('translatePlaceholders', () => {
    it('rewrites positional ? to $1..$N', () => {
        expect(translatePlaceholders('SELECT * FROM t WHERE a=? AND b=?')).toBe(
            'SELECT * FROM t WHERE a=$1 AND b=$2'
        );
    });

    it('leaves ? alone inside single-quoted strings', () => {
        const sql = "SELECT 'a?b' WHERE x = ?";
        expect(translatePlaceholders(sql)).toBe("SELECT 'a?b' WHERE x = $1");
    });

    it('leaves ? alone inside double-quoted identifiers', () => {
        const sql = 'SELECT "a?b" FROM t WHERE x = ?';
        expect(translatePlaceholders(sql)).toBe('SELECT "a?b" FROM t WHERE x = $1');
    });

    it('handles long parameter lists', () => {
        const sql = 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        expect(translatePlaceholders(sql)).toBe(
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)'
        );
    });
});

describe('renameIdentifiers', () => {
    it('replaces whole-word camelCase to snake_case', () => {
        const m = { siteId: 'site_id', departmentId: 'department_id' };
        expect(renameIdentifiers('SELECT siteId, departmentId FROM t', m)).toBe(
            'SELECT site_id, department_id FROM t'
        );
    });

    it('does not match substrings', () => {
        const m = { id: 'id_renamed' };
        // "id" appears inside "siteId" — must NOT be replaced.
        expect(renameIdentifiers('SELECT siteId FROM t', m)).toBe('SELECT siteId FROM t');
    });

    it('leaves identifiers inside quoted strings alone', () => {
        const m = { siteId: 'site_id' };
        expect(renameIdentifiers("SELECT 'siteId' FROM t", m)).toBe("SELECT 'siteId' FROM t");
    });
});
