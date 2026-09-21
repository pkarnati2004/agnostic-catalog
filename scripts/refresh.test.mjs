import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateCatalog } from "./catalog-rules.mjs";
import {
  contentChanged,
  manifestFor,
  pricesFromOpenRouter,
  refreshCatalog,
  refreshModels,
  refreshPricing,
} from "./refresh.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOW = new Date("2026-09-21T06:00:00.000Z");

function fixtureCatalog() {
  return {
    schemaVersion: 1,
    version: 4,
    generatedAt: "2026-09-01T00:00:00.000Z",
    sources: [
      {
        id: "openrouter",
        name: "OpenRouter model list",
        url: "https://openrouter.ai/api/v1/models",
        terms: "Public model and pricing API.",
        fetchedAt: "2026-09-01",
      },
    ],
    benchmarks: [],
    models: [
      { harness: "codex", model: "gpt-6-astra", route: "native", canonical: "openai/gpt-6-astra", legacy: false },
      { harness: "pi", model: "openai/gpt-6-astra", route: "openrouter", canonical: "openai/gpt-6-astra", legacy: false },
    ],
    plans: [{ vendor: "chatgpt", id: "pro", displayName: "Pro", confirmedAt: "2026-09-01" }],
    entitlements: [
      { harness: "codex", model: "gpt-6-astra", vendor: "chatgpt", plan: "pro", access: "included" },
    ],
    pricing: [
      {
        model: "openai/gpt-6-astra",
        inputPerMillion: 10,
        outputPerMillion: 50,
        cacheReadPerMillion: 1,
        cacheWritePerMillion: 12.5,
        source: "openrouter",
        asOf: "2026-09-01",
      },
    ],
  };
}

/** The four pricing fields the script reads, as OpenRouter serves them: USD per token, as strings. */
function openRouterPayload(prompt = "0.00001", completion = "0.00005") {
  return {
    data: [
      {
        id: "openai/gpt-6-astra",
        pricing: {
          prompt,
          completion,
          input_cache_read: "0.000001",
          input_cache_write: "0.0000125",
        },
      },
    ],
  };
}

test("the validator accepts the published catalog", () => {
  const catalog = JSON.parse(readFileSync(join(ROOT, "catalog.json"), "utf8"));
  assert.deepEqual(validateCatalog(catalog), []);
});

test("the validator rejects a negative price", () => {
  const catalog = fixtureCatalog();
  catalog.pricing[0].inputPerMillion = -1;
  assert.deepEqual(validateCatalog(catalog), [
    "pricing[0].inputPerMillion: -1 is not allowed here",
  ]);
});

test("the validator rejects a source with no url", () => {
  const catalog = fixtureCatalog();
  delete catalog.sources[0].url;
  assert.deepEqual(validateCatalog(catalog), ["sources[0].url: null is not allowed here"]);
});

test("the validator rejects a benchmark row pointing at no source", () => {
  const catalog = fixtureCatalog();
  catalog.benchmarks.push({
    source: "nowhere",
    date: "2026-09-01",
    benchmark: "SWE-bench Verified",
    model: "openai/gpt-6-astra",
    modelVersion: null,
    harness: "codex",
    harnessVersion: null,
    taskClass: "implement",
    metric: "resolved",
    score: 70,
    n: 500,
    costUsd: null,
    tokens: null,
    notes: "",
  });
  assert.deepEqual(validateCatalog(catalog), ['benchmarks[0].source: no source row "nowhere"']);
});

test("per-token strings become per-million numbers with no float dust", () => {
  const listed = pricesFromOpenRouter(openRouterPayload());
  assert.deepEqual(listed.get("openai/gpt-6-astra"), {
    inputPerMillion: 10,
    outputPerMillion: 50,
    cacheReadPerMillion: 1,
    cacheWritePerMillion: 12.5,
  });
});

