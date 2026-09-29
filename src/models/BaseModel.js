'use strict';

const db = require('../config/database');

/**
 *   BaseModel — generic PostgreSQL table access.
 *
 *   Callers may pass camelCase column/table names; this layer auto-translates
 *   camelCase ↔ snake_case by convention. Subclasses can override the
 *   conventions via static `tableNamePg` and `columnMap`.
 *
 *   Result row keys are translated back from snake_case to camelCase so
 *   downstream callers (controllers, services) need no changes.
 *
 *   Special cases handled in the default conversions:
 *     - boolean coercion when sending camelCase 0/1 to PG BOOLEAN columns
 *     - count(*) BIGINT → Number
 */

// PostgreSQL is the only supported driver.
const IS_PG = true;

// Tables that V1 named camelCase but PG schema uses snake_case.
// (covers every table currently in db/postgres/01..06_*.sql)
const TABLE_DEFAULT_MAP = {
    sites: 'sites',
    departments: 'departments',
    services: 'services',
    domains: 'domains',
    skills: 'skills',
    roles: 'roles',
    roleSkillRequirements: 'role_skill_requirements',
    admins: 'admins',
    password_history: 'password_history',
    login_attempts: 'login_attempts',
    adminScopes: 'admin_scopes',
    employees: 'employees',
    skillAssessments: 'skill_assessments',
    assessmentHistory: 'assessment_history',
    systemLogs: 'system_logs',
    sessions: 'session',
    appSettings: 'app_settings',
    snapshots: 'snapshots',
    reportTemplates: 'report_templates',
    selfAssessments: 'self_assessments',
    supervisorReviews: 'supervisor_reviews',
    trainingPlans: 'training_plans',
    trainingPlanItems: 'training_plan_items',
};

// Common boolean column names — values coerced 0/1 → true/false on PG.
const BOOLEAN_COLUMNS = new Set([
    'is_active',
    'is_critical',
    'is_account_active',
    'force_password_change',
    'is_public',
    'successful',
    // Newer boolean columns — keep in sync with PostgresDatabase.BOOLEAN_COLS.
    'is_org_root',
    'password_disabled',
    'is_primary',
    'mfa_enabled',
    'manual_override',
    'open_to_mobility',
]);

function camelToSnake(name) {
    if (!name || typeof name !== 'string') return name;
    return name
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase()
        .replace(/^_/, '');
}

