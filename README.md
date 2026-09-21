# agnostic-catalog

The data [agnostic](https://github.com/pkarnati2004/agnostic) scores and bills with: published
benchmark results and where each came from, the models each agent answers to, the plans each
vendor sells, what those plans include, and token prices. agnostic ships with a snapshot of this
file and checks here once a day for a newer one.

## Files

```
catalog.json      # the catalog itself (schemaVersion, version, generatedAt, sources, benchmarks, models, plans, entitlements, pricing)
manifest.json     # what the daily check reads: schemaVersion, version, generatedAt, sha256 of catalog.json
overrides.json    # pricing rows for models OpenRouter does not list, written by hand
scripts/          # the weekly refresh and the schema rules it validates against
```

`manifest.version` equals `catalog.json`'s `version`, `manifest.schemaVersion` equals its
`schemaVersion`, and `manifest.sha256` is the digest of `catalog.json`'s bytes exactly as served.
agnostic downloads only when `version` is higher than the one it uses and refuses a download where
any of the three disagree, so write the catalog first, then the manifest, and publish both together.

## Refresh

`.github/workflows/refresh.yml` runs `scripts/refresh.mjs` every Monday at 06:00 UTC, and on
demand from the Actions tab. The script reads OpenRouter's public model list,
`https://openrouter.ai/api/v1/models`, which needs no key, and:

- rewrites every `pricing` row from the per-token prices OpenRouter publishes, stored per million
  tokens;
- adds a `models` row for each model a harness on the `openrouter` route can reach under a vendor
  it is already seeded for, and marks a seeded model OpenRouter has dropped as `legacy`;
- dates the `openrouter` row in `sources` with the day of the fetch.

`benchmarks`, `plans` and `entitlements` come from pages with no API, and this refresh leaves them
alone. The script bumps `version` and sets `generatedAt` only when a number moved, so a week with
the same prices publishes nothing and agnostic downloads nothing.

When something changed, the Action commits `catalog.json` and `manifest.json` to `main` with the
message `Publish catalog version <n>`. When the result does not pass the rules in
`scripts/catalog-rules.mjs`, the Action publishes nothing and opens a pull request titled "Catalog
refresh failed validation" carrying the refreshed files and the script's output.

`scripts/catalog-rules.mjs` is the set of rules agnostic applies to a download, written again in
plain JS. `packages/catalog/src/catalog-schema.ts` in the agnostic repo is the source of truth: a
change there needs the same change here in the same week, and nothing checks the drift for you.

### Prices OpenRouter does not list

`overrides.json` holds whole `pricing` rows for models missing from OpenRouter's list. A row here
wins over the fetched price and keeps its own `asOf`:

```json
{
  "pricing": [
    {
      "model": "vendor/model-name",
      "inputPerMillion": 1.5,
      "outputPerMillion": 7.5,
      "cacheReadPerMillion": null,
      "cacheWritePerMillion": null,
      "source": "curated",
      "asOf": "2026-09-21"
    }
  ]
}
```

A model that neither source prices keeps the row it has, and the run names it so someone can add
it here.

### Running it by hand

```bash
node scripts/refresh.mjs --dry-run      # fetch, print what would change, write nothing
node scripts/refresh.mjs                # write catalog.json and manifest.json
node --test scripts/*.test.mjs          # the rules, the version bump, the manifest digest
```

The script exits 0 when nothing changed and when a changed catalog is valid, 2 when the catalog it
produced is not valid, and 1 when the fetch fails.

To publish an edit the refresh does not make - a new benchmark row, a plan, an entitlement - edit
`catalog.json`, bump its `version` by one, set `generatedAt`, then run `node scripts/refresh.mjs`
to rewrite the manifest, and commit both files together.

## Sources and terms

Every benchmark row names a source, and the `sources` table records where the numbers come from
and the terms each source publishes under. Scores are aggregated with attribution; nothing here is
a reproduction of a source's own text.
