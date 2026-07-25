import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	PLAN_METADATA_VERSION,
	type PlanMetadata,
	type PlanPaths,
	type PlanRevision,
	type PlanStatus,
	type PlanStorageMode,
	type SubmitPlanResult,
} from "./types.ts";

const PLAN_ID_PATTERN = /^\d{8}T\d{6}-[a-z0-9][a-z0-9-]{0,47}-[a-f0-9]{8}$/;
const APPROVED_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PLAN_STATUSES = new Set<PlanStatus>(["draft", "changes_requested", "approved"]);
const MAX_TITLE_SLUG_LENGTH = 48;
const EXECUTION_STEP_HEADINGS = new Set(["execution steps", "执行步骤"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function normalizeSlug(title: string): string {
	const slug = title
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_TITLE_SLUG_LENGTH)
		.replace(/-+$/g, "");
	return slug || "plan";
}

function revisionRelativePath(revision: number): string {
	return `revisions/r${revision}.md`;
}

function normalizeStepSummary(value: string): string {
	return value
		.replace(/^\[[ xX]\]\s*/, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

export function extractPlanSteps(markdown: string): string[] {
	const lines = markdown.split(/\r?\n/);
	let sectionLevel: number | undefined;
	const steps: string[] = [];

	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			const title = heading[2].trim().toLowerCase();
			if (sectionLevel === undefined && EXECUTION_STEP_HEADINGS.has(title)) {
				sectionLevel = level;
				continue;
			}
			if (sectionLevel !== undefined && level <= sectionLevel) break;
		}
		if (sectionLevel === undefined) continue;

		const item = /^ {0,3}\d+[.)]\s+(.+?)\s*$/.exec(line);
		if (!item) continue;
		const summary = normalizeStepSummary(item[1]);
		if (summary) steps.push(summary);
	}

	return steps;
}

export function generatePlanId(title: string, now = new Date(), random: string = randomUUID()): string {
	const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
	const suffix = createHash("sha256").update(random).digest("hex").slice(0, 8);
	return `${timestamp}-${normalizeSlug(title)}-${suffix}`;
}

export function isValidPlanId(planId: string): boolean {
	return PLAN_ID_PATTERN.test(planId);
}

