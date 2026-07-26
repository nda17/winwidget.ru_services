export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogger {
	log(
		level: LogLevel,
		event: string,
		fields?: Record<string, unknown>
	): void;
}

const normalizeField = (value: unknown): unknown => {
	if (typeof value === 'string') return value.slice(0, 512);
	if (
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		value === null
	) {
		return value;
	}
	return undefined;
};

export const logger: StructuredLogger = {
	log(level, event, fields = {}) {
		const safeFields = Object.fromEntries(
			Object.entries(fields)
				.map(([key, value]) => [key, normalizeField(value)])
				.filter(([, value]) => value !== undefined)
		);
		const line = JSON.stringify({
			timestamp: new Date().toISOString(),
			level,
			service: 'api-gateway',
			event,
			...safeFields
		});

		if (level === 'error') {
			console.error(line);
			return;
		}
		if (level === 'warn') {
			console.warn(line);
			return;
		}
		console.log(line);
	}
};
