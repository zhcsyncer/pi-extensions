import {
	LEGACY_SESSION_STATE_VERSION,
	SESSION_STATE_VERSION,
	type LegacyPlanSessionState,
	type PlanMetadata,
	type PlanReference,
	type PlanSessionState,
	type PlanWorkReference,
	type PlanWorkStatus,
} from "./types.ts";
import { isValidPlanId } from "./storage.ts";

const APPROVED_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WORK_STATUSES = new Set<PlanWorkStatus>(["implementing", "completed", "abandoned", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isTimestamp(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function parseReference(value: unknown): PlanReference | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.planId !== "string" || !isValidPlanId(value.planId)) return undefined;
	if (!isRevision(value.revision)) return undefined;
	return { planId: value.planId, revision: value.revision };
}

function parseWorkReference(value: unknown): PlanWorkReference | undefined {
	const reference = parseReference(value);
	if (!reference || !isRecord(value)) return undefined;
	if (typeof value.approvedHash !== "string" || !APPROVED_HASH_PATTERN.test(value.approvedHash)) return undefined;
	if (typeof value.status !== "string" || !WORK_STATUSES.has(value.status as PlanWorkStatus)) return undefined;
	if (!isTimestamp(value.startedAt) || !isTimestamp(value.completedAt) || !isTimestamp(value.abandonedAt)) return undefined;
	return {
		...reference,
		approvedHash: value.approvedHash,
		status: value.status as PlanWorkStatus,
		...(value.startedAt ? { startedAt: value.startedAt } : {}),
		...(value.completedAt ? { completedAt: value.completedAt } : {}),
		...(value.abandonedAt ? { abandonedAt: value.abandonedAt } : {}),
	};
}

function parseNormalTools(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((tool) => typeof tool === "string")) return undefined;
	return [...new Set(value)];
}

export type StoredPlanSessionState = PlanSessionState | LegacyPlanSessionState;

export function parseStoredPlanSessionState(value: unknown): StoredPlanSessionState | undefined {
	if (!isRecord(value)) return undefined;
	if (value.mode !== "normal" && value.mode !== "planning") return undefined;
	const normalTools = parseNormalTools(value.normalTools);
	if (!normalTools) return undefined;

	if (value.version === SESSION_STATE_VERSION) {
		const planning = value.planning === undefined ? undefined : parseReference(value.planning);
		const work = value.work === undefined ? undefined : parseWorkReference(value.work);
		if (value.planning !== undefined && !planning) return undefined;
		if (value.work !== undefined && !work) return undefined;
		return {
			version: SESSION_STATE_VERSION,
			mode: value.mode,
			normalTools,
			...(planning ? { planning } : {}),
			...(work ? { work } : {}),
		};
	}

	if (value.version !== LEGACY_SESSION_STATE_VERSION) return undefined;
	if (value.planId !== undefined && (typeof value.planId !== "string" || !isValidPlanId(value.planId))) return undefined;
	if (value.revision !== undefined && !isRevision(value.revision)) return undefined;
	if ((value.planId === undefined) !== (value.revision === undefined)) return undefined;
	return {
		version: LEGACY_SESSION_STATE_VERSION,
		mode: value.mode,
		normalTools,
		...(value.planId ? { planId: value.planId, revision: value.revision as number } : {}),
	};
}

export function migrateStoredPlanSessionState(
	state: StoredPlanSessionState,
	metadata?: PlanMetadata,
): PlanSessionState {
	if (state.version === SESSION_STATE_VERSION) return state;
	const migrated: PlanSessionState = {
		version: SESSION_STATE_VERSION,
		mode: state.mode,
		normalTools: [...state.normalTools],
	};
	if (!state.planId || !state.revision || !metadata || metadata.planId !== state.planId) return migrated;
	const revision = metadata.revisions[state.revision - 1];
	if (!revision) return migrated;
	if (revision.status === "approved" && APPROVED_HASH_PATTERN.test(revision.hash)) {
		migrated.work = {
			planId: state.planId,
			revision: state.revision,
			approvedHash: revision.hash,
			status: "unknown",
		};
	} else {
		migrated.planning = { planId: state.planId, revision: state.revision };
	}
	return migrated;
}

export function createImplementingWork(
	reference: PlanReference,
	approvedHash: string,
	now = new Date(),
): PlanWorkReference {
	if (!APPROVED_HASH_PATTERN.test(approvedHash)) throw new Error("Invalid approved Plan hash");
	return {
		...reference,
		approvedHash,
		status: "implementing",
		startedAt: now.toISOString(),
	};
}

export function isCompletableWork(work: PlanWorkReference | undefined): boolean {
	return work?.status === "implementing" || work?.status === "unknown";
}

export function closePlanWork(
	work: PlanWorkReference,
	status: "completed" | "abandoned",
	now = new Date(),
): PlanWorkReference {
	if (!isCompletableWork(work)) throw new Error(`Plan work is already ${work.status}`);
	const timestamp = now.toISOString();
	return {
		...work,
		status,
		...(status === "completed" ? { completedAt: timestamp } : { abandonedAt: timestamp }),
	};
}
