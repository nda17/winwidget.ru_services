import {
	ConflictException,
	ServiceUnavailableException
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { BillingEntitlementClient } from './billing-entitlement.client';

const TOKEN = 'billing-crm-access-test-token-at-least-32-characters';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';

function config(values: Record<string, string>) {
	return {
		get: jest.fn((key: string) => values[key])
	} as unknown as ConfigService;
}

function client(overrides: Record<string, string> = {}) {
	return new BillingEntitlementClient(
		config({
			BILLING_CRM_ACCESS_TOKEN: TOKEN,
			BILLING_INTERNAL_BASE_URL: 'http://127.0.0.1:4800',
			BILLING_CRM_ACCESS_TIMEOUT_MS: '10000',
			...overrides
		})
	);
}

const active = () => ({
	schemaVersion: 1,
	productCode: 'WINCRM',
	status: 'ACTIVE',
	entitlement: {
		id: '44444444-4444-4444-8444-444444444444',
		workspaceId: WORKSPACE_ID,
		provisioningCommandId: COMMAND_ID,
		provisioningCommandType: 'ACTIVATE_WINCRM_TRIAL',
		activatedByUserId: 'user-1',
		planCode: 'TRIAL',
		seatLimit: null,
		policyVersion: null,
		graceUntil: null,
		trialStartedAt: '2026-09-02T10:00:00.000Z',
		effectiveFrom: '2026-09-02T10:00:00.000Z',
		effectiveUntil: '2026-09-07T10:00:00.000Z',
		aggregateVersion: '1',
		sourceSequence: '1'
	}
});

describe('BillingEntitlementClient', () => {
	afterEach(() => jest.restoreAllMocks());

	it('accepts the versioned seat and grace snapshot without local recalculation', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...active(),
					status: 'GRACE',
					entitlement: {
						...active().entitlement,
						policyVersion: 2,
						seatLimit: 5,
						graceUntil: '2026-09-10T10:00:00.000Z'
					}
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().get(WORKSPACE_ID, CORRELATION_ID)
		).resolves.toMatchObject({
			status: 'GRACE',
			entitlement: {
				policyVersion: 2,
				seatLimit: 5,
				graceUntil: '2026-09-10T10:00:00.000Z'
			}
		});
	});

	it.each([
		{
			policyVersion: 0,
			seatLimit: 5,
			graceUntil: '2026-09-10T10:00:00.000Z'
		},
		{
			policyVersion: 1.5,
			seatLimit: 5,
			graceUntil: '2026-09-10T10:00:00.000Z'
		},
		{
			policyVersion: 1,
			seatLimit: 1,
			graceUntil: '2026-09-10T10:00:00.000Z'
		},
		{
			policyVersion: 1,
			seatLimit: null,
			graceUntil: '2026-09-10T10:00:00.000Z'
		},
		{
			policyVersion: null,
			seatLimit: 5,
			graceUntil: '2026-09-10T10:00:00.000Z'
		},
		{ policyVersion: 1, seatLimit: 5, graceUntil: null },
		{
			policyVersion: 1,
			seatLimit: 5,
			graceUntil: '2026-09-07T10:00:00.000Z'
		},
		{ policyVersion: 1, seatLimit: 5, graceUntil: 'invalid' }
	])('rejects an inconsistent commercial snapshot %j', async snapshot => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...active(),
					entitlement: { ...active().entitlement, ...snapshot }
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().get(WORKSPACE_ID, CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('accepts NOT_ACTIVATED only from a successful exact Billing response', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					schemaVersion: 1,
					productCode: 'WINCRM',
					status: 'NOT_ACTIVATED',
					entitlement: null
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().get(WORKSPACE_ID, CORRELATION_ID)
		).resolves.toMatchObject({ status: 'NOT_ACTIVATED' });
	});

	it.each([404, 500])(
		'maps Billing HTTP %s to dependency failure, never NOT_ACTIVATED',
		async status => {
			jest
				.spyOn(global, 'fetch')
				.mockResolvedValue(new Response(null, { status }));
			await expect(
				client().get(WORKSPACE_ID, CORRELATION_ID)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);

	it('preserves a deterministic Billing command conflict', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response(null, { status: 409 }));
		await expect(
			client().activateTrial(
				{
					schemaVersion: 1,
					commandId: COMMAND_ID,
					workspaceId: WORKSPACE_ID,
					activatedByUserId: 'user-1'
				},
				CORRELATION_ID
			)
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('sends the exact idempotent trial command without calculating its duration', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ ...active(), activated: true }), {
				status: 200
			})
		);
		await expect(
			client().activateTrial(
				{
					schemaVersion: 1,
					commandId: COMMAND_ID,
					workspaceId: WORKSPACE_ID,
					activatedByUserId: 'user-1'
				},
				CORRELATION_ID
			)
		).resolves.toMatchObject({ activated: true, status: 'ACTIVE' });
		const request = fetchMock.mock.calls[0][1] as RequestInit;
		expect(request.headers).toEqual(
			expect.objectContaining({
				'idempotency-key': COMMAND_ID,
				'x-winwidget-service': 'crm-access',
				'x-winwidget-internal-token': TOKEN
			})
		);
		expect(JSON.parse(String(request.body))).toEqual({
			schemaVersion: 1,
			commandId: COMMAND_ID,
			workspaceId: WORKSPACE_ID,
			activatedByUserId: 'user-1'
		});
		expect(String(request.body)).not.toContain('trialDays');
	});

	it('rejects a success response for a different workspace', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...active(),
					entitlement: {
						...active().entitlement,
						workspaceId: '55555555-5555-4555-8555-555555555555'
					}
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().get(WORKSPACE_ID, CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('accepts a future paid entitlement without trialStartedAt', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...active(),
					entitlement: {
						...active().entitlement,
						planCode: 'MONTHLY',
						provisioningCommandType: 'ACTIVATE_WINCRM_SUBSCRIPTION',
						trialStartedAt: null
					}
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().get(WORKSPACE_ID, CORRELATION_ID)
		).resolves.toMatchObject({
			entitlement: { planCode: 'MONTHLY', trialStartedAt: null }
		});
	});

	it('rejects a non-authoritative entitlement without provisioning provenance', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...active(),
					entitlement: {
						...active().entitlement,
						provisioningCommandId: undefined
					}
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().get(WORKSPACE_ID, CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it.each([
		{
			field: 'provisioningCommandId',
			value: 'not-a-uuid'
		},
		{
			field: 'provisioningCommandType',
			value: 'activate_wincrm_trial'
		},
		{
			field: 'provisioningCommandType',
			value: `A${'B'.repeat(64)}`
		},
		{
			field: 'activatedByUserId',
			value: 'invalid subject'
		}
	])(
		'rejects invalid Billing provenance field $field',
		async ({ field, value }) => {
			jest.spyOn(global, 'fetch').mockResolvedValue(
				new Response(
					JSON.stringify({
						...active(),
						entitlement: {
							...active().entitlement,
							[field]: value
						}
					}),
					{ status: 200 }
				)
			);
			await expect(
				client().get(WORKSPACE_ID, CORRELATION_ID)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);

	it('requires current TRIAL entitlements to keep an ISO trialStartedAt', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...active(),
					entitlement: {
						...active().entitlement,
						trialStartedAt: null
					}
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().get(WORKSPACE_ID, CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('rejects an activation response that claims activation without an active entitlement', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					schemaVersion: 1,
					productCode: 'WINCRM',
					status: 'NOT_ACTIVATED',
					entitlement: null,
					activated: true
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().activateTrial(
				{
					schemaVersion: 1,
					commandId: COMMAND_ID,
					workspaceId: WORKSPACE_ID,
					activatedByUserId: 'user-1'
				},
				CORRELATION_ID
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('rejects a newly activated entitlement tied to a different command', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...active(),
					entitlement: {
						...active().entitlement,
						provisioningCommandId: '55555555-5555-4555-8555-555555555555'
					},
					activated: true
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().activateTrial(
				{
					schemaVersion: 1,
					commandId: COMMAND_ID,
					workspaceId: WORKSPACE_ID,
					activatedByUserId: 'user-1'
				},
				CORRELATION_ID
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it.each([
		{
			provisioningCommandType: 'ACTIVATE_WINCRM_SUBSCRIPTION'
		},
		{ activatedByUserId: 'other-user' }
	])(
		'rejects newly activated Trial provenance that differs from the request',
		async provenance => {
			jest.spyOn(global, 'fetch').mockResolvedValue(
				new Response(
					JSON.stringify({
						...active(),
						entitlement: {
							...active().entitlement,
							...provenance
						},
						activated: true
					}),
					{ status: 200 }
				)
			);
			await expect(
				client().activateTrial(
					{
						schemaVersion: 1,
						commandId: COMMAND_ID,
						workspaceId: WORKSPACE_ID,
						activatedByUserId: 'user-1'
					},
					CORRELATION_ID
				)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);

	it('accepts an existing entitlement provenance on an activated false replay', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...active(),
					entitlement: {
						...active().entitlement,
						provisioningCommandId: '55555555-5555-4555-8555-555555555555',
						activatedByUserId: 'original-owner'
					},
					activated: false
				}),
				{ status: 200 }
			)
		);
		await expect(
			client().activateTrial(
				{
					schemaVersion: 1,
					commandId: COMMAND_ID,
					workspaceId: WORKSPACE_ID,
					activatedByUserId: 'user-1'
				},
				CORRELATION_ID
			)
		).resolves.toMatchObject({
			activated: false,
			entitlement: {
				provisioningCommandId: '55555555-5555-4555-8555-555555555555',
				activatedByUserId: 'original-owner'
			}
		});
	});
});
