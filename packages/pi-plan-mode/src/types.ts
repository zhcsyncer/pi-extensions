export const PLAN_METADATA_VERSION = 2 as const;
export const SESSION_STATE_VERSION = 2 as const;

export type PlanMode = "normal" | "planning";
export type PlanStatus = "draft" | "changes_requested" | "approved";
export type PlanStorageMode = "persistent" | "temporary";

export interface PlanRevision {
	revision: number;
	status: PlanStatus;
	path: string;
	hash: string;
	createdAt: string;
	basedOn?: number;
	steps: string[];
	approvedAt?: string;
}

export interface PlanMetadata {
	version: typeof PLAN_METADATA_VERSION;
	planId: string;
	title: string;
	status: PlanStatus;
	storage: PlanStorageMode;
	sessionId: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	currentRevision: number;
	approvedRevision?: number;
	approvedHash?: string;
	revisions: PlanRevision[];
}

export interface PlanPaths {
	root: string;
	planDir: string;
	manifest: string;
	revisionsDir: string;
	plan: string;
	reviewDir: string;
	previous: string;
	annotations: string;
}

export interface PlanSessionState {
	version: typeof SESSION_STATE_VERSION;
	mode: PlanMode;
	planId?: string;
	revision?: number;
	normalTools: string[];
}

export type RevdiffReviewResult =
	| { kind: "clean" }
	| { kind: "changes_requested"; annotations: string }
	| { kind: "cancelled"; message: string }
	| { kind: "error"; message: string };

export interface SubmitPlanResult {
	metadata: PlanMetadata;
	paths: PlanPaths;
	revision: PlanRevision;
	submittedHash: string;
	hasPrevious: boolean;
}