function snakeToCamel(name) {
    if (!name || typeof name !== 'string') return name;
    return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function coerceBool(v) {
    if (v === 1 || v === '1') return true;
    if (v === 0 || v === '0') return false;
    return v;
}

class BaseModel {
    constructor(tableName) {
        this.tableName = tableName;
    }

    _table() {
        if (!IS_PG) return this.tableName;
        if (this.constructor.tableNamePg) return this.constructor.tableNamePg;
        return TABLE_DEFAULT_MAP[this.tableName] || camelToSnake(this.tableName);
    }

    _col(name) {
        if (!IS_PG) return name;
        const map = this.constructor.columnMap;
        if (map && map[name]) return map[name];
        return camelToSnake(name);
    }

    _translateConditions(conditions) {
        const out = {};
        for (const k of Object.keys(conditions)) {
            const dst = this._col(k);
            let v = conditions[k];
            if (IS_PG && BOOLEAN_COLUMNS.has(dst)) v = coerceBool(v);
            out[dst] = v;
        }
        return out;
    }

    _rowOut(row) {
        if (!row || !IS_PG) return row;
        // Per-class override map first
        const map = this.constructor.columnMap;
        let inv = null;
        if (map) {
            if (this.constructor._inverseMapCache) {
                inv = this.constructor._inverseMapCache;
            } else {
                inv = {};
                for (const [k, v] of Object.entries(map)) inv[v] = k;
                this.constructor._inverseMapCache = inv;
            }
        }
        const out = {};
        for (const k of Object.keys(row)) {
            const target = (inv && inv[k]) || snakeToCamel(k);
            out[target] = row[k];
        }
        return out;
    }

    _rowsOut(rows) {
        if (!rows || !IS_PG) return rows;
        if (Array.isArray(rows)) return rows.map((r) => this._rowOut(r));
        return this._rowOut(rows);
    }

    _translateOrderBy(orderBy) {
        if (!IS_PG || !orderBy) return orderBy;
        return orderBy
            .split(',')
            .map((p) => {
                const m = p.trim().match(/^([A-Za-z0-9_]+)(\s+(ASC|DESC))?$/i);
                if (!m) return p;
                return this._col(m[1]) + (m[2] ? m[2] : '');
            })
            .join(', ');
    }

    /**
     * Build `key = ?` / `key IN (?,?)` fragments from a translated conditions map,
     * pushing bind values into `params`. An ARRAY value becomes an IN-list (an
     * empty array becomes `IN (NULL)` → matches nothing) instead of being passed
     * to `= ?`, which node-pg would serialise as a PG array literal and Postgres
     * rejects (e.g. `invalid input syntax for type bigint: "{"11"}"`). This is
     * the path a scoped admin hits via `SiteModel.findAll({ id: siteIds })`.
     */
    // Guard against column-name injection: a key is interpolated directly into SQL,
    // so it must be a plain (optionally table-qualified) identifier. Callers pass
    // code-literal keys today, but this makes a future `req.query`-forwarding caller
    // fail loudly instead of becoming an injection vector.
    static _assertCol(key) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(String(key))) {
            throw new Error(`Unsafe column identifier: ${key}`);
        }
        return key;
    }

    _eqConditions(tx, params) {
        const list = [];
        for (const key of Object.keys(tx)) {
            BaseModel._assertCol(key);
            const v = tx[key];
            if (Array.isArray(v)) {
                if (v.length === 0) {
                    list.push(`${key} IN (NULL)`);
                    continue;
                }
                list.push(`${key} IN (${v.map(() => '?').join(', ')})`);
                params.push(...v);
            } else {
                list.push(`${key} = ?`);
                params.push(v);
            }
        }
        return list;
    }

    async findAll(conditions = {}, orderBy = 'id ASC', limit = null, offset = null) {
        let sql = `SELECT * FROM ${this._table()}`;
        const params = [];

        const tx = this._translateConditions(conditions);
        const conditionsList = this._eqConditions(tx, params);
        if (conditionsList.length > 0) {
            sql += ` WHERE ${conditionsList.join(' AND ')}`;
        }

        if (orderBy) sql += ` ORDER BY ${this._translateOrderBy(orderBy)}`;

        if (limit) {
            sql += ` LIMIT ?`;
            params.push(limit);
            if (offset) {
                sql += ` OFFSET ?`;
                params.push(offset);
            }
        }

        return this._rowsOut(await db.all(sql, params));
    }

    async findOne(conditions) {
        let sql = `SELECT * FROM ${this._table()}`;
        const params = [];

        const tx = this._translateConditions(conditions);
        const conditionsList = this._eqConditions(tx, params);

        if (conditionsList.length > 0) sql += ` WHERE ${conditionsList.join(' AND ')}`;
        sql += ` LIMIT 1`;
        return this._rowOut(await db.get(sql, params));
    }

    async findById(id) {
        return this._rowOut(await db.get(`SELECT * FROM ${this._table()} WHERE id = ?`, [id]));
    }

    async create(data) {
        const tx = this._translateConditions(data);
        const keys = Object.keys(tx);
        const placeholders = keys.map(() => '?').join(', ');
        const values = keys.map((k) => tx[k]);

        const sql = `INSERT INTO ${this._table()} (${keys.join(', ')}) VALUES (${placeholders})`;
        const result = await db.run(sql, values);
        return await this.findById(result.lastID);
    }

    async update(id, data) {
        const tx = this._translateConditions(data);
        const keys = Object.keys(tx);
        keys.forEach((k) => BaseModel._assertCol(k));
        const setClause = keys.map((k) => `${k} = ?`).join(', ');
        const values = [...keys.map((k) => tx[k]), id];

        const sql = `UPDATE ${this._table()} SET ${setClause} WHERE id = ?`;
        await db.run(sql, values);
        return await this.findById(id);
    }

    async delete(id) {
        return await db.run(`DELETE FROM ${this._table()} WHERE id = ?`, [id]);
    }

    async count(conditions = {}) {
        let sql = `SELECT COUNT(*) as count FROM ${this._table()}`;
        const params = [];

        const tx = this._translateConditions(conditions);
        const conditionsList = this._eqConditions(tx, params);
        if (conditionsList.length > 0) {
            sql += ` WHERE ${conditionsList.join(' AND ')}`;
        }

        const result = await db.get(sql, params);
        return Number(result.count || result.COUNT || 0);
    }
}

module.exports = BaseModel;
module.exports.camelToSnake = camelToSnake;
module.exports.snakeToCamel = snakeToCamel;
module.exports.IS_PG = IS_PG;
