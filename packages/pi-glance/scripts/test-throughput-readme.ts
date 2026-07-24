import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const readme = await readFile("README.md", "utf8");

assert.ok(readme.includes("Reply speed"), "README should document the user-facing Reply speed segment");
assert.ok(readme.includes("enabled by default"), "README should state Reply speed is enabled by default");
assert.ok(/\?/.test(readme), "README should document the Reply speed unknown ? placeholder");
assert.ok(/~/.test(readme), "README should document the Reply speed provisional ~ marker");
assert.ok(/Precision/i.test(readme), "README should document the Reply speed Precision setting");
assert.ok(/no notifications/i.test(readme), "README should state Reply speed sends no notifications");
assert.ok(/no timer/i.test(readme) || /no timers/i.test(readme), "README should state Reply speed uses no timers");
assert.ok(/no token estimation/i.test(readme) || /does not estimate tokens/i.test(readme), "README should state Reply speed does no token estimation");
assert.ok(readme.includes("output tokens per wall time") || readme.includes("output tokens / wall time"), "README should define Reply speed as output tokens per wall time");
assert.ok(readme.includes("tools") && readme.includes("waiting") && readme.includes("network") && readme.includes("thinking"), "README should clarify wall time includes tools, waiting, network, and thinking");
assert.ok(/not (a )?benchmark/i.test(readme), "README should clarify Reply speed is not a benchmark");

console.log("✓ throughput README copy checks passed");
