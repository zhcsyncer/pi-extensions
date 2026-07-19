import { EventEmitter } from "node:events";

export interface SpawnScript {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	error?: Error;
	neverSettles?: boolean;
}

export interface SpawnStub extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	killed: boolean;
	kill(signal?: NodeJS.Signals | number): boolean;
	settleAfterKill(code: number): void;
}

export function makeSpawnStub(script: SpawnScript = {}): SpawnStub {
	const child = new EventEmitter() as SpawnStub;
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	child.stdout = stdout;
	child.stderr = stderr;
	child.killed = false;

	child.kill = (_signal?: NodeJS.Signals | number): boolean => {
		child.killed = true;
		return true;
	};
	child.settleAfterKill = (code: number) => {
		child.emit("close", code);
	};

	if (!script.neverSettles) {
		process.nextTick(() => {
			if (script.stdout) stdout.emit("data", Buffer.from(script.stdout));
			if (script.stderr) stderr.emit("data", Buffer.from(script.stderr));
			if (script.error) {
				child.emit("error", script.error);
				return;
			}
			child.emit("close", script.exitCode ?? 0);
		});
	}
	return child;
}
