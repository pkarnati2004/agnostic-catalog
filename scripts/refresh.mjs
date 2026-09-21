#!/usr/bin/env node
// Weekly refresh of the prices and the model seed from OpenRouter's public model list.
//
// GET https://openrouter.ai/api/v1/models returns { data: [...] }. This script reads four fields
// per entry: `id` (the canonical `vendor/name` the catalog joins on) and `pricing.prompt`,
// `pricing.completion`, `pricing.input_cache_read`, `pricing.input_cache_write` (USD per token,
// as decimal strings; absent when the vendor publishes no such price). Nothing else is read, and
// no other host is contacted. Prices are stored per million tokens, as agn's schema wants them.
//
// benchmarks, plans and entitlements are left alone: their sources are HTML pages, and this cut
// only automates the one source with an API. Exit 0 when nothing changed and when a changed
// catalog validates, 2 when it does not validate (the files stay on disk for the pull request),
// 1 when the fetch itself fails.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateCatalog } from "./catalog-rules.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG_PATH = join(ROOT, "catalog.json");
const MANIFEST_PATH = join(ROOT, "manifest.json");
const OVERRIDES_PATH = join(ROOT, "overrides.json");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_SOURCE = "openrouter";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, bytes);
  return bytes;
}

/**
 * OpenRouter quotes USD per token; six decimals of a per-million price is a hundredth of a cent.
 * A negative number is a sentinel rather than a price, and reads here the same as a missing one.
 */
function perMillion(price) {
  if (typeof price !== "string" || price.length === 0) {
    return null;
  }
  const parsed = Number(price);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1e12) / 1e6 : null;
}

/**
 * Every id OpenRouter lists, mapped to its price or to null when it quotes no usable one. The
 * unpriced id is kept because the two facts are separate: the model is still served, so it is not
 * legacy, and the row it has is better than a price nobody published.
 */
export function pricesFromOpenRouter(payload) {
  const listed = new Map();
  for (const entry of payload?.data ?? []) {
    if (typeof entry?.id !== "string") {
      continue;
    }
    const input = perMillion(entry.pricing?.prompt);
    const output = perMillion(entry.pricing?.completion);
    if (input === null || output === null) {
      listed.set(entry.id, null);
      continue;
    }
    listed.set(entry.id, {
      inputPerMillion: input,
      outputPerMillion: output,
      cacheReadPerMillion: perMillion(entry.pricing?.input_cache_read),
      cacheWritePerMillion: perMillion(entry.pricing?.input_cache_write),
    });
  }
  return listed;
}

