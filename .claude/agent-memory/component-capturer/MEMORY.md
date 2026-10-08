# component-capturer memory

Observations from capturing component types. Newest first. Each entry: date, fact, source.
Keep under 200 lines (only the first 200 load); merge or delete stale entries.
src/component-library.js is the source of truth for shapes - do not copy shapes here.

## Observations

- 2026-10-06 - Atlassian publishes no schema for component `value` objects; per Atlassian support, the identifier must come from an exported rule. Source: component-library.js header.
- 2026-10-06 - Two original exports contained literal secrets (an OAuth client secret, a webhook signing key); always scan an export for secrets before copying. Source: component-library.js header.
- 2026-10-06 - The API accepts many project ARIs in eventFilters (Auto-Triage.txt scopes to 7); the builder allows one by policy. Do not "fix" this. Source: component-library.js trigger notes.
