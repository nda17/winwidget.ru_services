import {
	ConflictException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	hasExactKeys,
	isRecord,
	isUuidV4,
	parseInternalBaseUrl,
	parseInternalTimeout,
	parseInternalToken,
	readBoundedJson
} from './internal-http.config';

export const CRM_ENTITLEMENT_STATUSES = [
	'NOT_ACTIVATED',
	'ACTIVE',
	'GRACE',
	'READ_ONLY',
	'SUSPENDED',
	'EXPIRED',
	'CANCELLED'
] as const;
export type CrmEntitlementStatus =
	(typeof CRM_ENTITLEMENT_STATUSES)[number];

export interface CrmEntitlementDetails {
	id: string;
	workspaceId: string;
	provisioningCommandId: string;
	provisioningCommandType: string;
	activatedByUserId: string;
	planCode: string;
	seatLimit: number | null;
	trialStartedAt: string | null;
	effectiveFrom: string;
	effectiveUntil: string;
	aggregateVersion: string;
	sourceSequence: string;
}

export interface CrmEntitlementResponse {
	schemaVersion: 1;
	productCode: 'WINCRM';
	status: CrmEntitlementStatus;
	entitlement: CrmEntitlementDetails | null;
}

export type CrmTrialActivationResponse = CrmEntitlementResponse & {
	activated: boolean;
};

export interface ActivateCrmTrialCommand {
	schemaVersion: 1;
	commandId: string;
	workspaceId: string;
	activatedByUserId: string;
}

const BILLING_TOKEN_PLACEHOLDERS = [
	'billing_crm_access_token',
	'ci_billing_crm_access_token_at_least_32_chars'
];
const PROVISIONING_COMMAND_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