async function fetchOpenRouter() {
  const response = await fetch(OPENROUTER_URL, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${OPENROUTER_URL} answered ${response.status}`);
  }
  const listed = pricesFromOpenRouter(await response.json());
  if ([...listed.values()].every((price) => price === null)) {
    throw new Error(`${OPENROUTER_URL} listed no priced models`);
  }
  return listed;
}

const vendorOf = (id) => id.slice(0, id.indexOf("/"));

/**
 * A seeded row whose model OpenRouter has dropped becomes legacy, never the other way round: the
 * flag is also set by hand for a model the vendor still sells but agn should stop suggesting.
 * Rows OpenRouter cannot speak for - a vendor it does not carry, or a model with a curated price -
 * are left as they are.
 */
export function refreshModels(rows, listed, curated) {
  const vendors = new Set([...listed.keys()].map(vendorOf));
  const marked = [];
  const kept = rows.map((row) => {
    const unknown =
      row.canonical !== null &&
      !listed.has(row.canonical) &&
      !curated.has(row.canonical) &&
      vendors.has(vendorOf(row.canonical));
    if (!unknown || row.legacy) {
      return row;
    }
    marked.push(`${row.harness}:${row.model}`);
    return { ...row, legacy: true };
  });
  const added = newOpenRouterRows(kept, listed);
  return { models: [...kept, ...added], marked, added };
}

/**
 * A harness on the openrouter route answers to every model OpenRouter serves, so its seed grows
 * with the vendors it is already seeded for. Ids carrying a `:variant` suffix are routing options
 * for a model already in the list, not models of their own, and an id OpenRouter quotes no price
 * for would join the seed with no row to bill it by.
 */
function newOpenRouterRows(rows, listed) {
  const routed = rows.filter((row) => row.route === "openrouter");
  const added = [];
  for (const harness of new Set(routed.map((row) => row.harness))) {
    const mine = routed.filter((row) => row.harness === harness);
    const vendors = new Set(mine.map((row) => vendorOf(row.model)));
    const seeded = new Set(mine.map((row) => row.model));
    for (const id of listed.keys()) {
      if (vendors.has(vendorOf(id)) && !seeded.has(id) && !id.includes(":") && listed.get(id)) {
        added.push({ harness, model: id, route: "openrouter", canonical: id, legacy: false });
      }
    }
  }
  return added.sort((a, b) => `${a.harness}${a.model}`.localeCompare(`${b.harness}${b.model}`));
}

const samePrice = (a, b) =>
  a.inputPerMillion === b.inputPerMillion &&
  a.outputPerMillion === b.outputPerMillion &&
  a.cacheReadPerMillion === b.cacheReadPerMillion &&
  a.cacheWritePerMillion === b.cacheWritePerMillion;

/**
 * One row per canonical id in the model seed, in the order the file already has them so a diff
 * reads as a price change. A curated row wins over OpenRouter; a model neither knows keeps the
 * row it has, and is reported so someone can add it to overrides.json.
 */
export function refreshPricing(existing, models, listed, curated, today) {
  const have = new Map(existing.map((row) => [row.model, row]));
  const wanted = [...new Set(models.map((row) => row.canonical).filter((id) => id !== null))];
  const order = [...existing.map((row) => row.model), ...wanted.filter((id) => !have.has(id))];
  const pricing = [];
  const changed = [];
  const missing = [];
  for (const model of order) {
    const before = have.get(model) ?? null;
    const after = curated.get(model) ?? priced(model, listed.get(model), today);
    if (after === null) {
      missing.push(model);
      if (before !== null) {
        pricing.push(before);
      }
      continue;
    }
    if (before === null || !samePrice(before, after) || before.source !== after.source) {
      changed.push(describeChange(model, before, after));
      pricing.push(after);
      continue;
    }
    pricing.push(before);
  }
  return { pricing, changed, missing };
}

function priced(model, price, today) {
  return price == null ? null : { model, ...price, source: OPENROUTER_SOURCE, asOf: today };
}

function describeChange(model, before, after) {
  const was = before === null ? "new" : `${before.inputPerMillion}/${before.outputPerMillion}`;
  return `${model}: ${was} -> ${after.inputPerMillion}/${after.outputPerMillion} per Mtok`;
}

/** The day a price or a page was read changes every week; the numbers are what a new version is for. */
function content(catalog) {
  return JSON.stringify({
    ...catalog,
    version: 0,
    generatedAt: "",
    sources: catalog.sources.map((row) => ({ ...row, fetchedAt: "" })),
    pricing: catalog.pricing.map((row) => ({ ...row, asOf: "" })),
  });
}

export function contentChanged(before, after) {
  return content(before) !== content(after);
}

export function manifestFor(catalog, bytes) {
  return {
    schemaVersion: catalog.schemaVersion,
    version: catalog.version,
    generatedAt: catalog.generatedAt,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** The candidate catalog, one version on from `current`, with today's dates on what was fetched. */
export function refreshCatalog(current, listed, overrides, now) {
  const today = now.toISOString().slice(0, 10);
  const curated = new Map((overrides.pricing ?? []).map((row) => [row.model, row]));
  const { models, marked, added } = refreshModels(current.models, listed, curated);
  const { pricing, changed, missing } = refreshPricing(
    current.pricing,
    models,
    listed,
    curated,
    today,
  );
  const candidate = {
    ...current,
    sources: current.sources.map((row) =>
      row.id === OPENROUTER_SOURCE ? { ...row, fetchedAt: today } : row,
    ),
    models,
    pricing,
  };
  if (!contentChanged(current, candidate)) {
    return { catalog: current, changed: false, report: { marked, added, changed, missing } };
  }
  candidate.version = current.version + 1;
  candidate.generatedAt = now.toISOString();
  return { catalog: candidate, changed: true, report: { marked, added, changed, missing } };
}

function report(current, catalog, changed, detail) {
  const lines = detail.changed.map((line) => `  price ${line}`);
  lines.push(...detail.added.map((row) => `  model + ${row.harness}:${row.model}`));
  lines.push(...detail.marked.map((id) => `  model legacy ${id}`));
  lines.push(...detail.missing.map((id) => `  no price for ${id}; add it to overrides.json`));
  lines.push(
    changed
      ? `catalog version ${current.version} -> ${catalog.version}`
      : "catalog unchanged; nothing to publish",
  );
  console.log(lines.join("\n"));
}

/** The manifest is rewritten whenever it disagrees with the file, which is how a hand edit ships. */
function publish(catalog, changed) {
  const bytes = changed ? writeJson(CATALOG_PATH, catalog) : readFileSync(CATALOG_PATH, "utf8");
  const manifest = manifestFor(catalog, bytes);
  if (JSON.stringify(readJson(MANIFEST_PATH)) !== JSON.stringify(manifest)) {
    writeJson(MANIFEST_PATH, manifest);
    return true;
  }
  return changed;
}

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const current = readJson(CATALOG_PATH);
  const overrides = readJson(OVERRIDES_PATH);
  const listed = await fetchOpenRouter();
  const refreshed = refreshCatalog(current, listed, overrides, new Date());
  report(current, refreshed.catalog, refreshed.changed, refreshed.report);
  const problems = validateCatalog(refreshed.catalog);
  if (problems.length > 0) {
    console.error(`catalog is not valid:\n${problems.map((line) => `  ${line}`).join("\n")}`);
  }
  if (!dryRun && publish(refreshed.catalog, refreshed.changed) && !refreshed.changed) {
    console.log("manifest.json did not match catalog.json and was rewritten");
  }
  return problems.length > 0 ? 2 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await main(process.argv.slice(2)));
}
