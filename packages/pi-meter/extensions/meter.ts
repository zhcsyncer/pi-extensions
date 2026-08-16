import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderStatusText, STATUS_KEY } from "../src/chrome/widget.ts";
import { renderUsagePanel, usageSeverity } from "../src/chrome/usage-panel.ts";
import { loadMeterConfig, parseTokenDetailsArg, saveMeterConfig, type MeterConfig } from "../src/config.ts";
import { findConflictingUsageCommand } from "../src/conflict.ts";
import { addBudgetFlow, pickSelect, type BudgetUi } from "../src/ledger/budget-add.ts";
import { computeFooterStats, FOOTER_PRESETS, parseFooterPreset, renderLocalFooter, type FooterPreset } from "../src/ledger/footer.ts";
import { budgetKey, statusForLimit } from "../src/ledger/budget.ts";
import { Dashboard } from "../src/ledger/dashboard.ts";
import { DIMENSIONS } from "../src/ledger/enums.ts";
import { fmtCost, fmtNum } from "../src/ledger/format.ts";
import { aggregate, sumRows } from "../src/ledger/aggregate.ts";
import { parseSession, diffRecords, usageFromAssistantMessage } from "../src/ledger/session-parser.ts";
import { createLedgerStore, type FileLedgerStore } from "../src/ledger/store.ts";
import { parseWindowArg, sessionIdFrom } from "../src/ledger/time.ts";
import type { BudgetLimit, UsageRecord, WindowKey } from "../src/ledger/types.ts";
import { chromeWindow } from "../src/quota/policy.ts";
import { preferredProvider, refreshQuotaSnapshots } from "../src/quota/refresh.ts";
import { loadQuotaStore } from "../src/quota/store.ts";
import type { QuotaStoreFile } from "../src/quota/types.ts";
import { QUOTA_PROVIDERS } from "../src/quota/types.ts";

const WIDGET_KEY = "zhcsyncer-pi-meter";
const VALID_SCOPES: BudgetLimit["scope"][] = ["global", "session", "project"];
const VALID_PERIODS: BudgetLimit["period"][] = ["day", "week", "month", "year"];
const VALID_METRICS: BudgetLimit["metric"][] = ["cost", "tot", "in", "out"];

type Notify = (message: string, level?: "info" | "warning" | "error") => void;

interface SessionBits {
	sessionId: string;
	cwd: string;
}