@Injectable()
export class BillingEntitlementClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly token: string;

	constructor(config: ConfigService) {
		this.baseUrl = parseInternalBaseUrl(
			'BILLING_INTERNAL_BASE_URL',
			config.get<string>('BILLING_INTERNAL_BASE_URL'),
			'http://127.0.0.1:4800'
		);
		this.timeoutMs = parseInternalTimeout(
			'BILLING_CRM_ACCESS_TIMEOUT_MS',
			config.get<string>('BILLING_CRM_ACCESS_TIMEOUT_MS')
		);
		this.token = parseInternalToken(
			'BILLING_CRM_ACCESS_TOKEN',
			config.get<string>('BILLING_CRM_ACCESS_TOKEN'),
			BILLING_TOKEN_PLACEHOLDERS
		);
	}

	async get(
		workspaceId: string,
		correlationId: string
	): Promise<CrmEntitlementResponse> {
		return this.request(
			`/internal/v1/crm-access/billing/entitlements/${workspaceId}`,
			workspaceId,
			correlationId,
			{ method: 'GET' },
			false
		) as Promise<CrmEntitlementResponse>;
	}

	async activateTrial(
		command: ActivateCrmTrialCommand,
		correlationId: string
	): Promise<CrmTrialActivationResponse> {
		return this.request(
			'/internal/v1/crm-access/billing/entitlements/trial',
			command.workspaceId,
			correlationId,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'idempotency-key': command.commandId
				},
				body: JSON.stringify(command)
			},
			true,
			command
		) as Promise<CrmTrialActivationResponse>;
	}

	private async request(
		path: string,
		workspaceId: string,
		correlationId: string,
		init: RequestInit,
		expectActivation: boolean,
		expectedActivation?: ActivateCrmTrialCommand
	): Promise<CrmEntitlementResponse | CrmTrialActivationResponse> {
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, {
				...init,
				headers: {
					...init.headers,
					'x-winwidget-service': 'crm-access',
					'x-winwidget-internal-token': this.token,
					'x-correlation-id': correlationId,
					accept: 'application/json'
				},
				signal: AbortSignal.timeout(this.timeoutMs)
			});
		} catch {
			throw new ServiceUnavailableException(
				'Billing service is unavailable'
			);
		}
		if (response.status === 409) {
			throw new ConflictException(
				'Command ID conflicts with a previous WinCRM trial activation'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Billing service is unavailable'
			);
		}

		let value: unknown;
		try {
			value = await readBoundedJson(response);
		} catch {
			throw new ServiceUnavailableException(
				'Billing service returned an invalid response'
			);
		}
		if (
			!this.isResponse(
				value,
				workspaceId,
				expectActivation,
				expectedActivation
			)
		) {
			throw new ServiceUnavailableException(
				'Billing service returned an invalid response'
			);
		}
		return value;
	}

	private isResponse(
		value: unknown,
		workspaceId: string,
		expectActivation: boolean,
		expectedActivation?: ActivateCrmTrialCommand
	): value is CrmEntitlementResponse | CrmTrialActivationResponse {
		if (!isRecord(value)) return false;
		const expectedKeys = [
			'schemaVersion',
			'productCode',
			'status',
			'entitlement',
			...(expectActivation ? ['activated'] : [])
		];
		if (
			!hasExactKeys(value, expectedKeys) ||
			value.schemaVersion !== 1 ||
			value.productCode !== 'WINCRM' ||
			!CRM_ENTITLEMENT_STATUSES.includes(
				value.status as CrmEntitlementStatus
			) ||
			(expectActivation && typeof value.activated !== 'boolean')
		) {
			return false;
		}
		if (value.status === 'NOT_ACTIVATED') {
			return (
				value.entitlement === null &&
				(!expectActivation || value.activated === false)
			);
		}
		if (!this.isEntitlement(value.entitlement, workspaceId)) return false;
		return (
			!expectActivation ||
			value.activated === false ||
			(value.activated === true &&
				value.status === 'ACTIVE' &&
				value.entitlement.provisioningCommandId ===
					expectedActivation?.commandId &&
				value.entitlement.provisioningCommandType ===
					'ACTIVATE_WINCRM_TRIAL' &&
				value.entitlement.activatedByUserId ===
					expectedActivation.activatedByUserId)
		);
	}

	private isEntitlement(
		value: unknown,
		workspaceId: string
	): value is CrmEntitlementDetails {
		if (
			!isRecord(value) ||
			!hasExactKeys(value, [
				'activatedByUserId',
				'aggregateVersion',
				'effectiveFrom',
				'effectiveUntil',
				'id',
				'planCode',
				'provisioningCommandId',
				'provisioningCommandType',
				'seatLimit',
				'sourceSequence',
				'trialStartedAt',
				'workspaceId'
			]) ||
			!isUuidV4(value.id) ||
			value.workspaceId !== workspaceId ||
			!isUuidV4(value.workspaceId) ||
			!isUuidV4(value.provisioningCommandId) ||
			typeof value.provisioningCommandType !== 'string' ||
			!PROVISIONING_COMMAND_TYPE_PATTERN.test(
				value.provisioningCommandType
			) ||
			typeof value.activatedByUserId !== 'string' ||
			!SUBJECT_PATTERN.test(value.activatedByUserId) ||
			typeof value.planCode !== 'string' ||
			!value.planCode ||
			value.planCode.length > 64 ||
			!this.isSeatLimit(value.seatLimit) ||
			!this.isTrialStartedAt(value.trialStartedAt, value.planCode) ||
			!this.isIsoDate(value.effectiveFrom) ||
			!this.isIsoDate(value.effectiveUntil) ||
			!this.isPositiveDecimal(value.aggregateVersion) ||
			!this.isPositiveDecimal(value.sourceSequence)
		) {
			return false;
		}
		return (
			(value.trialStartedAt === null ||
				Date.parse(value.trialStartedAt) <=
					Date.parse(value.effectiveUntil)) &&
			Date.parse(value.effectiveFrom) <= Date.parse(value.effectiveUntil)
		);
	}

	private isSeatLimit(value: unknown): boolean {
		return (
			value === null ||
			(typeof value === 'number' &&
				Number.isSafeInteger(value) &&
				value > 0)
		);
	}

	private isIsoDate(value: unknown): value is string {
		return (
			typeof value === 'string' &&
			Number.isFinite(Date.parse(value)) &&
			new Date(value).toISOString() === value
		);
	}

	private isTrialStartedAt(
		value: unknown,
		planCode: string
	): value is string | null {
		if (planCode === 'TRIAL') return this.isIsoDate(value);
		return value === null || this.isIsoDate(value);
	}

	private isPositiveDecimal(value: unknown): value is string {
		return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
	}
}
