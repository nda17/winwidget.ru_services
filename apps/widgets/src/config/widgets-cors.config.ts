const CORS_CONFIGURATION_ERROR =
	'CORS_ALLOWED_ORIGINS must contain exact http/https origins';

export function parseWidgetsCorsAllowedOrigins(value?: string): string[] {
	const candidates = value?.split(',');
	if (!candidates?.length) throw new Error(CORS_CONFIGURATION_ERROR);

	const origins = new Set<string>();
	for (const rawCandidate of candidates) {
		const candidate = rawCandidate.trim();
		if (!candidate || candidate === '*') {
			throw new Error(CORS_CONFIGURATION_ERROR);
		}
		let url: URL;
		try {
			url = new URL(candidate);
		} catch {
			throw new Error(CORS_CONFIGURATION_ERROR);
		}
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(CORS_CONFIGURATION_ERROR);
		}
		origins.add(url.origin);
	}
	if (!origins.size) throw new Error(CORS_CONFIGURATION_ERROR);
	return [...origins];
}
