import assert from "node:assert/strict";
import test from "node:test";
import { runIsolated } from "./run-isolated.mjs";

test("offline harness allows fake loopback transports and rejects external TCP", () => {
	const result = runIsolated(process.execPath, ["--input-type=module", "-e", `
		import assert from 'node:assert/strict';
		import net from 'node:net';
		import { once } from 'node:events';
		const server = net.createServer(socket => socket.end('fixture'));
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const local = net.connect(server.address().port, '127.0.0.1');
		assert.equal(String((await once(local, 'data'))[0]), 'fixture');
		local.destroy(); server.close();
		const remote = net.connect(443, '192.0.2.1');
		remote.setTimeout(1000, () => { throw Error('expected unreachable route, not a timeout'); });
		const [error] = await once(remote, 'error');
		assert.equal(error.code, 'ENETUNREACH');
		remote.destroy();
	`], { encoding: "utf8", timeout: 5000 });
	assert.equal(result.status, 0, `${result.stderr}\n${result.error ?? ""}`);
});
