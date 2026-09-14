# agnostic-catalog

The data [agnostic](https://github.com/pkarnati2004/agnostic) scores and bills with: published
benchmark results and where each came from, the models each agent answers to, the plans each
vendor sells, what those plans include, and token prices. agnostic ships with a snapshot of this
file and checks here once a day for a newer one.

## Files

```
catalog.json      # the catalog itself (schemaVersion, version, generatedAt, sources, benchmarks, models, plans, entitlements, pricing)
manifest.json     # what the daily check reads: schemaVersion, version, generatedAt, sha256 of catalog.json
```

`manifest.version` equals `catalog.json`'s `version`, `manifest.schemaVersion` equals its
`schemaVersion`, and `manifest.sha256` is the digest of `catalog.json`'s bytes exactly as served.
agnostic downloads only when `version` is higher than the one it uses and refuses a download where
any of the three disagree, so write the catalog first, then the manifest, and publish both together.

## Publishing a new version

1. Edit `catalog.json`; bump `version` by one and set `generatedAt`.
2. Regenerate the manifest:

```bash
node -e '
const fs=require("fs"),c=require("crypto");
const body=fs.readFileSync("catalog.json","utf8"),d=JSON.parse(body);
fs.writeFileSync("manifest.json",JSON.stringify({schemaVersion:d.schemaVersion,version:d.version,generatedAt:d.generatedAt,sha256:c.createHash("sha256").update(body).digest("hex")},null,2)+"\n");'
```

3. Commit both files together and push to `main`. agnostic reads them from the raw URL of this
   branch.

## Sources and terms

Every benchmark row names a source, and the `sources` table records where the numbers come from
and the terms each source publishes under. Scores are aggregated with attribution; nothing here is
a reproduction of a source's own text.
