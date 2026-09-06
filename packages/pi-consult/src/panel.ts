import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConsultTrigger, GradedEffort, PanelMember } from "./types.ts";
import { parseModelKey } from "./types.ts";

export interface ResolvedPanelMember {
	model: Model<Api>;
	label: string;
	effort?: GradedEffort;
}

export function selectPanel(panel: PanelMember[], opts: { fanout: boolean; trigger: ConsultTrigger }): PanelMember[] {
	if (panel.length === 0) return [];
	if (opts.trigger !== "onDemand" || !opts.fanout) return [panel[0]];
	return panel;
}

export function resolvePanelMembers(
	panel: PanelMember[],
	find: (provider: string, modelId: string) => Model<Api> | undefined,
): ResolvedPanelMember[] {
	const resolved: ResolvedPanelMember[] = [];
	for (const member of panel) {
		const parsed = parseModelKey(member.model);
		if (!parsed) continue;
		const model = find(parsed.provider, parsed.modelId);
		if (!model) continue;
		resolved.push({
			model,
			label: `${parsed.provider}/${parsed.modelId}`,
			...(member.effort ? { effort: member.effort } : {}),
		});
	}
	return resolved;
}

export function panelLabels(panel: PanelMember[]): string[] {
	return panel.map((member) => member.model);
}
