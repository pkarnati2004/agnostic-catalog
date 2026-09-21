import assert from "node:assert/strict";
import test from "node:test";
import { validateCatalog } from "./catalog-rules.mjs";

/** One row per table, all valid, so each test can break exactly one thing. */
function catalog() {
  return {
    schemaVersion: 1,
    version: 7,
    generatedAt: "2026-09-21T06:00:00.000Z",
    sources: [
      {
        id: "swe-bench",
        name: "SWE-bench leaderboards",
        url: "https://www.swebench.com/",
        terms: "MIT (SWE-bench project).",
        fetchedAt: "2026-09-21",
      },
    ],
    benchmarks: [
      {
        source: "swe-bench",
        date: "2026-09-01",
        benchmark: "SWE-bench Verified",
        model: "openai/gpt-6-astra",
        modelVersion: null,
        harness: "codex",
        harnessVersion: null,
        taskClass: "implement",
        metric: "resolved",
        score: 74.5,
        n: 500,
        costUsd: null,
        tokens: null,
        notes: "",
      },
    ],
    models: [
      {
        harness: "codex",
        model: "gpt-6-astra",
        route: "native",
        canonical: "openai/gpt-6-astra",
        legacy: false,
      },
    ],
    plans: [{ vendor: "chatgpt", id: "pro", displayName: "Pro", confirmedAt: "2026-09-21" }],
    entitlements: [
      { harness: "codex", model: "gpt-6-astra", vendor: "chatgpt", plan: "pro", access: "included" },
    ],
    pricing: [
      {
        model: "openai/gpt-6-astra",
        inputPerMillion: 10,
        outputPerMillion: 50,
        cacheReadPerMillion: 1,
        cacheWritePerMillion: null,
        source: "openrouter",
        asOf: "2026-09-21",
      },
    ],
  };
}

test("the fixture is valid", () => {
  assert.deepEqual(validateCatalog(catalog()), []);
});

test("a schema version agn does not read is a failure", () => {
  const broken = { ...catalog(), schemaVersion: 2 };
  assert.deepEqual(validateCatalog(broken), ["schemaVersion: expected 1, found 2"]);
});

test("a field agn's schema has no room for is a failure", () => {
  const broken = catalog();
  broken.pricing[0].discount = 0.5;
  assert.deepEqual(validateCatalog(broken), ["pricing[0].discount: agn's schema has no such field"]);
});

test("a table agn's schema has no room for is a failure", () => {
  const broken = { ...catalog(), promotions: [] };
  assert.deepEqual(validateCatalog(broken), ["promotions: agn's schema has no such key"]);
});

test("a missing field is a failure", () => {
  const broken = catalog();
  delete broken.models[0].legacy;
  assert.deepEqual(validateCatalog(broken), ["models[0].legacy: null is not allowed here"]);
});

const enumCases = [
  ["a harness nobody has an entry for", (c) => (c.models[0].harness = "claude"), "models[0].harness"],
  ["a route no executor speaks", (c) => (c.models[0].route = "grpc"), "models[0].route"],
  ["a task class the classifier never answers", (c) => (c.benchmarks[0].taskClass = "qa"), "benchmarks[0].taskClass"],
  ["an access word billing cannot read", (c) => (c.entitlements[0].access = "maybe"), "entitlements[0].access"],
  ["a price from an unnamed source", (c) => (c.pricing[0].source = "a friend"), "pricing[0].source"],
  ["a plan vendor that bills nothing", (c) => (c.plans[0].vendor = "google"), "plans[0].vendor"],
];

for (const [name, breakIt, path] of enumCases) {
  test(`${name} is a failure`, () => {
    const broken = catalog();
    breakIt(broken);
    const problems = validateCatalog(broken);
    assert.equal(problems[0].startsWith(`${path}: `), true, problems.join("; "));
  });
}

test("an `other:` harness id is allowed, a bare `other:` is not", () => {
  const ok = catalog();
  ok.models[0].harness = "other:aider";
  assert.deepEqual(validateCatalog(ok), []);
  const broken = catalog();
  broken.models[0].harness = "other:";
  assert.deepEqual(validateCatalog(broken), ['models[0].harness: "other:" is not allowed here']);
});

test("a score outside 0-100 and a negative price are failures", () => {
  const broken = catalog();
  broken.benchmarks[0].score = 101;
  broken.pricing[0].outputPerMillion = -0.5;
  assert.deepEqual(validateCatalog(broken), [
    "benchmarks[0].score: 101 is not allowed here",
    "pricing[0].outputPerMillion: -0.5 is not allowed here",
  ]);
});

test("an entitlement pairing a harness with the wrong vendor is a failure", () => {
  const broken = catalog();
  broken.entitlements[0].harness = "claude-code";
  assert.deepEqual(validateCatalog(broken), [
    "entitlements[0].vendor: claude-code is not billed on chatgpt",
  ]);
});

test("an entitlement naming a plan no vendor sells is a failure", () => {
  const broken = catalog();
  broken.entitlements[0].plan = "ultra";
  assert.deepEqual(validateCatalog(broken), [
    'entitlements[0].plan: no plan row "chatgpt/ultra"',
  ]);
});

test("a date that is not a day and a timestamp that is not a moment are failures", () => {
  const broken = catalog();
  broken.sources[0].fetchedAt = "2026-09-21T06:00:00.000Z";
  broken.generatedAt = "2026-09-21";
  const problems = validateCatalog(broken);
  assert.deepEqual(problems, [
    "generatedAt: expected an ISO timestamp ending in Z",
    'sources[0].fetchedAt: "2026-09-21T06:00:00.000Z" is not allowed here',
  ]);
});
