export const WIDGETS_AI_PROVIDER = Symbol('WIDGETS_AI_PROVIDER');

export class WidgetsAiProviderUnavailableError extends Error {
	constructor(readonly code: string) {
		super('AI provider is temporarily unavailable');
		this.name = 'WidgetsAiProviderUnavailableError';
	}
}

export class WidgetsAiProviderResponseError extends Error {
	constructor(readonly code: string) {
		super('AI provider returned an unusable response');
		this.name = 'WidgetsAiProviderResponseError';
	}
}

export type WidgetsAiMessageRole = 'system' | 'user' | 'assistant';

export interface WidgetsAiMessage {
	role: WidgetsAiMessageRole;
	content: string;
}

export interface WidgetsAiGenerateInput {
	messages: WidgetsAiMessage[];
	maxTokens?: number;
	thinkingMode: 'disabled';
}

export interface WidgetsAiProvider {
	generate(input: WidgetsAiGenerateInput): Promise<string>;
}
