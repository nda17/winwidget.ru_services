export type OutboundHttpProvider = 'webhook' | 'bitrix24' | 'amo-crm';

export interface SafeOutboundHttpErrorDetails {
	provider: OutboundHttpProvider;
	httpStatus: number | null;
	providerCode: string | null;
	retryAfterMs: number | null;
	safeReason: string;
}

export class SafeOutboundHttpError extends Error {
	readonly provider: OutboundHttpProvider;
	readonly httpStatus: number | null;
	readonly providerCode: string | null;
	readonly retryAfterMs: number | null;
	readonly safeReason: string;

	constructor(details: SafeOutboundHttpErrorDetails) {
		super(details.safeReason);
		this.name = 'SafeOutboundHttpError';
		this.provider = details.provider;
		this.httpStatus = details.httpStatus;
		this.providerCode = details.providerCode;
		this.retryAfterMs = details.retryAfterMs;
		this.safeReason = details.safeReason;
	}
}
