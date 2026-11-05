import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Container, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import {
	type BranchSummaryConfig,
	BranchSummarySelectorComponent,
} from "../../src/modes/interactive/components/branch-summary-selector.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
async function setup() {
	const harness = await createHarness({
		models: [
			{ id: "chat", reasoning: true },
			{ id: "summary", reasoning: true },
			{ id: "plain", reasoning: false },
		],
		settings: { branchSummary: { provider: "faux", model: "summary", thinkingLevel: "medium" } },
	});
	harnesses.push(harness);
	return harness;
}

function createUI(harness: Harness) {
	const editor = new Container();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	const state = {
		runtimeHost: { session: harness.session },
		editor,
		editorContainer: new Container(),
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		programStatus: { setBlocked: vi.fn() },
		showStatus: vi.fn(),
	};
	Object.assign(mode, state);
	return {
		...state,
		prompt: (config: BranchSummaryConfig) =>
			(
				Reflect.get(mode, "showBranchSummaryPrompt") as (config: BranchSummaryConfig) => Promise<string | undefined>
			).call(mode, config),
		modelPicker: (config: BranchSummaryConfig) =>
			(
				Reflect.get(mode, "showBranchSummaryModelSelector") as (config: BranchSummaryConfig) => Promise<boolean>
			).call(mode, config),
		dispose: () => (Reflect.get(mode, "disposeActiveSelector") as () => void).call(mode),
		input: (data: string) => state.editorContainer.children[0]?.handleInput?.(data),
	};
}

function seed(harness: Harness): string {
	const target = harness.sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	harness.sessionManager.appendMessage(fauxAssistantMessage("work on the old branch"));
	harness.session.refreshContext();
	return target;
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

describe("branch summary one-off configuration", () => {
	it("resolves defaults and clamps one-off overrides without mutating session or settings", async () => {
		const h = await setup();
		const settings = h.settingsManager.getSettings();
		expect(h.session.resolveBranchSummaryConfig()).toMatchObject({
			model: { id: "summary" },
			thinkingLevel: "medium",
		});
		expect(h.session.resolveBranchSummaryConfig({ model: h.getModel("plain"), thinkingLevel: "high" })).toMatchObject(
			{ model: { id: "plain" }, thinkingLevel: "off" },
		);
		expect(h.session.model?.id).toBe("chat");
		expect(h.settingsManager.getSettings()).toEqual(settings);
	});

	it.each(["high", "off", "max"] as const)(
		"uses a one-off model and %s thinking only for the summary request",
		async (level) => {
			const h = await setup();
			const target = seed(h);
			const settings = h.settingsManager.getSettings();
			const thinking = h.session.thinkingLevel;
			h.setResponses([
				(_context, options, _state, model) => {
					expect(model.id).toBe("chat");
					expect(options?.reasoning).toBe(level === "off" ? undefined : "high");
					return fauxAssistantMessage("one-off summary");
				},
			]);
			const result = await h.session.navigateTree(target, {
				summarize: true,
				model: h.getModel(),
				thinkingLevel: level,
			});
			expect(result.summaryEntry?.summary).toContain("one-off summary");
			expect(h.session.model?.id).toBe("chat");
			expect(h.session.thinkingLevel).toBe(thinking);
			expect(h.settingsManager.getSettings()).toEqual(settings);
			expect(
				h.sessionManager
					.getEntries()
					.filter((e) => e.type === "model_change" || e.type === "thinking_level_change"),
			).toEqual([]);
		},
	);

	it("allows replacing invalid configured models, including without a conversation model", async () => {
		const h = await setup();
		h.settingsManager.applyOverrides({ branchSummary: { model: "missing" } });
		expect(() => h.session.resolveBranchSummaryConfig()).toThrow("branchSummary");
		const target = seed(h);
		Reflect.set(h.session.agent.state, "model", undefined);
		h.setResponses([fauxAssistantMessage("replacement summary")]);
		const result = await h.session.navigateTree(target, { summarize: true, model: h.getModel("summary") });
		expect(result.summaryEntry?.summary).toContain("replacement summary");
		expect(h.session.model).toBeUndefined();
	});

	it("ignores invalid summary defaults when navigating without a summary", async () => {
		const h = await setup();
		h.settingsManager.applyOverrides({ branchSummary: { model: "missing" } });
		expect(await h.session.navigateTree(seed(h))).toMatchObject({ cancelled: false });
		expect(h.faux.state.callCount).toBe(0);
	});

	it("preserves extension-provided summaries without resolving invalid defaults", async () => {
		const h = await createHarness({
			settings: { branchSummary: { provider: "missing", model: "missing" } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ summary: { summary: "extension summary" } }));
				},
			],
		});
		harnesses.push(h);
		const result = await h.session.navigateTree(seed(h), { summarize: true, thinkingLevel: "high" });
		expect(result.summaryEntry?.summary).toBe("extension summary");
		expect(h.faux.state.callCount).toBe(0);
	});
});

