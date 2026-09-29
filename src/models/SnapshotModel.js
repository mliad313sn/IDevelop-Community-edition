const BaseModel = require('./BaseModel');
const db = require('../config/database');

class SnapshotModel extends BaseModel {
    constructor() {
        super('snapshots');
    }

    async findAll(orderBy = 'createdAt DESC') {
        return await db.all(`SELECT * FROM ${this.tableName} ORDER BY ${orderBy}`);
    }

    async findByIdWithCreator(id) {
        return await db.get(
            `
            SELECT s.*, a.username as createdByUsername
            FROM snapshots s
            LEFT JOIN admins a ON s.createdBy = a.id
            WHERE s.id = ?
        `,
            [id]
        );
    }

    async findAllWithCreator(orderBy = 'createdAt DESC') {
        return await db.all(`
            SELECT s.*, a.username as createdByUsername
            FROM snapshots s
            LEFT JOIN admins a ON s.createdBy = a.id
            ORDER BY ${orderBy}
        `);
    }

    /**
     * Stored size and captured-entity counts per snapshot.
     * The list showed name/creator/date only, so nobody could tell a full capture
     * from an empty one. Size is the on-disk size of the JSONB document; the
     * counts are the top-level arrays the snapshot actually holds — measured,
     * never assumed (a key the snapshot does not carry is simply absent).
     */
    async sizesById() {
        const rows = await db.all(`
            SELECT id,
                   pg_column_size(snapshot_data) AS bytes,
                   (SELECT jsonb_object_agg(k, jsonb_array_length(v))
                      FROM jsonb_each(snapshot_data) AS e(k, v)
                     WHERE jsonb_typeof(v) = 'array') AS counts
              FROM snapshots
        `);
        const out = {};
        for (const r of rows)
            out[Number(r.id)] = { bytes: Number(r.bytes) || 0, counts: r.counts || {} };
        return out;
    }
}

module.exports = new SnapshotModel();