export function hashPlanContent(markdown: string): string {
	return `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
}

export function getPlanPaths(
	root: string,
	planId: string,
	revision = 1,
	previousRevision = Math.max(1, revision - 1),
): PlanPaths {
	if (!isValidPlanId(planId)) throw new Error(`Invalid plan id: ${planId}`);
	if (!Number.isInteger(revision) || revision < 1) throw new Error(`Invalid plan revision: ${revision}`);
	if (!Number.isInteger(previousRevision) || previousRevision < 1) {
		throw new Error(`Invalid previous Plan revision: ${previousRevision}`);
	}
	const planDir = path.join(root, planId);
	const revisionsDir = path.join(planDir, "revisions");
	const reviewDir = path.join(planDir, ".review");
	return {
		root,
		planDir,
		manifest: path.join(planDir, "manifest.json"),
		revisionsDir,
		plan: path.join(revisionsDir, `r${revision}.md`),
		reviewDir,
		previous: path.join(revisionsDir, `r${previousRevision}.md`),
		annotations: path.join(reviewDir, "annotations.md"),
	};
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
}

async function atomicWrite(file: string, content: string): Promise<void> {
	await ensurePrivateDirectory(path.dirname(file));
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, file);
		await chmod(file, 0o600);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function createImmutableFile(file: string, content: string): Promise<void> {
	await ensurePrivateDirectory(path.dirname(file));
	await writeFile(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	await chmod(file, 0o600);
}

async function readTextIfExists(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}

export async function pathExists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (isMissingFile(error)) return false;
		throw error;
	}
}

export async function createTemporaryPlanRoot(baseDirectory = tmpdir()): Promise<string> {
	const root = await mkdtemp(path.join(baseDirectory, "pi-plan-"));
	await chmod(root, 0o700);
	return root;
}

export async function ensurePersistentPlanRoot(root: string): Promise<string> {
	await ensurePrivateDirectory(root);
	return root;
}

export async function removeTemporaryPlanRoot(root: string | undefined): Promise<void> {
	if (!root) return;
	await rm(root, { recursive: true, force: true });
}

function parseRevision(value: unknown): PlanRevision | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1) return undefined;
	if (typeof value.status !== "string" || !PLAN_STATUSES.has(value.status as PlanStatus)) return undefined;
	if (value.path !== revisionRelativePath(value.revision)) return undefined;
	if (typeof value.hash !== "string" || !APPROVED_HASH_PATTERN.test(value.hash)) return undefined;
	if (typeof value.createdAt !== "string") return undefined;
	if (value.basedOn !== undefined && (typeof value.basedOn !== "number" || !Number.isInteger(value.basedOn) || value.basedOn < 1)) return undefined;
	if (!Array.isArray(value.steps) || !value.steps.every((step) => typeof step === "string")) return undefined;
	if (value.approvedAt !== undefined && typeof value.approvedAt !== "string") return undefined;
	return value as unknown as PlanRevision;
}

function parseMetadata(value: unknown): PlanMetadata | undefined {
	if (!isRecord(value) || value.version !== PLAN_METADATA_VERSION) return undefined;
	if (typeof value.planId !== "string" || !isValidPlanId(value.planId)) return undefined;
	if (typeof value.title !== "string" || typeof value.status !== "string" || !PLAN_STATUSES.has(value.status as PlanStatus)) return undefined;
	if (value.storage !== "persistent" && value.storage !== "temporary") return undefined;
	if (typeof value.sessionId !== "string" || typeof value.cwd !== "string") return undefined;
	if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return undefined;
	if (typeof value.currentRevision !== "number" || !Number.isInteger(value.currentRevision) || value.currentRevision < 1) return undefined;
	if (value.approvedRevision !== undefined && (typeof value.approvedRevision !== "number" || !Number.isInteger(value.approvedRevision) || value.approvedRevision < 1)) return undefined;
	if (value.approvedHash !== undefined && (typeof value.approvedHash !== "string" || !APPROVED_HASH_PATTERN.test(value.approvedHash))) return undefined;
	if (!Array.isArray(value.revisions)) return undefined;
	const revisions = value.revisions.map(parseRevision);
	if (revisions.some((revision) => revision === undefined)) return undefined;
	const parsedRevisions = revisions as PlanRevision[];
	if (parsedRevisions.length !== value.currentRevision) return undefined;
	if (!parsedRevisions.every((revision, index) => revision.revision === index + 1)) return undefined;
	const current = parsedRevisions.at(-1);
	if (!current || current.status !== value.status) return undefined;
	if ((value.approvedRevision === undefined) !== (value.approvedHash === undefined)) return undefined;
	if (value.approvedRevision !== undefined) {
		const approved = parsedRevisions[value.approvedRevision - 1];
		if (!approved || approved.status !== "approved" || approved.hash !== value.approvedHash) return undefined;
	}
	return value as unknown as PlanMetadata;
}

export async function readPlanMetadata(root: string, planId: string): Promise<PlanMetadata | undefined> {
	const raw = await readTextIfExists(getPlanPaths(root, planId).manifest);
	if (raw === undefined) return undefined;
	try {
		return parseMetadata(JSON.parse(raw) as unknown);
	} catch {
		return undefined;
	}
}

export async function readPlanContent(root: string, planId: string, revision?: number): Promise<string | undefined> {
	let targetRevision = revision;
	if (targetRevision === undefined) {
		const metadata = await readPlanMetadata(root, planId);
		if (!metadata) return undefined;
		targetRevision = metadata.currentRevision;
	}
	return readTextIfExists(getPlanPaths(root, planId, targetRevision).plan);
}

export async function writePlanMetadata(root: string, metadata: PlanMetadata): Promise<void> {
	if (!isValidPlanId(metadata.planId)) throw new Error(`Invalid plan id: ${metadata.planId}`);
	await atomicWrite(getPlanPaths(root, metadata.planId).manifest, `${JSON.stringify(metadata, null, 2)}\n`);
}

export interface SubmitPlanInput {
	root: string;
	planId: string;
	title: string;
	markdown: string;
	storage: PlanStorageMode;
	sessionId: string;
	cwd: string;
	basedOn?: number;
	now?: Date;
}

export async function saveSubmittedPlan(input: SubmitPlanInput): Promise<SubmitPlanResult> {
	await ensurePrivateDirectory(input.root);
	const existing = await readPlanMetadata(input.root, input.planId);
	if (existing && existing.sessionId !== input.sessionId) {
		throw new Error(`Plan ${input.planId} belongs to another Session`);
	}
	if (input.basedOn !== undefined && (!existing || !existing.revisions[input.basedOn - 1])) {
		throw new Error(`Base revision does not exist: r${input.basedOn}`);
	}

	const revisionNumber = (existing?.currentRevision ?? 0) + 1;
	const basedOn = existing ? (input.basedOn ?? existing.currentRevision) : undefined;
	const paths = getPlanPaths(input.root, input.planId, revisionNumber, basedOn ?? 1);
	await ensurePrivateDirectory(paths.planDir);
	await ensurePrivateDirectory(paths.revisionsDir);
	await ensurePrivateDirectory(paths.reviewDir);
	await rm(paths.annotations, { force: true });

	const timestamp = (input.now ?? new Date()).toISOString();
	const revision: PlanRevision = {
		revision: revisionNumber,
		status: "draft",
		path: revisionRelativePath(revisionNumber),
		hash: hashPlanContent(input.markdown),
		createdAt: timestamp,
		...(basedOn ? { basedOn } : {}),
		steps: extractPlanSteps(input.markdown),
	};
	const metadata: PlanMetadata = {
		version: PLAN_METADATA_VERSION,
		planId: input.planId,
		title: input.title.trim(),
		status: "draft",
		storage: input.storage,
		sessionId: input.sessionId,
		cwd: input.cwd,
		createdAt: existing?.createdAt ?? timestamp,
		updatedAt: timestamp,
		currentRevision: revisionNumber,
		...(existing?.approvedRevision ? { approvedRevision: existing.approvedRevision } : {}),
		...(existing?.approvedHash ? { approvedHash: existing.approvedHash } : {}),
		revisions: [...(existing?.revisions ?? []), revision],
	};

	await createImmutableFile(paths.plan, input.markdown);
	try {
		await writePlanMetadata(input.root, metadata);
	} catch (error) {
		await rm(paths.plan, { force: true }).catch(() => undefined);
		throw error;
	}

	return {
		metadata,
		paths,
		revision,
		submittedHash: revision.hash,
		hasPrevious: existing !== undefined,
	};
}

export async function writeReviewAnnotations(paths: PlanPaths, annotations: string): Promise<void> {
	await atomicWrite(paths.annotations, annotations.trimEnd() ? `${annotations.trimEnd()}\n` : "");
}

export async function updatePlanStatus(
	root: string,
	planId: string,
	status: Exclude<PlanStatus, "approved">,
	now = new Date(),
): Promise<PlanMetadata> {
	const current = await readPlanMetadata(root, planId);
	if (!current) throw new Error(`Plan metadata not found: ${planId}`);
	if (current.revisions[current.currentRevision - 1]?.status === "approved") {
		throw new Error(`Approved Plan revision r${current.currentRevision} is immutable`);
	}
	const revisions = current.revisions.map((revision) =>
		revision.revision === current.currentRevision ? { ...revision, status } : revision,
	);
	const metadata: PlanMetadata = {
		...current,
		status,
		updatedAt: now.toISOString(),
		revisions,
	};
	await writePlanMetadata(root, metadata);
	return metadata;
}

export async function approvePlan(
	root: string,
	planId: string,
	revision: number,
	expectedHash: string,
	now = new Date(),
): Promise<PlanMetadata> {
	const metadata = await readPlanMetadata(root, planId);
	if (!metadata) throw new Error(`Plan metadata not found: ${planId}`);
	if (metadata.currentRevision !== revision) throw new Error("Plan revision changed during review; approval was not recorded");
	const content = await readPlanContent(root, planId, revision);
	if (content === undefined) throw new Error(`Plan revision not found: ${planId} r${revision}`);
	const actualHash = hashPlanContent(content);
	if (actualHash !== expectedHash) throw new Error("Plan content changed during review; approval was not recorded");
	const approvedAt = now.toISOString();
	const revisions = metadata.revisions.map((entry) =>
		entry.revision === revision ? { ...entry, status: "approved" as const, approvedAt } : entry,
	);
	const approved: PlanMetadata = {
		...metadata,
		status: "approved",
		updatedAt: approvedAt,
		currentRevision: revision,
		approvedRevision: revision,
		approvedHash: actualHash,
		revisions,
	};
	await writePlanMetadata(root, approved);
	return approved;
}

export interface IntegrityResult {
	ok: boolean;
	expectedHash?: string;
	actualHash?: string;
	content?: string;
	metadata?: PlanMetadata;
	reason?: string;
}

export async function verifyApprovedPlan(
	root: string,
	planId: string,
	revision?: number,
	expectedHash?: string,
): Promise<IntegrityResult> {
	const metadata = await readPlanMetadata(root, planId);
	if (!metadata) return { ok: false, reason: "Plan metadata is missing" };
	const approvedRevision = revision ?? metadata.approvedRevision;
	if (!approvedRevision) return { ok: false, metadata, reason: "Plan has no approved revision" };
	const approved = metadata.revisions[approvedRevision - 1];
	if (!approved || approved.status !== "approved") {
		return { ok: false, metadata, reason: `Plan revision r${approvedRevision} is not approved` };
	}
	const content = await readPlanContent(root, planId, approvedRevision);
	if (content === undefined) return { ok: false, metadata, reason: "Approved Plan revision is missing" };
	const approvedHash = expectedHash ?? metadata.approvedHash;
	if (!approvedHash || approved.hash !== approvedHash || metadata.approvedRevision !== approvedRevision) {
		return { ok: false, metadata, content, reason: "Plan metadata does not match the approved revision" };
	}
	const actualHash = hashPlanContent(content);
	if (actualHash !== approvedHash) {
		return {
			ok: false,
			metadata,
			content,
			expectedHash: approvedHash,
			actualHash,
			reason: "Plan content no longer matches the approved hash",
		};
	}
	return { ok: true, metadata, content, expectedHash: approvedHash, actualHash };
}

export async function cleanupReviewWorkspace(root: string, planId: string): Promise<void> {
	await rm(getPlanPaths(root, planId).reviewDir, { recursive: true, force: true });
}
