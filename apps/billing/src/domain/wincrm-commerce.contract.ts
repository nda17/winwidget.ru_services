export const WINCRM_PROVIDER_EVENT_TYPE =
	'billing.wincrm.provider-operation.requested.v1' as const;
export const WINCRM_PROVIDER_CONSUMER =
	'billing.wincrm-provider.v1' as const;

export type WincrmBillingCycle = 'MONTHLY' | 'YEARLY';
export type WincrmOrderState =
	| 'PENDING'
	| 'SUCCEEDED'
	| 'CANCELLED'
	| 'UNKNOWN';

export interface WincrmPriceSnapshot {
	policyVersion: number;
	monthlyPriceMinor: number;
	yearlyPriceMinor: number;
	additionalSeatMonthlyPriceMinor: number;
	additionalSeatYearlyPriceMinor: number;
	includedSeats: number;
	graceDays: number;
}

export interface WincrmCapacityFence {
	operationId: string;
	requestHash: string;
	fenceRevision: number;
	targetSeats: number;
}

export interface WincrmCommerceContext {
	schemaVersion: 1;
	workspaceId: string;
	actorSubject: string;
}

export interface WincrmCommerceCommand extends WincrmCommerceContext {
	commandId: string;
	expectedBillingVersion: string;
}

export interface WincrmCheckoutCommand extends WincrmCommerceCommand {
	expectedPolicyVersion: number;
	cycle: WincrmBillingCycle;
	totalSeats: number;
	autoRenew: boolean;
	consentVersion: string | null;
	capacityFence: WincrmCapacityFence;
}

export interface WincrmSeatChangeCommand extends WincrmCommerceCommand {
	expectedPeriodId: string;
	expectedPeriodVersion: number;
	newTotalSeats: number;
	capacityFence: WincrmCapacityFence;
}

export interface WincrmDisableRenewalCommand extends WincrmCommerceCommand {
	expectedRenewalVersion: number;
}

export interface WincrmConfirmRenewalCommand extends WincrmDisableRenewalCommand {
	expectedPolicyVersion: number;
	consentVersion: string;
}

export interface WincrmVerifyOrderCommand extends WincrmCommerceCommand {
	orderId: string;
	expectedOrderVersion: number;
}

export interface WincrmQuoteRequest extends WincrmCommerceContext {
	intent: 'CHECKOUT' | 'SEAT_CHANGE' | 'RENEWAL';
	cycle: WincrmBillingCycle;
	totalSeats: number;
}

export interface WincrmCommerceQuote {
	schemaVersion: 1;
	workspaceId: string;
	billingVersion: string;
	serverTime: string;
	validUntil: string;
	intent: 'CHECKOUT' | 'SEAT_CHANGE' | 'RENEWAL';
	cycle: WincrmBillingCycle;
	totalSeats: number;
	amountMinor: string;
	currency: 'RUB';
	priceSnapshot: WincrmPriceSnapshot;
	startsAt: string;
	expiresAt: string;
	period: {
		id: string;
		version: number;
		oldTotalSeats: number;
		oldExpiresAt: string;
		oldPeriodPriceMinor: string;
		newPeriodPriceMinor: string;
	} | null;
	consent: { version: string; text: string };
}

export interface WincrmCommandStatusRequest extends WincrmCommerceContext {
	commandId: string;
	requestHash: string;
}

export interface WincrmCloseCommand extends WincrmCommandStatusRequest {
	commandType: 'WINCRM_CHECKOUT' | 'WINCRM_SEAT_CHANGE';
	capacityFence: WincrmCapacityFence;
}

export interface WincrmOrderRequest extends WincrmCommerceContext {
	orderId: string;
}

export interface WincrmHistoryRequest extends WincrmCommerceContext {
	page: number;
	pageSize: number;
}

export interface WincrmOrderResponse {
	schemaVersion: 1;
	workspaceId: string;
	serverTime: string;
	order: WincrmOrderView;
}

export interface WincrmHistoryResponse {
	schemaVersion: 1;
	workspaceId: string;
	page: number;
	pageSize: number;
	total: number;
	items: WincrmOrderView[];
}

export interface WincrmProviderEvent {
	schemaVersion: 1;
	eventType: typeof WINCRM_PROVIDER_EVENT_TYPE;
	eventId: string;
	operationId: string;
}

export interface WincrmProviderClaim {
	operationId: string;
	eventId: string;
	leaseToken: string;
	version: number;
}

export type WincrmProviderClaimResult =
	| { state: 'DONE' | 'BUSY' }
	| { state: 'CLAIMED'; claim: WincrmProviderClaim };

