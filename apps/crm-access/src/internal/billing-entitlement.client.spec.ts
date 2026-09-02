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
		planCode: 'TRIAL',
		seatLimit: null,
		trialStartedAt: '2026-09-02T10:00:00.000Z',
		effectiveFrom: '2026-09-02T10:00:00.000Z',
		effectiveUntil: '2026-09-07T10:00:00.000Z',
		aggregateVersion: '1',
		sourceSequence: '1'
	}
});

describe('BillingEntitlementClient', () => {
	afterEach(() => jest.restoreAllMocks());

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
});
