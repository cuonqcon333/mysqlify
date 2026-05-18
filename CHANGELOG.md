# Changelog

## [0.5.1] - 2026-05-18

### Fixed
- **Robust Test Separation:** Enforced architectural unit/integration separation using isolated Jest configuration files (`jest.config.js` and `jest.integration.config.js`).
- **Integration Test Self-Guarding:** Wrapped integration smoke tests in a dynamic conditional skip mechanism relying on the explicit `MYSQLIFY_RUN_INTEGRATION=1` environment variable.
- **CI Workflow Hardening:** Configured CI workflow in `.github/workflows/ci.yml` to call `npm test` natively to ensure completely Docker-free, offline-safe unit tests.

## [0.5.0] - 2026-05-18

### Added
- **Real Engine Integration Matrix:** Orchestrated multi-engine integration test harness using Docker Compose supporting MySQL 5.7, MySQL 8.0, and MariaDB 10.5.
- **Advanced Alter Actions:** Native support for `change()`, `dropColumn()`, and `renameColumn()` in migration Schema table builder.
- **Support Matrix Documentation:** Documented vendor floors and caveats for dynamic features inside README.md.

### Fixed
- **Dynamic Defaults Quoting Bug:** Corrected `src/schema-builder.js` to serialize dynamic SQL expressions (`CURRENT_TIMESTAMP`, `NOW()`, etc.) as unquoted functions instead of string literals.
- **Relations & Eager Loading:** Resolved connection shadowing and eager loading on transaction-bound models.

## [1.0.0] - 2026-05-12

### Added
- Fluent query builder with full chainable API (`where`, `whereIn`, `join`, `orderBy`, `paginate`, etc.)
- Eloquent-style base `Model` class with static query methods, instance `save()`/`destroy()`, soft deletes, relationships
- Schema builder with Laravel-style column types (`id`, `string`, `timestamps`, `softDeletes`, etc.)
- Migration system with `migrate:up`, `migrate:rollback`, `migrate:status`
- CLI: `make:migration`, `make:model`, `make:model --migration`
- Built-in security: SQL injection prevention, XSS sanitization, mass assignment protection, identifier validation
- Dual CJS + ESM build (`dist/cjs`, `dist/esm`)
- Connection pooling with configurable `connectionLimit` and `acquireTimeout`
- Audit logging support
- 64 unit tests (security, query builder, model)