test("identical prices leave the version and the file alone", () => {
  const current = fixtureCatalog();
  const listed = pricesFromOpenRouter(openRouterPayload());
  const result = refreshCatalog(current, listed, { pricing: [] }, NOW);
  assert.equal(result.changed, false);
  assert.equal(result.catalog.version, 4);
  assert.equal(result.catalog.generatedAt, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(result.report.changed, []);
});

test("a new price bumps the version once and dates the fetch", () => {
  const current = fixtureCatalog();
  const listed = pricesFromOpenRouter(openRouterPayload("0.00002"));
  const result = refreshCatalog(current, listed, { pricing: [] }, NOW);
  assert.equal(result.changed, true);
  assert.equal(result.catalog.version, 5);
  assert.equal(result.catalog.generatedAt, NOW.toISOString());
  assert.equal(result.catalog.pricing[0].inputPerMillion, 20);
  assert.equal(result.catalog.pricing[0].asOf, "2026-09-21");
  assert.equal(result.catalog.sources[0].fetchedAt, "2026-09-21");
  assert.deepEqual(validateCatalog(result.catalog), []);
});

test("a later fetch date on its own is not a content change", () => {
  const before = fixtureCatalog();
  const after = fixtureCatalog();
  after.sources[0].fetchedAt = "2026-09-21";
  after.pricing[0].asOf = "2026-09-21";
  assert.equal(contentChanged(before, after), false);
});

test("a curated override wins over OpenRouter and keeps its own date", () => {
  const current = fixtureCatalog();
  const curated = new Map([
    [
      "openai/gpt-6-astra",
      {
        model: "openai/gpt-6-astra",
        inputPerMillion: 9,
        outputPerMillion: 45,
        cacheReadPerMillion: null,
        cacheWritePerMillion: null,
        source: "curated",
        asOf: "2026-08-01",
      },
    ],
  ]);
  const listed = pricesFromOpenRouter(openRouterPayload());
  const result = refreshPricing(current.pricing, current.models, listed, curated, "2026-09-21");
  assert.equal(result.pricing.length, 1);
  assert.equal(result.pricing[0].inputPerMillion, 9);
  assert.equal(result.pricing[0].asOf, "2026-08-01");
  assert.deepEqual(result.missing, []);
});

test("a model nobody prices keeps its row and is reported", () => {
  const current = fixtureCatalog();
  current.models.push({
    harness: "claude-code",
    model: "local-thing",
    route: "local",
    canonical: "acme/local-thing",
    legacy: false,
  });
  const result = refreshPricing(current.pricing, current.models, new Map(), new Map(), "2026-09-21");
  assert.deepEqual(result.missing, ["openai/gpt-6-astra", "acme/local-thing"]);
  assert.deepEqual(result.pricing, current.pricing);
});

test("a price OpenRouter quotes as negative reads as no price at all", () => {
  const listed = pricesFromOpenRouter(openRouterPayload("-1"));
  assert.equal(listed.get("openai/gpt-6-astra"), null);
  const current = fixtureCatalog();
  const result = refreshPricing(current.pricing, current.models, listed, new Map(), "2026-09-21");
  assert.deepEqual(result.pricing, current.pricing);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.missing, ["openai/gpt-6-astra"]);
});

/** `pi` is seeded with one openai model, so every other openai model OpenRouter serves fits it. */
function seedListing() {
  return new Map([
    ["openai/gpt-6-astra", { inputPerMillion: 10, outputPerMillion: 50 }],
    ["openai/gpt-6-nova", { inputPerMillion: 1, outputPerMillion: 5 }],
    ["openai/gpt-6-nova:free", { inputPerMillion: 0, outputPerMillion: 0 }],
    ["openai/gpt-6-mute", null],
    ["acme/unrelated", { inputPerMillion: 1, outputPerMillion: 1 }],
  ]);
}

test("the seed grows with the vendor a harness already runs, and only with it", () => {
  const current = fixtureCatalog();
  const { models, added, marked } = refreshModels(current.models, seedListing(), new Map());
  assert.deepEqual(marked, []);
  assert.deepEqual(added, [
    {
      harness: "pi",
      model: "openai/gpt-6-nova",
      route: "openrouter",
      canonical: "openai/gpt-6-nova",
      legacy: false,
    },
  ]);
  assert.equal(models.length, current.models.length + 1);
  // codex is on the native route, so its seed is hand-written and never grows from the list.
  assert.deepEqual(models.filter((row) => row.harness === "codex"), [current.models[0]]);
});

test("a model OpenRouter has dropped becomes legacy, and one it never carried does not", () => {
  const current = fixtureCatalog();
  current.models.push({
    harness: "pi",
    model: "acme/gone",
    route: "openrouter",
    canonical: "acme/gone",
    legacy: false,
  });
  const listed = new Map([["openai/gpt-6-nova", { inputPerMillion: 1, outputPerMillion: 5 }]]);
  const { models, marked } = refreshModels(current.models, listed, new Map());
  assert.deepEqual(marked, ["codex:gpt-6-astra", "pi:openai/gpt-6-astra"]);
  assert.equal(models.find((row) => row.harness === "pi" && row.legacy).model, "openai/gpt-6-astra");
  // acme is a vendor OpenRouter does not carry at all, so its absence says nothing about the model.
  assert.equal(models.find((row) => row.model === "acme/gone").legacy, false);
});

test("a model marked legacy by hand stays legacy while OpenRouter still lists it", () => {
  const current = fixtureCatalog();
  current.models[1].legacy = true;
  const { models, marked } = refreshModels(current.models, seedListing(), new Map());
  assert.deepEqual(marked, []);
  assert.equal(models[1].legacy, true);
});

test("a model with a curated price is never marked legacy", () => {
  const current = fixtureCatalog();
  const curated = new Map([["openai/gpt-6-astra", { model: "openai/gpt-6-astra" }]]);
  const listed = new Map([["openai/gpt-6-nova", { inputPerMillion: 1, outputPerMillion: 5 }]]);
  const { marked } = refreshModels(current.models, listed, curated);
  assert.deepEqual(marked, []);
});

test("the published manifest carries the sha256 of the published catalog", () => {
  const bytes = readFileSync(join(ROOT, "catalog.json"), "utf8");
  const published = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  assert.deepEqual(manifestFor(JSON.parse(bytes), bytes), published);
});

test("the manifest sha covers the bytes the script writes", () => {
  const catalog = fixtureCatalog();
  const bytes = `${JSON.stringify(catalog, null, 2)}\n`;
  const manifest = manifestFor(catalog, bytes);
  assert.equal(manifest.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(manifest.version, catalog.version);
  assert.equal(manifest.schemaVersion, catalog.schemaVersion);
  assert.equal(manifest.generatedAt, catalog.generatedAt);
});
