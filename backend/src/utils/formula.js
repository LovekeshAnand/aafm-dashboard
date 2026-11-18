import { METRICS } from "../constants.js";

// Tier 3 D: custom metric formulas. Grammar (precedence climbing, no eval, no dependency):
//   expr   = term (("+" | "-") term)*
//   term   = factor (("*" | "/") factor)*
//   factor = number | metric | "-" factor | "(" expr ")"
// Metric names must be base metrics. SQL is generated only from the parsed tree, with every
// metric name and number bound as a parameter, so user text never reaches the query.
const MAX_LENGTH = 200;
const MAX_TOKENS = 30;

class FormulaError extends Error {
  constructor(message, position) {
    super(message);
    this.position = position;
  }
}

const tokenize = (src) => {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    let j = i + 1;
    if (/[0-9.]/.test(c)) {
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(text))
        throw new FormulaError(`Invalid number "${text}"`, i);
      tokens.push({ type: "num", value: Number(text), pos: i });
    } else if (/[a-z_]/i.test(c)) {
      while (j < src.length && /[a-z_]/i.test(src[j])) j++;
      const name = src.slice(i, j);
      if (!METRICS.includes(name))
        throw new FormulaError(
          `Unknown metric "${name}". Use: ${METRICS.join(", ")}`,
          i
        );
      tokens.push({ type: "metric", name, pos: i });
    } else if ("+-*/()".includes(c)) {
      tokens.push({ type: c, pos: i });
    } else {
      throw new FormulaError(`Unexpected character "${c}"`, i);
    }
    i = j;
  }
  return tokens;
};

/** Parses a formula into a tree, or throws FormulaError with the position of the problem. */
const parseFormula = (src) => {
  if (typeof src !== "string" || !src.trim())
    throw new FormulaError("Formula is empty", 0);
  if (src.length > MAX_LENGTH)
    throw new FormulaError(`At most ${MAX_LENGTH} characters`, MAX_LENGTH);
  const tokens = tokenize(src);
  if (tokens.length > MAX_TOKENS)
    throw new FormulaError(
      `At most ${MAX_TOKENS} terms and operators`,
      tokens[MAX_TOKENS].pos
    );

  let k = 0;
  const unexpected = (t) =>
    t
      ? new FormulaError(`Unexpected "${t.name ?? t.value ?? t.type}"`, t.pos)
      : new FormulaError("Formula ends too early", src.length);
  const binary = (next, ops) => () => {
    let node = next();
    while (ops.includes(tokens[k]?.type)) {
      const op = tokens[k++].type;
      node = { op, left: node, right: next() };
    }
    return node;
  };
  const factor = () => {
    const t = tokens[k++];
    if (t?.type === "num") return { num: t.value };
    if (t?.type === "metric") return { metric: t.name };
    if (t?.type === "-") return { op: "neg", arg: factor() };
    if (t?.type === "(") {
      const node = expr();
      if (tokens[k]?.type !== ")")
        throw new FormulaError('Missing ")"', tokens[k]?.pos ?? src.length);
      k++;
      return node;
    }
    throw unexpected(t);
  };
  const term = binary(factor, ["*", "/"]);
  const expr = binary(term, ["+", "-"]);

  const tree = expr();
  if (k < tokens.length) throw unexpected(tokens[k]);
  if (!metricsOf(tree).length)
    throw new FormulaError("Use at least one metric", 0);
  return tree;
};

/** The base metrics a formula reads. */
const metricsOf = (node) =>
  node.metric
    ? [node.metric]
    : node.num !== undefined
      ? []
      : [
          ...new Set([
            ...metricsOf(node.arg ?? node.left),
            ...(node.right ? metricsOf(node.right) : []),
          ]),
        ];

/**
 * SQL for one bucket: each metric becomes its sum in the bucket, division by zero becomes NULL
 * (a gap). Values are appended to `params`; the returned text only contains placeholders.
 */
const formulaSql = (node, params) => {
  if (node.metric) {
    params.push(node.metric);
    return `sum(value) FILTER (WHERE metric = $${params.length}::metric_name)`;
  }
  if (node.num !== undefined) {
    params.push(node.num);
    return `$${params.length}::double precision`;
  }
  if (node.op === "neg") return `(-${formulaSql(node.arg, params)})`;
  const left = formulaSql(node.left, params);
  const right = formulaSql(node.right, params);
  return node.op === "/"
    ? `(${left} / NULLIF(${right}, 0))`
    : `(${left} ${node.op} ${right})`;
};

/** Evaluates a formula on metric totals ({ revenue: 123, ... }); null when undefined. */
const evaluateFormula = (node, totals) => {
  if (node.metric) return totals[node.metric] ?? null;
  if (node.num !== undefined) return node.num;
  if (node.op === "neg") {
    const v = evaluateFormula(node.arg, totals);
    return v === null ? null : -v;
  }
  const a = evaluateFormula(node.left, totals);
  const b = evaluateFormula(node.right, totals);
  if (a === null || b === null) return null;
  if (node.op === "/") return b === 0 ? null : a / b;
  return node.op === "+" ? a + b : node.op === "-" ? a - b : a * b;
};

export { evaluateFormula, FormulaError, formulaSql, metricsOf, parseFormula };