export default function piMeter(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	let store: FileLedgerStore | undefined;
	let config: MeterConfig | undefined;
	let warned: Record<string, boolean> = {};
	let quota: QuotaStoreFile | undefined;
	let session: SessionBits = { sessionId: "ephemeral", cwd: "" };
	let conflictWarned = false;
	let footerPreset: FooterPreset = "full";

	async function ensureReady(ctx: ExtensionContext): Promise<void> {
		session = {
			sessionId: sessionIdFrom(ctx.sessionManager.getSessionFile()),
			cwd: ctx.cwd,
		};
		if (!store) {
			const created = await createLedgerStore(agentDir);
			store = created.store;
			if (created.migration) notify(ctx, created.migration, "info");
			warned = await store.loadWarned();
			footerPreset = parseFooterPreset(await store.loadFooterPreset()) ?? "full";
		}
		if (!config) {
			const loaded = await loadMeterConfig(agentDir);
			config = loaded.config;
			if (loaded.warning) notify(ctx, loaded.warning, "warning");
		}
		if (!quota) quota = await loadQuotaStore(agentDir, {
			ttlMs: config.snapshotTtlMs,
			minIntervalMs: config.minRefreshIntervalMs,
		});
	}

	function notify(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else if (level !== "info") console.warn(message);
	}

	function warnUsageConflict(ctx: ExtensionContext): void {
		if (conflictWarned) return;
		try {
			const conflict = findConflictingUsageCommand(pi.getCommands());
			if (!conflict) return;
			conflictWarned = true;
			notify(
				ctx,
				"@zhcsyncer/pi-meter and @pi-plugins/usage both register /usage. Disable @pi-plugins/usage.",
				"warning",
			);
		} catch {
			// getCommands may be unavailable during early load
		}
	}

	async function captureMessage(ctx: ExtensionContext, message: unknown): Promise<void> {
		await ensureReady(ctx);
		const record = usageFromAssistantMessage(message, {
			ts: Date.now(),
			sid: session.sessionId,
			cwd: session.cwd,
		});
		if (!record || !store) return;
		if (typeof (message as { timestamp?: unknown }).timestamp === "number") {
			record.ts = (message as { timestamp: number }).timestamp;
		}
		await store.append(record);
		await checkBudgets(ctx, record);
		await renderChrome(ctx);
	}

	async function checkBudgets(ctx: ExtensionContext, _record: UsageRecord): Promise<void> {
		if (!store) return;
		const budgets = await store.loadBudgets();
		if (budgets.limits.length === 0) return;
		const records = await store.readAll();
		const fired: string[] = [];
		for (const limit of budgets.limits) {
			const status = statusForLimit(records, limit, new Date(), session.sessionId);
			const key = budgetKey(limit);
			if ((status.warning || status.exceeded) && !warned[key]) {
				warned[key] = true;
				fired.push(key);
				const metricTxt = limit.metric === "cost"
					? `$${status.current.toFixed(2)} of $${limit.max.toFixed(2)}`
					: `${fmtNum(status.current)} of ${fmtNum(limit.max)} tokens`;
				notify(ctx, `Budget ${status.exceeded ? "EXCEEDED" : "approaching"}: ${limit.scope}/${limit.period}/${limit.metric} — ${metricTxt}`, "warning");
			}
		}
		if (fired.length > 0) await store.markWarned(fired);
	}

	async function renderChrome(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui" || !ctx.hasUI || !store || !config) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		const records = await store.readAll();
		const limits = (await store.loadBudgets()).limits;
		const local = renderLocalFooter(footerPreset, computeFooterStats(records, limits), config.tokenDetails);
		const preferred = preferredProvider(ctx.model);
		const view = quota ? chromeWindow(quota, preferred) : undefined;
		ctx.ui.setStatus(STATUS_KEY, renderStatusText({
			local,
			quota: view,
			polarity: config.quotaPolarity,
		}, ctx.ui.theme));
	}

	async function maybeRefreshQuota(ctx: ExtensionContext, force = false): Promise<void> {
		await ensureReady(ctx);
		if (!config) return;
		const result = await refreshQuotaSnapshots(ctx, agentDir, {
			force,
			ttlMs: config.snapshotTtlMs,
			minIntervalMs: config.minRefreshIntervalMs,
		});
		quota = result.store;
		await renderChrome(ctx);
	}

	async function persistConfig(next: MeterConfig, ctx: ExtensionContext): Promise<void> {
		config = next;
		await saveMeterConfig(next, agentDir);
		await renderChrome(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureReady(ctx);
		warnUsageConflict(ctx);
		await renderChrome(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		await captureMessage(ctx, event.message);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await maybeRefreshQuota(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		await maybeRefreshQuota(ctx);
	});

	pi.registerCommand("usage", {
		description: "Show subscription remaining for Claude, Codex, and SuperGrok",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "refresh", label: "refresh", description: "Force-refresh shared snapshots" },
				{ value: "used", label: "used", description: "Show used percent on the chrome bar" },
				{ value: "remaining", label: "remaining", description: "Show remaining percent on the chrome bar" },
			];
			return options.filter((option) => option.value.startsWith(prefix.trim().toLowerCase()));
		},
		handler: async (args, ctx) => {
			await ensureReady(ctx);
			warnUsageConflict(ctx);
			const arg = args.trim().toLowerCase();
			if (arg === "used" || arg === "remaining") {
				await persistConfig({ ...config!, quotaPolarity: arg }, ctx);
				notify(ctx, `Quota bar polarity: ${arg}`, "info");
				return;
			}
			const force = arg === "refresh";
			await maybeRefreshQuota(ctx, force);
			const snapshots = QUOTA_PROVIDERS.map((id) => quota?.providers[id]).filter((item): item is NonNullable<typeof item> => item !== undefined);
			const missing = QUOTA_PROVIDERS.filter((id) => !quota?.providers[id]).map((id) => ({
				provider: id,
				title: id === "claude" ? "Claude" : id === "codex" ? "OpenAI Codex" : "SuperGrok",
				windows: [],
				fetchedAt: 0,
				ok: false,
				error: "no snapshot yet",
			}));
			const report = renderUsagePanel([...snapshots, ...missing], config!.quotaPolarity);
			notify(ctx, report, usageSeverity([...snapshots, ...missing], config!.quotaPolarity));
		},
	});

	pi.registerCommand("analytics", {
		description: "Local usage ledger — dashboard, footer, import, token details",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "today", label: "today" },
				{ value: "week", label: "week" },
				{ value: "month", label: "month" },
				{ value: "6months", label: "6months" },
				{ value: "year", label: "year" },
				{ value: "all", label: "all" },
				{ value: "import", label: "import", description: "Back-fill from session files" },
				{ value: "footer", label: "footer", description: "Choose the local footer status" },
				...FOOTER_PRESETS.map((preset) => ({ value: `footer ${preset.key}`, label: `footer ${preset.key}`, description: preset.description })),
				{ value: "details", label: "details", description: "Show or hide token details in the footer status" },
				{ value: "details on", label: "details on", description: "Show input / output / cache hit" },
				{ value: "details off", label: "details off", description: "Hide token details" },
				{ value: "compact", label: "compact", description: "Same as details off" },
			];
			return options.filter((option) => option.value.startsWith(prefix.trim().toLowerCase()));
		},
		handler: async (args, ctx) => {
			await ensureReady(ctx);
			const arg = args.trim().toLowerCase();
			if (arg === "import") {
				await importHistory(store!, ctx.ui.notify);
				return;
			}
			if (arg === "footer" || arg.startsWith("footer ")) {
				await handleFooter(arg.slice("footer".length).trim(), store!, (preset) => {
					footerPreset = preset;
				}, ctx);
				await renderChrome(ctx);
				return;
			}
			const details = parseTokenDetailsArg(arg, config!.tokenDetails);
			if (details !== undefined) {
				await persistConfig({ ...config!, tokenDetails: details }, ctx);
				notify(ctx, details ? "Token details on. /analytics details again to hide." : "Token details off.", "info");
				return;
			}
			if (arg === "help" || arg === "?") {
				printHelp(ctx.ui.notify);
				return;
			}
			const window = parseWindowArg(arg);
			if (window) {
				if (ctx.mode !== "tui") {
					printReport(await store!.readAll(), window, ctx.ui.notify);
					return;
				}
				await openDashboard(window, store!, session, ctx);
				return;
			}
			if (arg.length > 0) {
				notify(ctx, "Unknown /analytics argument. Try footer, details, import, or a time window.", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				printReport(await store!.readAll(), "today", ctx.ui.notify);
				return;
			}
			const choice = await pickAnalyticsMenu(ctx);
			if (!choice) return;
			switch (choice) {
				case "dashboard":
					await openDashboard("today", store!, session, ctx);
					break;
				case "footer":
					await handleFooter("", store!, (preset) => {
						footerPreset = preset;
					}, ctx);
					await renderChrome(ctx);
					break;
				case "import":
					await importHistory(store!, ctx.ui.notify);
					break;
				case "budget":
					viewBudgets((await store!.loadBudgets()).limits, ctx.ui.notify);
					break;
				case "help":
					printHelp(ctx.ui.notify);
					break;
			}
		},
	});

	pi.registerCommand("budget", {
		description: "View and add local token/cost budgets",
		handler: async (args, ctx) => {
			await ensureReady(ctx);
			const arg = args.trim();
			if (arg.startsWith("add")) {
				await addBudget(arg.slice(3).trim(), store!, session, ctx);
				return;
			}
			const budgets = await store!.loadBudgets();
			viewBudgets(budgets.limits, ctx.ui.notify);
		},
	});
}

