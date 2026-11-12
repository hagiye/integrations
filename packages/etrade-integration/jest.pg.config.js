/**
 * Postgres-backed tests: the standalone example (companies, profiles, licence snapshots,
 * lookup log, shared TIN budget) against a mock e-trade, over HTTP.
 * Needs a throwaway database: ETRADE_TEST_DATABASE_URL=postgres://user:pass@host:5432/db
 */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>/test"],
  testRegex: ".*\\.pg-spec\\.ts$",
  transform: { "^.+\\.ts$": "ts-jest" },
  // The example app imports the package by name, as a real host would.
  moduleNameMapper: { "^@edr/etrade-integration$": "<rootDir>/src/index.ts" },
  setupFiles: ["<rootDir>/test/jest.setup.ts"],
  testEnvironment: "node",
  testTimeout: 30000,
};
