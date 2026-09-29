/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/tests/unit', '<rootDir>/src'],
    testMatch: ['**/?(*.)+(test|spec).js'],
    testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/'],
    collectCoverage: false,
    collectCoverageFrom: ['src/**/*.js', '!src/scripts/**', '!src/database/migrations/**'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text-summary', 'lcov', 'json-summary'],
    coverageThreshold: {
        // Phase-0 baseline. Raise per phase as modules land.
        global: { lines: 0, functions: 0, branches: 0, statements: 0 },
        // 3.23.18 (CQ-02) ratchet: measured 2026-09-27 on the full suite against
        // the test database (aggregate per directory, subfolders included), set 1 point
        // below the measure and floored. Coverage may only go up: raise these when
        // it does, never lower them. Applies only to `npx jest --coverage` on the
        // WHOLE suite (a partial run under --coverage will trip it), and the DB
        // suites must be able to reach the test database.
        //   measured: middleware L75.48 S74.94 F78.85 B68.20
        //             services   L72.11 S69.60 F73.45 B59.83
        //             controllers L50.16 S49.74 F58.55 B38.57
        //             routes     L63.87 S61.82 F54.84 B34.52
        './src/middleware/': { lines: 74, statements: 73, functions: 77, branches: 67 },
        './src/services/': { lines: 71, statements: 68, functions: 72, branches: 58 },
        './src/controllers/': { lines: 49, statements: 48, functions: 57, branches: 37 },
        './src/routes/': { lines: 62, statements: 60, functions: 53, branches: 33 },
    },
    clearMocks: true,
    restoreMocks: true,
    verbose: true,
};