// Provider-only material: never serialize this object to Outbox, receipts,
// public HTTP, exception messages or diagnostic logs. The caller decrypts the
// saved method immediately before invoking the provider adapter.
export interface WincrmProviderCreateRequest {
	productCode: 'WINCRM';
	paymentId: string;
	plan: 'WINCRM';
	billingPeriod: WincrmBillingCycle;
	kind: 'ONE_TIME' | 'RECURRING';
	amount: string;
	currency: 'RUB';
	autoRenew: boolean;
	customerEmail: string | null;
	customerPhone: string | null;
	returnUrl: string | null;
	paymentMethodCiphertext: string | null;
}

export type WincrmPreparedProviderOperation =
	| { action: 'SKIP' }
	| {
			action: 'CREATE' | 'VERIFY' | 'SYNC_RECEIPT';
			orderId: string;
			workspaceId: string;
			ownerSubject: string;
			commandId: string;
			capacityFence: WincrmCapacityFence;
			providerPaymentId: string | null;
			idempotencyKey: string;
			request: WincrmProviderCreateRequest | null;
			firstDispatchAt: string | null;
	  };

export type WincrmProviderFailureCode =
	| 'TRANSPORT_UNKNOWN'
	| 'PROVIDER_RETRYABLE'
	| 'PROVIDER_REJECTED'
	| 'PROVIDER_INVALID_RESPONSE'
	| 'PROVIDER_BINDING_MISMATCH'
	| 'DEPENDENCY_UNAVAILABLE'
	| 'AUTHORIZATION_REVOKED'
	| 'LEASE_EXPIRED'
	| 'IDEMPOTENCY_WINDOW_EXPIRED';

export interface WincrmProviderFailure {
	code: WincrmProviderFailureCode;
	ambiguous: boolean;
	retryable: boolean;
	providerPaymentId?: string;
}

export class WincrmProviderResponseError extends Error {
	readonly retryable = false;
	constructor(
		readonly code:
			| 'PROVIDER_BINDING_MISMATCH'
			| 'PROVIDER_INVALID_RESPONSE'
	) {
		super('WinCRM provider response failed validation');
		this.name = 'WincrmProviderResponseError';
	}
}

export interface WincrmOrderView {
	id: string;
	workspaceId: string;
	version: number;
	kind: 'ONE_TIME' | 'RECURRING';
	state: WincrmOrderState;
	cycle: WincrmBillingCycle;
	totalSeats: number;
	amountMinor: string;
	currency: 'RUB';
	policyVersion: number;
	confirmationUrl: string | null;
	canVerify: boolean;
	checkoutExpiresAt: string;
	createdAt: string;
	succeededAt: string | null;
	fulfillment: 'NONE' | 'SCHEDULED' | 'ACTIVE' | 'EXPIRED';
	periodId: string | null;
	startsAt: string | null;
	expiresAt: string | null;
}

export interface WincrmPaidPeriodView {
	id: string;
	orderId: string;
	version: number;
	cycle: WincrmBillingCycle;
	totalSeats: number;
	priceSnapshot: WincrmPriceSnapshot;
	startsAt: string;
	expiresAt: string;
	graceUntil: string;
	state: 'SCHEDULED' | 'ACTIVE' | 'GRACE' | 'EXPIRED';
}

export interface WincrmRenewalView {
	version: number;
	state:
		| 'NONE'
		| 'ACTIVE'
		| 'USER_DISABLED'
		| 'TECHNICAL_PAUSE'
		| 'PRICE_CONFIRMATION_REQUIRED'
		| 'REVOKED';
	canDisable: boolean;
	dispatchPending: boolean;
	nextChargeAt: string | null;
	nextRetryAt: string | null;
	retryAttempt: number;
	methodLast4: string | null;
	methodTitle: string | null;
}

export interface WincrmCommerceSummary {
	schemaVersion: 1;
	workspaceId: string;
	billingVersion: string;
	serverTime: string;
	policy: WincrmPriceSnapshot;
	trial: { startsAt: string; expiresAt: string; seatLimit: number } | null;
	period: WincrmPaidPeriodView | null;
	pendingOrder: WincrmOrderView | null;
	renewal: WincrmRenewalView;
}

export interface WincrmCommerceCommandProof {
	schemaVersion: 1;
	workspaceId: string;
	commandId: string;
	requestHash: string;
	status: 'PENDING' | 'COMMITTED' | 'CANCELLED';
	billingVersion: string;
	releaseFence: boolean;
	holdUntil: string | null;
	order: WincrmOrderView | null;
	period: WincrmPaidPeriodView | null;
}