type AnalyticsMenuChoice = "dashboard" | "footer" | "import" | "budget" | "help";

async function pickAnalyticsMenu(ctx: ExtensionContext): Promise<AnalyticsMenuChoice | null> {
	return pickSelect<AnalyticsMenuChoice>(
		{ custom: ctx.ui.custom.bind(ctx.ui) as BudgetUi["custom"] },
		"Analytics",
		[
			{ value: "dashboard", label: "Dashboard", description: "Local ledger by model / project / session" },
			{ value: "footer", label: "Footer preset", description: "What the footer status shows for local spend" },
			{ value: "budget", label: "Budgets", description: "View local token/cost reminders" },
			{ value: "import", label: "Import history", description: "Back-fill from session JSONL" },
			{ value: "help", label: "Help", description: "Command reference" },
		],
	);
}

async function handleFooter(
	arg: string,
	store: FileLedgerStore,
	onChange: (preset: FooterPreset) => void,
	ctx: ExtensionContext,
): Promise<void> {
	if (arg.length > 0) {
		const preset = parseFooterPreset(arg);
		if (!preset) {
			ctx.ui.notify(`Unknown footer. Options: ${FOOTER_PRESETS.map((item) => item.key).join(", ")}`, "warning");
			return;
		}
		await store.saveFooterPreset(preset);
		onChange(preset);
		ctx.ui.notify(`Footer: ${FOOTER_PRESETS.find((item) => item.key === preset)?.label ?? preset}`, "info");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Usage: /analytics footer <${FOOTER_PRESETS.map((item) => item.key).join("|")}>`, "info");
		return;
	}
	const choice = await pickSelect<FooterPreset>(
		{ custom: ctx.ui.custom.bind(ctx.ui) as BudgetUi["custom"] },
		"Footer preset",
		FOOTER_PRESETS.map((preset) => ({ value: preset.key, label: preset.label, description: preset.description })),
	);
	if (!choice) {
		ctx.ui.notify("Footer unchanged", "info");
		return;
	}
	await store.saveFooterPreset(choice);
	onChange(choice);
	ctx.ui.notify(`Footer: ${FOOTER_PRESETS.find((item) => item.key === choice)?.label ?? choice}`, "info");
}

async function openDashboard(
	initial: WindowKey,
	store: FileLedgerStore,
	session: SessionBits,
	ctx: ExtensionContext,
): Promise<void> {
	const records = await store.readAll();
	const budgets = (await store.loadBudgets()).limits.map((limit) => statusForLimit(records, limit, new Date(), session.sessionId));
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const dash = new Dashboard({ records, budgets }, {
			fg: (color, text) => theme.fg(color as never, text),
			bold: (text) => theme.bold(text),
		}, initial);
		dash.onDone = () => done();
		return {
			render: (width: number) => dash.render(width),
			invalidate: () => dash.invalidate(),
			handleInput: (data: string) => {
				dash.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function viewBudgets(limits: BudgetLimit[], notify: Notify): void {
	if (limits.length === 0) {
		notify("No local budgets. Use /budget add.", "info");
		return;
	}
	const lines = limits.map((limit, index) => {
		const metricTxt = limit.metric === "cost" ? `$${limit.max}` : `${fmtNum(limit.max)} tok`;
		return `${index + 1}. ${limit.scope}/${limit.period}/${limit.metric} = ${metricTxt} (warn ${limit.warn ?? 0.8})`;
	});
	notify(`Local budgets:\n${lines.join("\n")}`, "info");
}

function printHelp(notify: Notify): void {
	notify(
		[
			"pi-meter commands:",
			"",
			"  /usage [refresh|used|remaining]",
			"      Subscription windows for Claude, Codex, and SuperGrok.",
			"  /analytics                    Open the interactive menu (TUI).",
			"  /analytics [today|week|month|6months|year|all]",
			"      Local ledger dashboard with input / output / cache columns.",
			"  /analytics footer [full|today-tokens|today-cost|budget|model|off]",
			"      Choose the local footer status. Quota stays beside it.",
			"  /analytics import     Back-fill from session JSONL (idempotent).",
			"  /analytics details    Toggle token details in the footer status.",
			"  /budget               View local budgets (does not block requests).",
			"  /budget add           Add a local budget.",
			"",
			"Data: $PI_CODING_AGENT_DIR/extension-data/pi-meter/",
			"Disable @pi-plugins/usage — the two /usage commands conflict.",
		].join("\n"),
		"info",
	);
}

function printReport(records: UsageRecord[], window: WindowKey, notify: Notify): void {
	const out = [`pi-meter — ${window}`];
	for (const dim of DIMENSIONS) {
		const rows = aggregate(records, window, dim.key);
		const total = sumRows(rows);
		out.push(`\nBy ${dim.label}:`);
		for (const row of rows.slice(0, 10)) {
			out.push(
				`  ${row.label.padEnd(28)} in ${fmtNum(row.input).padStart(10)}  out ${fmtNum(row.output).padStart(10)}  cr ${fmtNum(row.cacheRead).padStart(10)}  cw ${fmtNum(row.cacheWrite).padStart(10)}  ${fmtCost(row.cost).padStart(10)}`,
			);
		}
		out.push(`  ${"TOTAL".padEnd(28)} in ${fmtNum(total.input).padStart(10)}  out ${fmtNum(total.output).padStart(10)}  cr ${fmtNum(total.cacheRead).padStart(10)}  cw ${fmtNum(total.cacheWrite).padStart(10)}  ${fmtCost(total.cost).padStart(10)}`);
	}
	notify(out.join("\n"), "info");
}

async function collectSessionFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let info;
		try {
			info = await stat(full);
		} catch {
			continue;
		}
		if (info.isDirectory()) out.push(...await collectSessionFiles(full));
		else if (entry.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

async function importHistory(store: FileLedgerStore, notify: Notify): Promise<void> {
	const sessionsDir = join(getAgentDir(), "sessions");
	notify("Importing session history…", "info");
	const files = await collectSessionFiles(sessionsDir);
	if (files.length === 0) {
		notify("No session files found.", "warning");
		return;
	}
	const existing = await store.readAll();
	const incoming: UsageRecord[] = [];
	for (const file of files) {
		let content: string;
		try {
			content = await readFile(file, "utf8");
		} catch {
			continue;
		}
		const sid = (file.split(/[/\\]/).pop() ?? file).replace(/\.jsonl$/, "");
		incoming.push(...parseSession(content, sid).records);
	}
	const fresh = diffRecords(existing, incoming);
	if (fresh.length === 0) {
		notify(`Nothing new to import. (${existing.length} records already tracked.)`, "info");
		return;
	}
	for (const record of fresh) await store.append(record);
	notify(`Imported ${fmtNum(fresh.length)} records from ${files.length} session files.`, "info");
}

async function addBudget(arg: string, store: FileLedgerStore, session: SessionBits, ctx: ExtensionContext): Promise<void> {
	if (arg.length > 0) {
		const parts = arg.split(/\s+/);
		const scope = parts[0] as BudgetLimit["scope"];
		const period = parts[1] as BudgetLimit["period"];
		const metric = parts[2] as BudgetLimit["metric"];
		const max = Number(parts[3]);
		const warn = parts[4] !== undefined ? Number(parts[4]) : 0.8;
		if (!VALID_SCOPES.includes(scope) || !VALID_PERIODS.includes(period) || !VALID_METRICS.includes(metric) || !(max > 0)) {
			ctx.ui.notify(
				`Invalid. Usage: /budget add <scope:${VALID_SCOPES.join("|")}> <period:${VALID_PERIODS.join("|")}> <metric:${VALID_METRICS.join("|")}> <max> [warn]`,
				"warning",
			);
			return;
		}
		const limit: BudgetLimit = { scope, period, metric, max, warn };
		if (scope === "project") limit.cwd = session.cwd;
		await saveLimit(store, limit, ctx.ui.notify);
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Interactive /budget add needs TUI. Use: /budget add <scope> <period> <metric> <max>", "warning");
		return;
	}
	const limit = await addBudgetFlow({ custom: ctx.ui.custom.bind(ctx.ui) as BudgetUi["custom"] });
	if (!limit) {
		ctx.ui.notify("Budget add cancelled", "info");
		return;
	}
	if (limit.scope === "project") limit.cwd = session.cwd;
	await saveLimit(store, limit, ctx.ui.notify);
}

async function saveLimit(store: FileLedgerStore, limit: BudgetLimit, notify: Notify): Promise<void> {
	const cfg = await store.loadBudgets();
	cfg.limits.push(limit);
	await store.saveBudgets(cfg);
	const metricTxt = limit.metric === "cost" ? `$${limit.max}` : `${fmtNum(limit.max)} tok`;
	notify(`Added local budget: ${limit.scope}/${limit.period}/${limit.metric} = ${metricTxt} (warn ${limit.warn ?? 0.8})`, "info");
}
