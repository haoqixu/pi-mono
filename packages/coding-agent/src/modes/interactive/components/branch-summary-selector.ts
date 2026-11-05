import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { Container, getKeybindings, SelectList, Spacer } from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";
import { ThemedText } from "./themed-text.ts";

export type BranchSummaryChoice = "No summary" | "Summarize" | "Summarize with custom prompt";
export type BranchSummaryAction =
	| BranchSummaryChoice
	| "selectModel"
	| "cycleForward"
	| "cycleBackward"
	| "cycleThinking"
	| "save"
	| "expandTools";

/** Local configuration for one tree navigation, not the conversation's model selection. */
export interface BranchSummaryConfig {
	model?: Model<string>;
	thinkingLevel: ThinkingLevel;
	error?: string;
}

export class BranchSummarySelectorComponent extends Container {
	private readonly list: SelectList;
	private readonly onAction: (action: BranchSummaryAction) => void;

	constructor(config: BranchSummaryConfig, onAction: (action: BranchSummaryAction) => void, onCancel: () => void) {
		super();
		this.onAction = onAction;
		const borderColor = (text: string) => theme.getThinkingBorderColor(config.thinkingLevel)(text);
		this.addChild(new DynamicBorder(borderColor));
		this.addChild(new ThemedText(() => theme.fg("accent", theme.bold("Summarize branch?")), 1, 0));
		this.addChild(
			new ThemedText(
				() => {
					if (config.error) return theme.fg("warning", config.error);
					const { model, thinkingLevel } = config;
					let label = model?.id || "no-model";
					if (model?.reasoning) {
						label += ` • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}`;
					}
					return theme.fg("dim", `Using: ${model ? `(${model.provider}) ` : ""}${label}`);
				},
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		const choices: BranchSummaryChoice[] = ["No summary", "Summarize", "Summarize with custom prompt"];
		this.list = new SelectList(
			choices.map((choice) => ({ value: choice, label: choice })),
			choices.length,
			getSelectListTheme(),
		);
		this.list.onSelect = (item) => onAction(item.value as BranchSummaryChoice);
		this.list.onCancel = onCancel;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new ThemedText(
				() => `${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "back")}`,
				1,
				0,
			),
		);
		this.addChild(
			new ThemedText(
				() =>
					keyHint("app.model.select", "model") +
					"  " +
					keyHint("app.model.cycleForward", "cycle model") +
					"  " +
					keyHint("app.thinking.cycle", "thinking") +
					"  " +
					keyHint("app.models.save", "to set as default"),
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder(borderColor));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.model.select")) this.onAction("selectModel");
		else if (kb.matches(data, "app.model.cycleForward")) this.onAction("cycleForward");
		else if (kb.matches(data, "app.model.cycleBackward")) this.onAction("cycleBackward");
		else if (kb.matches(data, "app.thinking.cycle")) this.onAction("cycleThinking");
		else if (kb.matches(data, "app.models.save")) this.onAction("save");
		else if (kb.matches(data, "app.tools.expand")) this.onAction("expandTools");
		else this.list.handleInput(data);
	}
}
