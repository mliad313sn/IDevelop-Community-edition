/** @type {import('jest').Config} */
module.exports = {
    // The stock node environment plus __nativeRequire for ES-module dependencies
    // (see tests/helpers/nativeEsmEnvironment.js).
    testEnvironment: '<rootDir>/tests/helpers/nativeEsmEnvironment.js',
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
        // Ratchet, re-based 2026-10-02 on what CI actually runs: the full suite
        // against a freshly migrated and seeded *_test database, as in
        // .github/workflows/ci.yml. The previous figures were measured with the
        // populated fixtures database, which also runs ~12 fixture-only suites
        // (they skip unless DATABASE_URL contains "idevelop_fixtures"), so CI could
        // never reach them. Set 1 point below the CI measure and floored.
        // Coverage may only go up: raise these when it does, never lower them.
        //   CI measure: middleware above its floor
        //               services    S66.23 B57.16 F66.68 L68.39
        //               controllers S30.32 B25.04 F26.83 L30.73
        //               routes      S53.23 B26.33 F32.73 L55.41
        './src/middleware/': { lines: 74, statements: 73, functions: 77, branches: 67 },
        './src/services/': { lines: 67, statements: 65, functions: 65, branches: 56 },
        './src/controllers/': { lines: 29, statements: 29, functions: 25, branches: 24 },
        './src/routes/': { lines: 54, statements: 52, functions: 31, branches: 25 },
    },
    clearMocks: true,
    restoreMocks: true,
    verbose: true,
};
