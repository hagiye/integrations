/**
 * Postgres-backed tests: the standalone example (devices, positions, alerts, geofences) with its
 * GT06 listener on 127.0.0.1, driven by the device simulator over real TCP.
 * Needs a throwaway database: GPS_TEST_DATABASE_URL=postgres://user:pass@host:5432/db
 */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>/test"],
  testRegex: ".*\\.pg-spec\\.ts$",
  transform: { "^.+\\.ts$": "ts-jest" },
  // The example app imports the package by name, as a real host would.
  moduleNameMapper: { "^@edr/gps-integration$": "<rootDir>/src/index.ts" },
  setupFiles: ["<rootDir>/test/jest.setup.ts"],
  testEnvironment: "node",
  testTimeout: 30000,
};
