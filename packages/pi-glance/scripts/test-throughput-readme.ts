import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const readme = await readFile("README.md", "utf8");
const readmeZh = await readFile("README.zh-CN.md", "utf8");

for (const text of [readme, readmeZh]) {
	for (const marker of ["Reply speed", "`?`", "`~42 tok/s`", "`42 tok/s`", "Precision", "Hit rate", "`42%`", "`auto`", "`rate`"]) {
		assert.ok(text.includes(marker), `both READMEs should explain ${marker}`);
	}
	assert.doesNotMatch(text, /output tokens\s*(?:per|\/)\s*wall time/i, "remove the old wall-time denominator");
}
assert.match(readme, /enabled by default/, "Reply speed remains enabled by default");
assert.match(readme, /server inference \(thinking \+ writing\)/i, "count server inference including thinking and writing");
assert.match(readme, /excludes local tool execution/i, "exclude tools rather than letting them drag down speed");
assert.match(readme, /waiting before each response starts/i, "exclude request waiting before streaming begins");
assert.match(readme, /not (a )?benchmark/i, "do not claim benchmark accuracy");
assert.match(readme, /no notifications/i, "Reply speed sends no notifications");
assert.match(readme, /does not estimate tokens/i, "no text-based token fallback");
assert.match(readme, /Narrow layouts keep the percentage first/, "cache hit rate survives narrow layouts");
assert.match(readmeZh, /服务端推理时间（thinking 思考 \+ 正文生成）/, "Chinese copy includes thinking");
assert.match(readmeZh, /排除本地工具执行/, "Chinese copy excludes tool execution");
assert.match(readmeZh, /不是性能基准/, "Chinese copy rules out benchmark accuracy");
assert.match(readmeZh, /命中率/, "Chinese copy names the hit-rate choice");

console.log("✓ throughput README copy checks passed");
