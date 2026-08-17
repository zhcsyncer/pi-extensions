import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readLocalQuotaCache, STATUS_CACHE_POLL_MS } from "../src/chrome/status-cache.ts";
import { renderStatusText, STATUS_KEY } from "../src/chrome/widget.ts";
import { renderUsagePanel, usageSeverity } from "../src/chrome/usage-panel.ts";
import { loadMeterConfig, parseQuotaVisibleArg, saveMeterConfig, type MeterConfig } from "../src/config.ts";
import { findConflictingUsageCommand } from "../src/conflict.ts";
import { addBudgetFlow, pickSelect, type BudgetUi } from "../src/ledger/budget-add.ts";
import { computeFooterStats, FOOTER_LOCALS, parseFooterLocal, renderLocalFooter, type FooterLocal } from "../src/ledger/footer.ts";
import { budgetKey, statusForLimit } from "../src/ledger/budget.ts";
import { Dashboard } from "../src/ledger/dashboard.ts";
import { DIMENSIONS } from "../src/ledger/enums.ts";
import { fmtCompactTokens, fmtCost, fmtNum } from "../src/ledger/format.ts";
import { aggregate, sumRows } from "../src/ledger/aggregate.ts";
import { parseSession, diffRecords, usageFromAssistantMessage } from "../src/ledger/session-parser.ts";
import { createLedgerStore, type FileLedgerStore } from "../src/ledger/store.ts";
import { parseWindowArg, sessionIdFrom } from "../src/ledger/time.ts";
import type { BudgetLimit, UsageRecord, WindowKey } from "../src/ledger/types.ts";
import { chromeWindow } from "../src/quota/policy.ts";
import { preferredProvider, refreshQuotaSnapshots } from "../src/quota/refresh.ts";
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
	let chromeClosed = false;
	let hasStatus = false;
	let lastStatusText: string | undefined;
	let statusPoll: ReturnType<typeof setInterval> | undefined;

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
		}
		if (!config) {
			const loaded = await loadMeterConfig(agentDir);
			config = loaded.config;
			if (loaded.migration) notify(ctx, loaded.migration, "info");
			if (loaded.warning) notify(ctx, loaded.warning, "warning");
		}
		if (!quota) quota = await readLocalQuotaCache(agentDir, {
			ttlMs: config.quota.snapshotTtlMs,
			minIntervalMs: config.quota.minRefreshIntervalMs,
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
				"@zhcsyncer/pi-meter and @pi-plugins/usage both register /usage. Disable @pi-plugins/usage; this package uses /usage for the local ledger and subscription remaining.",
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

	function stopStatusPoll(): void {
		if (statusPoll === undefined) return;
		clearInterval(statusPoll);
		statusPoll = undefined;
	}

	function startStatusPoll(ctx: ExtensionContext): void {
		stopStatusPoll();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const timer = setInterval(() => syncChromeFromLocalCache(ctx), STATUS_CACHE_POLL_MS);
		timer.unref?.();
		statusPoll = timer;
	}

	async function syncChromeFromLocalCache(ctx: ExtensionContext): Promise<void> {
		if (chromeClosed || ctx.mode !== "tui" || !ctx.hasUI) return;
		try {
			await ensureReady(ctx);
			if (chromeClosed || !config) return;
			quota = await readLocalQuotaCache(agentDir, {
				ttlMs: config.quota.snapshotTtlMs,
				minIntervalMs: config.quota.minRefreshIntervalMs,
			});
			await renderChrome(ctx);
		} catch {
			// Idle polls must not surface disk races from another session.
		}
	}

	async function renderChrome(ctx: ExtensionContext): Promise<void> {
		if (chromeClosed || ctx.mode !== "tui" || !ctx.hasUI || !store || !config) return;
		const records = await store.readAll();
		const limits = (await store.loadBudgets()).limits;
		const local = renderLocalFooter(config.footer.local, computeFooterStats(records, limits));
		const preferred = preferredProvider(ctx.model);
		const view = config.footer.quota && quota ? chromeWindow(quota, preferred) : undefined;
		const text = renderStatusText({
			local,
			quota: view,
			polarity: config.quota.polarity,
		}, ctx.ui.theme);
		if (hasStatus && text === lastStatusText) return;
		hasStatus = true;
		lastStatusText = text;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	async function maybeRefreshQuota(ctx: ExtensionContext, force = false): Promise<void> {
		await ensureReady(ctx);
		if (!config) return;
		const result = await refreshQuotaSnapshots(ctx, agentDir, {
			force,
			ttlMs: config.quota.snapshotTtlMs,
			minIntervalMs: config.quota.minRefreshIntervalMs,
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
		chromeClosed = false;
		hasStatus = false;
		lastStatusText = undefined;
		await ensureReady(ctx);
		warnUsageConflict(ctx);
		await renderChrome(ctx);
		startStatusPoll(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		chromeClosed = true;
		stopStatusPoll();
		hasStatus = false;
		lastStatusText = undefined;
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

	async function handleQuota(arg: string, ctx: ExtensionContext): Promise<void> {
		warnUsageConflict(ctx);
		const visible = parseQuotaVisibleArg(arg, config!.footer.quota);
		if (visible !== undefined) {
			await persistConfig({
				...config!,
				footer: { ...config!.footer, quota: visible },
			}, ctx);
			notify(ctx, visible ? "Quota window on." : "Quota window off.", "info");
			return;
		}
		if (arg === "used" || arg === "remaining") {
			await persistConfig({
				...config!,
				quota: { ...config!.quota, polarity: arg },
			}, ctx);
			notify(ctx, `Quota polarity: ${arg}`, "info");
			return;
		}
		if (arg && arg !== "refresh") {
			notify(ctx, "Unknown /usage quota argument. Try refresh, used, remaining, on, or off.", "warning");
			return;
		}
		await maybeRefreshQuota(ctx, arg === "refresh");
		const snapshots = QUOTA_PROVIDERS.map((id) => quota?.providers[id]).filter((item): item is NonNullable<typeof item> => item !== undefined);
		const missing = QUOTA_PROVIDERS.filter((id) => !quota?.providers[id]).map((id) => ({
			provider: id,
			title: id === "claude" ? "Claude" : id === "codex" ? "OpenAI Codex" : "SuperGrok",
			windows: [],
			fetchedAt: 0,
			ok: false,
			error: "no snapshot yet",
		}));
		const report = renderUsagePanel([...snapshots, ...missing], config!.quota.polarity);
		notify(ctx, report, usageSeverity([...snapshots, ...missing], config!.quota.polarity));
	}

	const usageCompletions = (prefix: string) => {
		const options = [
			{ value: "today", label: "today" },
			{ value: "week", label: "week" },
			{ value: "month", label: "month" },
			{ value: "6months", label: "6months" },
			{ value: "year", label: "year" },
			{ value: "all", label: "all" },
			{ value: "quota", label: "quota", description: "Subscription remaining" },
			{ value: "quota refresh", label: "quota refresh", description: "Force-refresh shared snapshots" },
			{ value: "quota used", label: "quota used" },
			{ value: "quota remaining", label: "quota remaining" },
			{ value: "quota on", label: "quota on", description: "Show the quota window in the footer" },
			{ value: "quota off", label: "quota off", description: "Hide the quota window" },
			{ value: "import", label: "import", description: "Back-fill from session files" },
			{ value: "footer", label: "footer", description: "Choose the local usage summary" },
			...FOOTER_LOCALS.map((preset) => ({ value: `footer ${preset.key}`, label: `footer ${preset.key}`, description: preset.description })),
			{ value: "budget", label: "budget", description: "View local budgets" },
		];
		return options.filter((option) => option.value.startsWith(prefix.trim().toLowerCase()));
	};

	const handleUsageCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
		await ensureReady(ctx);
		const arg = args.trim().toLowerCase();
		if (arg === "import") {
			await importHistory(store!, ctx.ui.notify);
			return;
		}
		if (arg === "quota" || arg.startsWith("quota ")) {
			await handleQuota(arg.slice("quota".length).trim(), ctx);
			return;
		}
		if (arg === "budget" || arg.startsWith("budget ")) {
			await handleBudget(arg.slice("budget".length).trim(), store!, session, ctx);
			return;
		}
		if (arg === "footer" || arg.startsWith("footer ")) {
			await handleFooter(arg.slice("footer".length).trim(), config!, persistConfig, ctx);
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
			notify(ctx, "Unknown /usage argument. Try quota, footer, import, budget, or a time window.", "warning");
			return;
		}
		if (ctx.mode !== "tui") {
			printReport(await store!.readAll(), "today", ctx.ui.notify);
			return;
		}
		const choice = await pickUsageMenu(ctx);
		if (!choice) return;
		switch (choice) {
			case "dashboard":
				await openDashboard("today", store!, session, ctx);
				break;
			case "quota":
				await handleQuota("", ctx);
				break;
			case "footer":
				await handleFooter("", config!, persistConfig, ctx);
				break;
			case "import":
				await importHistory(store!, ctx.ui.notify);
				break;
			case "budget":
				await handleBudget("", store!, session, ctx);
				break;
			case "help":
				printHelp(ctx.ui.notify);
				break;
		}
	};

	pi.registerCommand("usage", {
		description: "Local usage ledger and subscription remaining",
		getArgumentCompletions: usageCompletions,
		handler: handleUsageCommand,
	});
}

type UsageMenuChoice = "dashboard" | "quota" | "footer" | "import" | "budget" | "help";

async function pickUsageMenu(ctx: ExtensionContext): Promise<UsageMenuChoice | null> {
	return pickSelect<UsageMenuChoice>(
		{ custom: ctx.ui.custom.bind(ctx.ui) as BudgetUi["custom"] },
		"Usage",
		[
			{ value: "dashboard", label: "Dashboard", description: "Local ledger by model / project / session" },
			{ value: "quota", label: "Quota", description: "Subscription remaining for Claude, Codex, and SuperGrok" },
			{ value: "footer", label: "Local summary", description: "What local usage the footer shows" },
			{ value: "budget", label: "Budgets", description: "View local token/cost reminders" },
			{ value: "import", label: "Import history", description: "Back-fill from session JSONL" },
			{ value: "help", label: "Help", description: "Command reference" },
		],
	);
}

async function handleBudget(arg: string, store: FileLedgerStore, session: SessionBits, ctx: ExtensionContext): Promise<void> {
	if (arg.startsWith("add")) {
		await addBudget(arg.slice(3).trim(), store, session, ctx);
		return;
	}
	viewBudgets((await store.loadBudgets()).limits, ctx.ui.notify);
}

async function handleFooter(
	arg: string,
	config: MeterConfig,
	persist: (next: MeterConfig, ctx: ExtensionContext) => Promise<void>,
	ctx: ExtensionContext,
): Promise<void> {
	if (arg.length > 0) {
		const local = parseFooterLocal(arg);
		if (!local) {
			ctx.ui.notify(`Unknown footer. Options: ${FOOTER_LOCALS.map((item) => item.key).join(", ")}`, "warning");
			return;
		}
		await persist({ ...config, footer: { ...config.footer, local } }, ctx);
		ctx.ui.notify(`Footer: ${FOOTER_LOCALS.find((item) => item.key === local)?.label ?? local}`, "info");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Usage: /usage footer <${FOOTER_LOCALS.map((item) => item.key).join("|")}>`, "info");
		return;
	}
	const choice = await pickSelect<FooterLocal>(
		{ custom: ctx.ui.custom.bind(ctx.ui) as BudgetUi["custom"] },
		"Local footer",
		FOOTER_LOCALS.map((preset) => ({ value: preset.key, label: preset.label, description: preset.description })),
	);
	if (!choice) {
		ctx.ui.notify("Footer unchanged", "info");
		return;
	}
	await persist({ ...config, footer: { ...config.footer, local: choice } }, ctx);
	ctx.ui.notify(`Footer: ${FOOTER_LOCALS.find((item) => item.key === choice)?.label ?? choice}`, "info");
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
		notify("No local budgets. Use /usage budget add.", "info");
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
			"  /usage                       Open the menu (TUI).",
			"  /usage [today|week|month|6months|year|all]",
			"      Local ledger dashboard with tokens plus input / output / cache.",
			"  /usage quota [refresh|used|remaining|on|off]",
			"      Subscription remaining for Claude, Codex, and SuperGrok.",
			"  /usage footer [today-spend|today-tokens|today-cost|budget|model|off]",
			"      Choose the local usage summary.",
			"  /usage import         Back-fill from session JSONL (idempotent).",
			"  /usage budget [add]   View or add a local budget.",
			"",
			"Data: $PI_CODING_AGENT_DIR/extension-data/pi-meter/",
			"Disable @pi-plugins/usage — it also registers /usage.",
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
				`  ${row.label.padEnd(28)} ${fmtCompactTokens(row.tokens).padStart(10)}  in ${fmtCompactTokens(row.input).padStart(10)}  out ${fmtCompactTokens(row.output).padStart(10)}  cr ${fmtCompactTokens(row.cacheRead).padStart(10)}  cw ${fmtCompactTokens(row.cacheWrite).padStart(10)}  ${fmtCost(row.cost).padStart(10)}`,
			);
		}
		out.push(`  ${"TOTAL".padEnd(28)} ${fmtCompactTokens(total.tokens).padStart(10)}  in ${fmtCompactTokens(total.input).padStart(10)}  out ${fmtCompactTokens(total.output).padStart(10)}  cr ${fmtCompactTokens(total.cacheRead).padStart(10)}  cw ${fmtCompactTokens(total.cacheWrite).padStart(10)}  ${fmtCost(total.cost).padStart(10)}`);
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
				`Invalid. Usage: /usage budget add <scope:${VALID_SCOPES.join("|")}> <period:${VALID_PERIODS.join("|")}> <metric:${VALID_METRICS.join("|")}> <max> [warn]`,
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
		ctx.ui.notify("Interactive /usage budget add needs TUI. Use: /usage budget add <scope> <period> <metric> <max>", "warning");
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
