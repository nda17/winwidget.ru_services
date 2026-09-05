import { WincrmAccessAuthorizationClient } from './wincrm-access-authorization.client';
import type { BillingRuntimeService } from '../runtime/billing-runtime.service';

describe('WinCRM provider fresh Access authorization', () => {
	const environment = { ...process.env };
	const originalFetch = global.fetch;
	const workspaceId = '11111111-1111-4111-8111-111111111111';
	const commandId = '22222222-2222-4222-8222-222222222222';
	const input = {
		workspaceId,
		ownerSubject: 'owner-ci',
		commandId,
		capacityFence: {
			operationId: commandId,
			requestHash: 'a'.repeat(64),
			fenceRevision: 3,
			targetSeats: 2
		}
	};
	const approved = {
		schemaVersion: 1,
		workspaceId,
		actorSubject: input.ownerSubject,
		commandId,
		requestHash: input.capacityFence.requestHash,
		capacityFence: input.capacityFence,
		authorized: true
	};
	const runtime = { workerEnabled: true } as BillingRuntimeService;
	const jsonResponse = (value: unknown, status = 200) =>
		new Response(JSON.stringify(value), {
			status,
			headers: { 'content-type': 'application/json' }
		});

	beforeEach(() => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		process.env.BILLING_CRM_ACCESS_COMMERCE_BASE_URL =
			'https://crm-access.private.test';
		process.env.BILLING_CRM_ACCESS_COMMERCE_TOKEN =
			'synthetic-test-only-non-production-credential';
	});
	afterEach(() => {
		global.fetch = originalFetch;
		for (const key of [
			'BILLING_WINCRM_PAYMENTS_ENABLED',
			'BILLING_CRM_ACCESS_COMMERCE_BASE_URL',
			'BILLING_CRM_ACCESS_COMMERCE_TOKEN'
		]) {
			if (environment[key] === undefined) delete process.env[key];
			else process.env[key] = environment[key];
		}
	});

	it('requires exact actor/workspace/operation/fence bindings with no redirects or user JWT', async () => {
		const fetchMock = jest.fn().mockResolvedValue(jsonResponse(approved));
		global.fetch = fetchMock;
		await new WincrmAccessAuthorizationClient(runtime).authorize(input);
		expect(fetchMock).toHaveBeenCalledWith(
			'https://crm-access.private.test/internal/v1/crm-access/billing/authorize-operation',
			expect.objectContaining({
				method: 'POST',
				redirect: 'error',
				cache: 'no-store'
			})
		);
		const options = fetchMock.mock.calls[0][1] as RequestInit;
		expect(options.headers).not.toHaveProperty('authorization');
		expect(JSON.parse(options.body as string)).toEqual({
			schemaVersion: 1,
			workspaceId,
			actorSubject: 'owner-ci',
			commandId,
			requestHash: input.capacityFence.requestHash,
			fenceRevision: 3,
			targetSeats: 2
		});
	});

	it.each([
		{ ...approved, actorSubject: 'different-owner' },
		{ ...approved, workspaceId: commandId },
		{ ...approved, authorized: false },
		{ ...approved, extra: true },
		{
			...approved,
			capacityFence: { ...input.capacityFence, fenceRevision: 4 }
		},
		{
			...approved,
			capacityFence: { ...input.capacityFence, targetSeats: 3 }
		},
		{
			...approved,
			capacityFence: { ...input.capacityFence, operationId: workspaceId }
		},
		{
			...approved,
			capacityFence: { ...input.capacityFence, extra: true }
		},
		[approved]
	])('rejects stale or malformed authorization %#', async value => {
		global.fetch = jest.fn().mockResolvedValue(jsonResponse(value));
		await expect(
			new WincrmAccessAuthorizationClient(runtime).authorize(input)
		).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
	});

	it.each([401, 403, 404, 500, 503])(
		'does not revoke customer consent on technical HTTP %s',
		async status => {
			global.fetch = jest
				.fn()
				.mockResolvedValue(
					jsonResponse({ code: 'SERVICE_AUTHORIZATION_FAILED' }, status)
				);
			await expect(
				new WincrmAccessAuthorizationClient(runtime).authorize(input)
			).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
		}
	);

	it('accepts only the closed revocation code with HTTP 403', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(
				jsonResponse({ code: 'OPERATION_AUTHORIZATION_REVOKED' }, 403)
			);
		await expect(
			new WincrmAccessAuthorizationClient(runtime).authorize(input)
		).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});

	it('bounds response bytes and hides dependency error content', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(jsonResponse({ data: 'x'.repeat(17_000) }));
		await expect(
			new WincrmAccessAuthorizationClient(runtime).authorize(input)
		).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
		global.fetch = jest
			.fn()
			.mockRejectedValue(
				new Error('credential-bearing internal failure must not escape')
			);
		await expect(
			new WincrmAccessAuthorizationClient(runtime).authorize(input)
		).rejects.toThrow('WinCRM payment authorization is unavailable');
	});

	it.each([
		'http://private.example.test',
		'https://u:p@private.example.test',
		'https://private.example.test/path',
		'https://private.example.test?token=value',
		'https://private.example.test#fragment'
	])('rejects unsafe origin (%s)', value => {
		process.env.BILLING_CRM_ACCESS_COMMERCE_BASE_URL = value;
		expect(() => new WincrmAccessAuthorizationClient(runtime)).toThrow(
			'must be an exact HTTPS origin'
		);
	});

	it('does not require new credentials when the feature is disabled or this is not a worker', () => {
		delete process.env.BILLING_CRM_ACCESS_COMMERCE_BASE_URL;
		delete process.env.BILLING_CRM_ACCESS_COMMERCE_TOKEN;
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'false';
		expect(
			() => new WincrmAccessAuthorizationClient(runtime)
		).not.toThrow();
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		expect(
			() =>
				new WincrmAccessAuthorizationClient({
					workerEnabled: false
				} as BillingRuntimeService)
		).not.toThrow();
	});
});
