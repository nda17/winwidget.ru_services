// Service-owned copy of the versioned Billing HTTP contract. Never import
// another app's runtime. Parity is exercised by the contract tests.
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

export interface WincrmOrderView {
	canVerify: boolean;
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
export type CommerceCommandType =
	| 'WINCRM_CHECKOUT'
	| 'WINCRM_SEAT_CHANGE'
	| 'WINCRM_DISABLE_RENEWAL'
	| 'WINCRM_CONFIRM_RENEWAL'
	| 'WINCRM_VERIFY_ORDER';
export type CommerceUserCommand =
	| Omit<WincrmCheckoutCommand, 'capacityFence'>
	| Omit<WincrmSeatChangeCommand, 'capacityFence'>
	| WincrmDisableRenewalCommand
	| WincrmConfirmRenewalCommand
	| WincrmVerifyOrderCommand;
export interface CrmBillingOperationView {
	schemaVersion: 1;
	workspaceId: string;
	commandId: string;
	state: 'PENDING' | 'COMMITTED' | 'CANCELLED' | 'NOT_STARTED';
	requestHash: string | null;
	billing: WincrmCommerceCommandProof | null;
}
export interface CrmBillingContext {
	schemaVersion: 1;
	workspaceId: string;
	actorSubject: string;
	billing: WincrmCommerceSummary;
	capacity: {
		usedSeats: number;
		admissionCeiling: number | null;
		pendingOperationId: string | null;
	};
	capabilities: {
		quote: boolean;
		checkout: boolean;
		changeSeats: boolean;
		disableAutoRenew: boolean;
		confirmRenewalPrice: boolean;
	};
}
