# Changelog

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
