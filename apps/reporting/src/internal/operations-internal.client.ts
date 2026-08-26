import { createReportingCorrelationId } from '../common/reporting-context';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_OPERATIONS_BASE_URL = 'http://127.0.0.1:5200';
const DEFAULT_TIMEOUT_MS = 10_000;
const PLACEHOLDER_INTERNAL_TOKENS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'reporting_internal_token',
	'ci_reporting_internal_token_at_least_32_chars',
	'change_me_to_a_unique_secret_with_at_least_32_chars'
]);

export interface OperationsDailySummaryPolicyReservation {
	accepted: true;
	changeId: string;
	reservationGeneration: string;
	confirmationRequired: boolean;
}

export interface OperationsDailySummaryPolicyConfirmation {
	confirmed: true;
	changeId: string;
	reservationGeneration: string;
}

@Injectable()
export class OperationsInternalClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(config: ConfigService, runtime: ReportingRuntimeService) {
		this.baseUrl = this.parseBaseUrl(
			config.get<string>('OPERATIONS_INTERNAL_BASE_URL')
		);
		this.token =
			config.get<string>('REPORTING_INTERNAL_TOKEN')?.trim() || '';
		if (
			runtime.apiEnabled &&
			(this.token.length < 32 ||
				PLACEHOLDER_INTERNAL_TOKENS.has(this.token))
		) {
			throw new Error(
				'REPORTING_INTERNAL_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const timeout = Number(
			config.get<string>('REPORTING_INTERNAL_TIMEOUT_MS') ||
				DEFAULT_TIMEOUT_MS
		);
		if (!Number.isInteger(timeout) || timeout < 500 || timeout > 60_000) {
			throw new Error(
				'REPORTING_INTERNAL_TIMEOUT_MS must be an integer between 500 and 60000'
			);
		}
		this.timeoutMs = timeout;
	}

	async reserveDailySummarySchedulePolicy(
		changeId: string,
		scheduleTime: string,
		expectedScheduleGeneration: string,
		actorId: string,
		correlationId = createReportingCorrelationId()
	): Promise<OperationsDailySummaryPolicyReservation> {
		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/internal/v1/operations/reporting/schedule-policy`,
				{
					method: 'PUT',
					headers: {
						'x-winwidget-internal-token': this.token,
						'x-correlation-id': correlationId,
						accept: 'application/json',
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						changeId,
						scheduleTime,
						expectedScheduleGeneration,
						actorId
					}),
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Backup schedule policy is unavailable'
			);
		}
		if (response.status === 400) {
			throw new BadRequestException(
				'Daily Summary schedule conflicts with the backup schedule'
			);
		}
		if (response.status === 409) {
			throw new ConflictException(
				'Daily Summary schedule changed or is not owned by Reporting; reload settings'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Backup schedule policy is unavailable'
			);
		}
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Backup schedule policy returned an invalid response'
			);
		}
		if (!this.isDailySummaryPolicyReservation(value)) {
			throw new ServiceUnavailableException(
				'Backup schedule policy returned an invalid response'
			);
		}
		return value;
	}

	async confirmDailySummarySchedulePolicy(
		changeId: string,
		scheduleGeneration: string,
		correlationId = createReportingCorrelationId()
	): Promise<OperationsDailySummaryPolicyConfirmation> {
		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/internal/v1/operations/reporting/schedule-policy/confirm`,
				{
					method: 'POST',
					headers: {
						'x-winwidget-internal-token': this.token,
						'x-correlation-id': correlationId,
						accept: 'application/json',
						'content-type': 'application/json'
					},
					body: JSON.stringify({ changeId, scheduleGeneration }),
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Backup schedule policy confirmation is unavailable'
			);
		}
		if (response.status === 400) {
			throw new BadRequestException(
				'Backup schedule policy confirmation is invalid'
			);
		}
		if (response.status === 409) {
			throw new ConflictException(
				'Backup schedule policy confirmation conflicts with Operations state'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Backup schedule policy confirmation is unavailable'
			);
		}
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Backup schedule policy confirmation returned an invalid response'
			);
		}
		if (!this.isDailySummaryPolicyConfirmation(value)) {
			throw new ServiceUnavailableException(
				'Backup schedule policy confirmation returned an invalid response'
			);
		}
		return value;
	}

	private parseBaseUrl(value: string | undefined): string {
		const configured = value?.trim() || DEFAULT_OPERATIONS_BASE_URL;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new Error('OPERATIONS_INTERNAL_BASE_URL must be a valid URL');
		}
		if (url.protocol !== 'http:') {
			throw new Error(
				'OPERATIONS_INTERNAL_BASE_URL must use http on the private network'
			);
		}
		if (url.username || url.password || url.search || url.hash) {
			throw new Error(
				'OPERATIONS_INTERNAL_BASE_URL must not contain credentials, query, or fragment'
			);
		}
		if (
			!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
				url.hostname.toLowerCase()
			)
		) {
			throw new Error(
				'OPERATIONS_INTERNAL_BASE_URL must use a loopback host'
			);
		}
		if (url.pathname !== '/') {
			throw new Error(
				'OPERATIONS_INTERNAL_BASE_URL must be an origin without a path'
			);
		}
		return url.toString().replace(/\/$/, '');
	}

	private isDailySummaryPolicyReservation(
		value: unknown
	): value is OperationsDailySummaryPolicyReservation {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const record = value as Record<string, unknown>;
		const actualKeys = Object.keys(record).sort();
		const expectedKeys = [
			'accepted',
			'changeId',
			'confirmationRequired',
			'reservationGeneration'
		];
		return (
			actualKeys.length === expectedKeys.length &&
			actualKeys.every((key, index) => key === expectedKeys[index]) &&
			record.accepted === true &&
			typeof record.changeId === 'string' &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				record.changeId
			) &&
			typeof record.confirmationRequired === 'boolean' &&
			typeof record.reservationGeneration === 'string' &&
			/^(?:0|[1-9]\d*)$/.test(record.reservationGeneration)
		);
	}

	private isDailySummaryPolicyConfirmation(
		value: unknown
	): value is OperationsDailySummaryPolicyConfirmation {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const record = value as Record<string, unknown>;
		const actualKeys = Object.keys(record).sort();
		const expectedKeys = [
			'changeId',
			'confirmed',
			'reservationGeneration'
		];
		return (
			actualKeys.length === expectedKeys.length &&
			actualKeys.every((key, index) => key === expectedKeys[index]) &&
			record.confirmed === true &&
			typeof record.changeId === 'string' &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				record.changeId
			) &&
			typeof record.reservationGeneration === 'string' &&
			/^(?:0|[1-9]\d*)$/.test(record.reservationGeneration)
		);
	}
}
