import { Injectable } from '@nestjs/common';
import type {
	WincrmCapacityFence,
	WincrmProviderFailureCode
} from '../domain/wincrm-commerce.contract';
import { BillingRuntimeService } from '../runtime/billing-runtime.service';
import { wincrmPaymentsEnabled } from './wincrm-provider.config';

export class WincrmProviderAuthorizationError extends Error {
	constructor(readonly code: WincrmProviderFailureCode) {
		super(
			code === 'AUTHORIZATION_REVOKED'
				? 'WinCRM payment authorization was revoked'
				: 'WinCRM payment authorization is unavailable'
		);
	}
}

export interface WincrmProviderAuthorizationInput {
	workspaceId: string;
	ownerSubject: string;
	commandId: string;
	capacityFence: WincrmCapacityFence;
}

function exactRecord(
	value: unknown,
	keys: string[]
): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return false;
	const present = Object.keys(value);
	return (
		present.length === keys.length &&
		keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
	);
}

@Injectable()
export class WincrmAccessAuthorizationClient {
	private readonly origin: string;
	private readonly token: string;

	constructor(runtime: BillingRuntimeService) {
		this.origin = '';
		this.token = '';
		if (!wincrmPaymentsEnabled() || !runtime.workerEnabled) return;
		const raw =
			process.env.BILLING_CRM_ACCESS_COMMERCE_BASE_URL?.trim() || '';
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			throw new Error(
				'BILLING_CRM_ACCESS_COMMERCE_BASE_URL must be configured'
			);
		}
		if (
			parsed.username ||
			parsed.password ||
			parsed.pathname !== '/' ||
			parsed.search ||
			parsed.hash ||
			!(
				parsed.protocol === 'https:' ||
				(parsed.protocol === 'http:' &&
					['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
			)
		) {
			throw new Error(
				'BILLING_CRM_ACCESS_COMMERCE_BASE_URL must be an exact HTTPS origin, except loopback HTTP'
			);
		}
		this.origin = parsed.origin;
		this.token =
			process.env.BILLING_CRM_ACCESS_COMMERCE_TOKEN?.trim() || '';
		if (
			this.token.length < 32 ||
			this.token.length > 512 ||
			/\s|change[_-]?me|placeholder|example/i.test(this.token)
		) {
			throw new Error(
				'BILLING_CRM_ACCESS_COMMERCE_TOKEN must be a non-placeholder secret'
			);
		}
	}

	async authorize(input: WincrmProviderAuthorizationInput): Promise<void> {
		if (!this.origin || !this.token)
			throw new WincrmProviderAuthorizationError('DEPENDENCY_UNAVAILABLE');
		const body = {
			schemaVersion: 1,
			workspaceId: input.workspaceId,
			actorSubject: input.ownerSubject,
			commandId: input.commandId,
			requestHash: input.capacityFence.requestHash,
			fenceRevision: input.capacityFence.fenceRevision,
			targetSeats: input.capacityFence.targetSeats
		};
		let response: Response;
		let value: unknown;
		try {
			response = await fetch(
				`${this.origin}/internal/v1/crm-access/billing/authorize-operation`,
				{
					method: 'POST',
					headers: {
						'x-winwidget-service': 'billing',
						'x-winwidget-internal-token': this.token,
						'content-type': 'application/json',
						accept: 'application/json'
					},
					body: JSON.stringify(body),
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(8_000)
				}
			);
			value = await this.readBoundedJson(response);
		} catch {
			throw new WincrmProviderAuthorizationError('DEPENDENCY_UNAVAILABLE');
		}
		if (!response.ok) {
			const revoked =
				response.status === 403 &&
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				(value as Record<string, unknown>).code ===
					'OPERATION_AUTHORIZATION_REVOKED';
			throw new WincrmProviderAuthorizationError(
				revoked ? 'AUTHORIZATION_REVOKED' : 'DEPENDENCY_UNAVAILABLE'
			);
		}
		if (
			!exactRecord(value, [
				'schemaVersion',
				'workspaceId',
				'actorSubject',
				'commandId',
				'requestHash',
				'capacityFence',
				'authorized'
			]) ||
			value.schemaVersion !== 1 ||
			value.workspaceId !== input.workspaceId ||
			value.actorSubject !== input.ownerSubject ||
			value.commandId !== input.commandId ||
			value.requestHash !== input.capacityFence.requestHash ||
			value.authorized !== true ||
			!exactRecord(value.capacityFence, [
				'operationId',
				'requestHash',
				'fenceRevision',
				'targetSeats'
			]) ||
			value.capacityFence.operationId !== input.commandId ||
			input.capacityFence.operationId !== input.commandId ||
			value.capacityFence.requestHash !==
				input.capacityFence.requestHash ||
			value.capacityFence.fenceRevision !==
				input.capacityFence.fenceRevision ||
			value.capacityFence.targetSeats !== input.capacityFence.targetSeats
		) {
			throw new WincrmProviderAuthorizationError('DEPENDENCY_UNAVAILABLE');
		}
	}

	private async readBoundedJson(response: Response): Promise<unknown> {
		if (
			!response.headers
				.get('content-type')
				?.toLowerCase()
				.includes('application/json') ||
			!response.body
		)
			throw new Error('INVALID_RESPONSE');
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				bytes += next.value.length;
				if (bytes > 16_384) throw new Error('INVALID_RESPONSE');
				chunks.push(next.value);
			}
			return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}
}
