// Offline CLI boundary only: no Herdr socket, pane, PTY, or agent is contacted.
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.env.H1_CLI_ROOT;
const args = process.argv.slice(2);
appendFileSync(join(root, "calls.jsonl"), `${JSON.stringify(args)}\n`);
const statePath = join(root, "panes.json");
const panes = JSON.parse(readFileSync(statePath, "utf8"));
const json = result => console.log(JSON.stringify({ result }));
const save = () => writeFileSync(statePath, JSON.stringify(panes));
if (args[0] !== "pane") throw new Error(`Unexpected fixture command: ${args}`);
switch (args[1]) {
	case "list": json({ panes }); break;
	case "split": {
		const pane = { pane_id: "h1:p2", terminal_id: "h1-terminal-2", tab_id: "h1:t1", workspace_id: "h1", cwd: root };
		panes.push(pane);
		save();
		json({ pane });
		break;
	}
	case "rename": json({}); break;
	case "run": {
		// Execute only the test's short command in its temporary cwd, not a live pane.
		const result = spawnSync("/bin/bash", ["-c", args[3]], { cwd: root, encoding: "utf8", timeout: 2_000 });
		if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
		writeFileSync(join(root, "output.txt"), result.stdout);
		break;
	}
	case "process-info": json({ process_info: {
		pane_id: args[3], shell_pid: 42, foreground_process_group_id: 42,
		foreground_processes: [{ pid: 42, name: "bash" }],
	} }); break;
	case "read": process.stdout.write(readFileSync(join(root, "output.txt"), "utf8")); break;
	case "close": {
		if (args[2] !== "h1:p2") throw new Error(`Refusing non-owned fixture pane: ${args[2]}`);
		panes.splice(panes.findIndex(pane => pane.pane_id === args[2]), 1);
		save();
		json({});
		break;
	}
	default: throw new Error(`Unexpected fixture command: ${args}`);
}
