'use strict';

/**
 * BaseModel.create() applies the same column-identifier guard as update():
 * the keys of `data` are interpolated into the INSERT column list, so a key
 * that is not a plain identifier must be refused before any SQL is sent.
 * UnifiedJsonService resolves an imported scope type through own keys only.
 */
const mockDb = {
    get: jest.fn(async () => ({ id: 1 })),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ lastID: 1, changes: 1 })),
};
jest.mock('../../src/config/database', () => mockDb);

const fs = require('fs');
const path = require('path');
const BaseModel = require('../../src/models/BaseModel');

class Thing extends BaseModel {
    constructor() {
        super('things');
    }
}

beforeEach(() => mockDb.run.mockClear());

test('create() refuses an unsafe column key and sends nothing', async () => {
    const m = new Thing();
    await expect(m.create({ name: 'x', 'name) VALUES (1); --': 'y' })).rejects.toThrow(
        /Unsafe column identifier/
    );
    expect(mockDb.run).not.toHaveBeenCalled();
});

test('create() accepts plain identifiers', async () => {
    const m = new Thing();
    await m.create({ name: 'x', isActive: true });
    expect(mockDb.run).toHaveBeenCalledTimes(1);
    expect(mockDb.run.mock.calls[0][0]).toMatch(/^INSERT INTO things \(/);
});

test('UnifiedJsonService maps the imported scope type through own keys only', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/services/UnifiedJsonService.js'),
        'utf8'
    );
    expect(src).not.toMatch(/tableByType\[sc\.type\]/);
    expect(src).toMatch(/Object\.hasOwn\(tableByType, t\)/);
    expect(src).toMatch(/Object\.hasOwn\(colByType, t\)/);
});
