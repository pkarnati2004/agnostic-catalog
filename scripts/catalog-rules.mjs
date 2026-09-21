// The rules agn applies to a downloaded catalog, written again in plain JS so the Action can
// reject a bad file before publishing it. The source of truth is packages/catalog/src/
// catalog-schema.ts in the agnostic repo: when a row shape, an enum value or a cross-reference
// changes there, change it here in the same week, or the Action will publish a file agn refuses.

export const SCHEMA_VERSION = 1;

const TABLES = ["sources", "benchmarks", "models", "plans", "entitlements", "pricing"];
const ROUTES = ["native", "anthropic-gateway", "openai-compatible", "openrouter", "local"];
const INTENTS = ["implement", "debug", "refactor", "review", "research", "ui", "general"];
const PLAN_VENDORS = ["claude", "chatgpt"];
const ACCESS = ["included", "credits", "unavailable"];
const PRICE_SOURCES = ["openrouter", "curated"];

// Only these two harnesses bill by plan, so an entitlement row pairing any other is bad data.
const ENTITLEMENT_VENDORS = { "claude-code": "claude", codex: "chatgpt" };

const text = (value) => typeof value === "string" && value.length > 0;
const anyText = (value) => typeof value === "string";
const bool = (value) => typeof value === "boolean";
const url = (value) => text(value) && /^https?:\/\/\S+$/.test(value);
const day = (value) => text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
const moment = (value) => text(value) && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value);
const number = (value) => typeof value === "number" && Number.isFinite(value);
const nonNegative = (value) => number(value) && value >= 0;
const wholePositive = (value) => number(value) && Number.isInteger(value) && value > 0;
const wholeNonNegative = (value) => number(value) && Number.isInteger(value) && value >= 0;
const score = (value) => number(value) && value >= 0 && value <= 100;
const orNull = (check) => (value) => value === null || check(value);
const oneOf = (values) => (value) => values.includes(value);
// `other:<binary>` is the escape hatch for a harness with no registry entry.
const harness = (value) =>
  ["claude-code", "codex", "pi", "opencode"].includes(value) ||
  (text(value) && value.startsWith("other:") && value.length > "other:".length);

// Every field is required here, including `models[].legacy`, which agn's schema defaults to false:
// the Action writes every field, so a row missing one was hand-edited and deserves a human.
const ROW_RULES = {
  sources: { id: text, name: text, url, terms: text, fetchedAt: day },
  benchmarks: {
    source: text,
    date: day,
    benchmark: text,
    model: text,
    modelVersion: orNull(text),
    harness: orNull(harness),
    harnessVersion: orNull(text),
    taskClass: oneOf(INTENTS),
    metric: text,
    score,
    n: orNull(wholePositive),
    costUsd: orNull(nonNegative),
    tokens: orNull(wholeNonNegative),
    notes: anyText,
  },
  models: { harness, model: text, route: oneOf(ROUTES), canonical: orNull(text), legacy: bool },
  plans: { vendor: oneOf(PLAN_VENDORS), id: text, displayName: text, confirmedAt: day },
  entitlements: {
    harness,
    model: text,
    vendor: oneOf(PLAN_VENDORS),
    plan: text,
    access: oneOf(ACCESS),
  },
  pricing: {
    model: text,
    inputPerMillion: nonNegative,
    outputPerMillion: nonNegative,
    cacheReadPerMillion: orNull(nonNegative),
    cacheWritePerMillion: orNull(nonNegative),
    source: oneOf(PRICE_SOURCES),
    asOf: day,
  },
};

/** Every problem with `catalog`, each naming the row the way agn names it: `pricing[3].model`. */
export function validateCatalog(catalog) {
  if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
    return ["catalog is not an object"];
  }
  const problems = checkHeader(catalog);
  for (const table of TABLES) {
    if (!Array.isArray(catalog[table])) {
      problems.push(`${table}: expected an array`);
      continue;
    }
    problems.push(...checkTable(table, catalog[table]));
  }
  const extra = Object.keys(catalog).filter(
    (key) => !TABLES.includes(key) && !["schemaVersion", "version", "generatedAt"].includes(key),
  );
  problems.push(...extra.map((key) => `${key}: agn's schema has no such key`));
  return problems.length > 0 ? problems : checkReferences(catalog);
}

function checkHeader(catalog) {
  const problems = [];
  if (catalog.schemaVersion !== SCHEMA_VERSION) {
    problems.push(`schemaVersion: expected ${SCHEMA_VERSION}, found ${catalog.schemaVersion}`);
  }
  if (!wholePositive(catalog.version)) {
    problems.push("version: expected a positive whole number");
  }
  if (!moment(catalog.generatedAt)) {
    problems.push("generatedAt: expected an ISO timestamp ending in Z");
  }
  return problems;
}

function checkTable(table, rows) {
  const rules = ROW_RULES[table];
  const problems = [];
  for (const [index, row] of rows.entries()) {
    const at = `${table}[${index}]`;
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      problems.push(`${at}: expected an object`);
      continue;
    }
    for (const [field, check] of Object.entries(rules)) {
      if (!check(row[field])) {
        problems.push(`${at}.${field}: ${JSON.stringify(row[field] ?? null)} is not allowed here`);
      }
    }
    for (const field of Object.keys(row)) {
      if (!(field in rules)) {
        problems.push(`${at}.${field}: agn's schema has no such field`);
      }
    }
  }
  return problems;
}

/** Rows point at each other by id, so a catalog with valid rows can still be inconsistent. */
function checkReferences(catalog) {
  const problems = [];
  const sources = new Set(catalog.sources.map((row) => row.id));
  const plans = new Set(catalog.plans.map((row) => `${row.vendor}:${row.id}`));
  for (const [index, row] of catalog.benchmarks.entries()) {
    if (!sources.has(row.source)) {
      problems.push(`benchmarks[${index}].source: no source row "${row.source}"`);
    }
  }
  for (const [index, row] of catalog.entitlements.entries()) {
    if (!plans.has(`${row.vendor}:${row.plan}`)) {
      problems.push(`entitlements[${index}].plan: no plan row "${row.vendor}/${row.plan}"`);
    }
    if (ENTITLEMENT_VENDORS[row.harness] !== row.vendor) {
      problems.push(`entitlements[${index}].vendor: ${row.harness} is not billed on ${row.vendor}`);
    }
  }
  return problems;
}
