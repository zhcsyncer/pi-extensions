import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export function findConflictingUsageCommand(commands: readonly SlashCommandInfo[]): SlashCommandInfo | undefined {
	return commands.find((command) => {
		if (command.name !== "usage") return false;
		const haystack = `${command.sourceInfo.source} ${command.sourceInfo.path}`.toLowerCase();
		return haystack.includes("@pi-plugins/usage") || /(?:^|[\\/])(?:@pi-plugins[\\/])?usage(?:[\\/]|$)/.test(haystack);
	});
}
