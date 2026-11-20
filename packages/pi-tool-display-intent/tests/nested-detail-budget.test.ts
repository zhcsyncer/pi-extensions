import assert from "node:assert/strict";
import test from "node:test";
import { buildDetailModel, type DetailRequest } from "../src/detail-viewer-model.ts";

const notice = "Nested display incomplete (partial list); visible costs only, not full spend.";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const parse = (text: string) => JSON.parse(text.replace(`${notice}\n`, ""));
function result(count: number, args: string, empty = false) {
  return Object.freeze({ content: Object.freeze(empty ? [] : [{ type: "text", text: "original output" }]),
    details: Object.freeze({ keep: "native metadata", calls: Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
      id: `root/${index + 1}`, name: "leaf", args, status: "ok", durationMs: 1, cost: 0.01,
    }))) }),
  });
}

for (const [name, count, args] of [
  ["call count", 258, "{}"],
  ["total UTF-8 bytes", 100, "界".repeat(200)],
  ["per-argument JSON bytes", 1, "a".repeat(8191)],
] as const) test(`owned Metadata and Raw enforce ${name}, including result fallback`, () => {
  for (const empty of [false, true]) {
    const original = result(count, args, empty);
    const request: DetailRequest = Object.freeze({ kind: "tool", toolName: "codemode", args: Object.freeze(empty ? {} : { code: "return 1;" }), result: original });
    const before = structuredClone(request);
    const model = buildDetailModel(request);
    const metadata = model.tabs.find(tab => tab.id === "details")!;
    for (const tab of empty ? [metadata, model.tabs[0]] : [metadata]) {
      assert.equal(tab.truncated, true);
      for (const text of [tab.text, tab.rawText]) {
        assert.match(text, /partial list.*visible costs only/);
        const data = parse(text);
        assert.ok(data.calls.length <= 256);
        const retained = data.calls.filter(call => Object.hasOwn(call, "args"));
        assert.ok(retained.every(call => bytes(call.args) <= 8192));
        assert.ok(retained.reduce((sum, call) => sum + bytes(call.args), 0) <= 32768);
        for (const call of data.calls) {
          if (Object.hasOwn(call, "args")) assert.equal(call.args, args);
          else assert.equal(call.argsOmitted, true);
        }
        assert.equal(data.keep, "native metadata");
      }
    }
    if (!empty) assert.equal(model.tabs[0].rawText, "original output");
    assert.deepEqual(request, before);
  }
});

test("structured details distinguish omitted arguments from genuine empty strings", () => {
  const source = result(100, "界".repeat(200), true);
  const original = Object.freeze({ ...source, details: Object.freeze({ ...source.details, calls: Object.freeze([
    Object.freeze({ id: "root/0", name: "leaf", args: "", status: "ok" }), ...source.details.calls,
  ]) }) });
  const before = structuredClone(original);
  const request: DetailRequest = Object.freeze({ kind: "tool", toolName: "codemode", args: Object.freeze({}), result: original });
  const model = buildDetailModel(request);
  for (const tab of model.tabs.filter(tab => tab.id !== "args")) {
    assert.equal(tab.truncated, true);
    for (const text of [tab.text, tab.rawText]) {
      const calls = parse(text).calls;
      assert.equal(calls.filter(call => call.args === "").length, 1, "only the actual empty argument may remain empty");
      assert.equal(calls[0].args, "");
      assert.equal(calls[0].argsOmitted, undefined);
      assert.ok(calls.some(call => call.argsOmitted === true));
      for (const call of calls.slice(1)) {
        if (Object.hasOwn(call, "args")) assert.equal(call.args, "界".repeat(200));
        else assert.equal(call.argsOmitted, true);
      }
    }
  }
  assert.equal(request.result, original);
  assert.deepEqual(original, before);
});

test("in-budget native values and non-native metadata remain unchanged", () => {
  const small = result(2, '{"tag":"preserved"}');
  const metadata = buildDetailModel({ kind: "tool", toolName: "codemode", args: { code: "return 1;" }, result: small }).tabs.find(tab => tab.id === "details")!;
  assert.equal(metadata.truncated, false);
  assert.deepEqual(JSON.parse(metadata.rawText), small.details);
  const foreign = result(258, "{}");
  const other = buildDetailModel({ kind: "tool", toolName: "third_party", args: { code: "return 1;" }, result: foreign }).tabs.find(tab => tab.id === "details")!;
  assert.equal(other.truncated, false);
  assert.deepEqual(JSON.parse(other.rawText), foreign.details);
  const custom = { content: [], details: { calls: Array.from({ length: 258 }, (_, id) => ({ id, custom: true })) } };
  const unknown = buildDetailModel({ kind: "tool", toolName: "codemode", args: { code: "custom protocol" }, result: custom }).tabs.find(tab => tab.id === "details")!;
  assert.equal(unknown.truncated, false);
  assert.deepEqual(JSON.parse(unknown.rawText), custom.details);
});
