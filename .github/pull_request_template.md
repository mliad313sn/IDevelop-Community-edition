## What and why

<!-- What does this change do, and which problem does it solve? Link the issue. -->

## How it was tested

- [ ] `npm run lint && npm run format:check`
- [ ] `npm test` against a migrated + seeded `*_test` database
- [ ] Manual check (describe) / screenshots with invented data only

## Checklist

- [ ] Strings added in both `locales/fr` and `locales/en`
- [ ] Schema changes are a new numbered, idempotent migration
- [ ] `npm run contracts:export` run if the API, palette or product identity changed
- [ ] No real personal data, credentials or organisation names in code, tests or screenshots
