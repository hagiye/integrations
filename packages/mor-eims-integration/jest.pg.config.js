/**
 * Postgres-backed tests: the standalone example (invoices, the EIMS sequence row, receipts,
 * credentials, the exchange log) against a mock MoR gateway, over HTTP.
 * Needs a throwaway database: MOR_TEST_DATABASE_URL=postgres://user:pass@host:5432/db
 */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>/test"],
  testRegex: ".*\\.pg-spec\\.ts$",
  transform: { "^.+\\.ts$": "ts-jest" },
  // The example app imports the package by name, as a real host would.
  moduleNameMapper: { "^@edr/mor-eims-integration$": "<rootDir>/src/index.ts" },
  setupFiles: ["<rootDir>/test/jest.setup.ts"],
  testEnvironment: "node",
  testTimeout: 60000,
};