describe("branch summary prompt", () => {
	it("cycles locally, preserves the selected choice, and saves only on the configured shortcut", async () => {
		const h = await setup();
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		const ui = createUI(h);
		const config = h.session.resolveBranchSummaryConfig();
		const promise = ui.prompt(config);
		ui.input("\x1b[B");
		ui.input("\x10"); // next model: plain
		expect(config.model.id).toBe("plain");
		expect(config.thinkingLevel).toBe("off");
		ui.input("\x13");
		expect(h.settingsManager.getBranchSummarySettings().model).toBe("summary");
		ui.input("\x12");
		expect(h.settingsManager.getBranchSummarySettings()).toMatchObject({ model: "plain", thinkingLevel: "off" });
		expect(h.session.model?.id).toBe("chat");
		ui.input("\r");
		expect(await promise).toBe("Summarize");
		expect(ui.editorContainer.children).toEqual([ui.editor]);
		expect(ui.programStatus.setBlocked).toHaveBeenLastCalledWith("selector", undefined);
	});

	it("cycles supported thinking levels without persisting", async () => {
		const h = await setup();
		const ui = createUI(h);
		const config = h.session.resolveBranchSummaryConfig();
		const promise = ui.prompt(config);
		ui.input("\x1b[Z");
		expect(config.thinkingLevel).toBe("high");
		expect(h.settingsManager.getBranchSummarySettings().thinkingLevel).toBe("medium");
		ui.input("\x1b");
		expect(await promise).toBeUndefined();
	});

	it("uses the sole available scoped model even if the current model is outside the scope", async () => {
		const h = await setup();
		h.session.setScopedModels([{ model: h.getModel(), thinkingLevel: "low" }]);
		const ui = createUI(h);
		const config = h.session.resolveBranchSummaryConfig();
		const promise = ui.prompt(config);
		ui.input("\x10");
		expect(config).toMatchObject({ model: { id: "chat" }, thinkingLevel: "low" });
		ui.input("\r");
		expect(await promise).toBe("No summary");
	});

	it.each([
		{ action: "app.model.cycleForward", expected: ["chat", "plain", "chat"] },
		{ action: "app.model.cycleBackward", expected: ["plain", "chat", "plain"] },
	] as const)("cycles $action from outside the scope and wraps in scope order", async ({ action, expected }) => {
		const h = await setup();
		const chat = h.getModel();
		const plain = h.models[2];
		h.session.setScopedModels([
			{ model: chat, thinkingLevel: "low" },
			{ model: { ...chat, id: "unavailable" } },
			{ model: plain, thinkingLevel: "high" },
		]);
		setKeybindings(new KeybindingsManager({ [action]: "ctrl+b" }));
		const ui = createUI(h);
		const config = h.session.resolveBranchSummaryConfig();
		const promise = ui.prompt(config);
		for (const id of expected) {
			ui.input("\x02");
			expect(config.model.id).toBe(id);
			expect(config.thinkingLevel).toBe(id === "chat" ? "low" : "off");
		}
		expect(h.session.model).toBe(chat);
		expect(h.settingsManager.getBranchSummarySettings()).toMatchObject({ model: "summary", thinkingLevel: "medium" });
		ui.input("\x1b");
		expect(await promise).toBeUndefined();
	});

	it("leaves local configuration unchanged when no scoped models are available", async () => {
		const h = await setup();
		h.session.setScopedModels([{ model: { ...h.getModel(), id: "unavailable" } }]);
		const ui = createUI(h);
		const config = h.session.resolveBranchSummaryConfig();
		const before = { ...config };
		const promise = ui.prompt(config);
		ui.input("\x10");
		expect(config).toEqual(before);
		ui.input("\x1b");
		expect(await promise).toBeUndefined();
	});

	it.each([false, true])(
		"selects a model with explicit persistence=%s without changing conversation defaults",
		async (persist) => {
			const h = await setup();
			const ui = createUI(h);
			const config = h.session.resolveBranchSummaryConfig();
			const promise = ui.modelPicker(config);
			for (const char of "plain") ui.input(char);
			ui.input(persist ? "\x13" : "\r");
			expect(await promise).toBe(true);
			expect(config).toMatchObject({ model: { id: "plain" }, thinkingLevel: "off" });
			expect(h.settingsManager.getBranchSummarySettings()).toMatchObject({
				model: persist ? "plain" : "summary",
				thinkingLevel: persist ? "off" : "medium",
			});
			expect(h.session.model?.id).toBe("chat");
			expect(h.settingsManager.getDefaultModel()).toBeUndefined();
			expect(h.settingsManager.getDefaultThinkingLevel()).toBeUndefined();
			expect(ui.programStatus.setBlocked).toHaveBeenLastCalledWith("selector", undefined);
		},
	);

	it("cancels model selection without changing local configuration", async () => {
		const h = await setup();
		const ui = createUI(h);
		const config = h.session.resolveBranchSummaryConfig();
		const before = { ...config };
		const promise = ui.modelPicker(config);
		ui.input("p");
		ui.input("\x1b");
		expect(await promise).toBe(true);
		expect(config).toEqual(before);
	});

	it("settles a displaced model picker without returning to the summary prompt", async () => {
		const h = await setup();
		const ui = createUI(h);
		const promise = ui.modelPicker(h.session.resolveBranchSummaryConfig());
		ui.dispose();
		expect(await promise).toBe(false);
		expect(ui.programStatus.setBlocked).toHaveBeenLastCalledWith("selector", undefined);
	});

	it("settles displaced prompts and clears blocked status", async () => {
		const h = await setup();
		const ui = createUI(h);
		const promise = ui.prompt(h.session.resolveBranchSummaryConfig());
		ui.dispose();
		expect(await promise).toBe("dismissed");
		expect(ui.programStatus.setBlocked).toHaveBeenLastCalledWith("selector", undefined);
	});

	it("keeps hints compact while preserving model cycling shortcuts", async () => {
		const h = await setup();
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r", "app.model.cycleForward": "ctrl+n" }));
		const onAction = vi.fn();
		const selector = new BranchSummarySelectorComponent(h.session.resolveBranchSummaryConfig(), onAction, vi.fn());
		const lines = selector.render(80).map(stripAnsi);
		expect(lines.filter((line) => /select.*back|model.*thinking.*to set as default/.test(line))).toHaveLength(2);
		expect(lines.join("\n")).toContain("ctrl+r to set as default");
		expect(lines.join("\n")).toContain("ctrl+n cycle model");
		expect(lines.join("\n")).not.toMatch(/next model|previous model/);
		selector.handleInput("\x0e");
		expect(onAction).toHaveBeenCalledWith("cycleForward");
	});

	it.each([
		{ modelId: "summary", level: "high" as const, label: "(faux) summary • high" },
		{ modelId: "summary", level: "off" as const, label: "(faux) summary • thinking off" },
		{ modelId: "plain", level: "off" as const, label: "(faux) plain" },
		{ modelId: "missing", level: "off" as const, label: "no-model" },
	])("always shows the provider with the footer model label style: $label", async ({ modelId, level, label }) => {
		const h = await setup();
		const selector = new BranchSummarySelectorComponent(
			{ model: h.getModel(modelId), thinkingLevel: level },
			vi.fn(),
			vi.fn(),
		);
		expect(selector.render(80).some((line) => line.includes(theme.fg("dim", `Using: ${label}`)))).toBe(true);
	});

	it("renders narrow widths and rebuilds themed state after invalidation", async () => {
		const h = await setup();
		const config: BranchSummaryConfig = h.session.resolveBranchSummaryConfig();
		const selector = new BranchSummarySelectorComponent(config, vi.fn(), vi.fn());
		for (const width of [10, 20, 40, 80]) {
			expect(selector.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		config.thinkingLevel = "high";
		initTheme("light");
		selector.invalidate();
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Using: (faux) summary • high");
	});
});
