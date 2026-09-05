import { randomUUID } from 'node:crypto';
import {
	AcceptanceOperationsClient,
	parseOperationProof
} from './acceptance-operations.client';

const binding = {
	schemaVersion: 1 as const,
	workspaceId: randomUUID(),
	workflowId: randomUUID(),
	operationId: randomUUID(),
	actorSubject: 'actor',
	payloadHash: 'a'.repeat(64)
};
const proof = {
	...binding,
	state: 'COMMITTED',
	result: {
		contactId: randomUUID(),
		contactName: 'Анна',
		contactVersion: 1
	},
	committedAt: new Date().toISOString()
};
describe('exact scoped operation proof transport', () => {
	const env = process.env;
	const originalFetch = global.fetch;
	beforeEach(() => {
		process.env = {
			...env,
			CRM_CUSTOMERS_INTERNAL_BASE_URL: 'http://127.0.0.1:5320',
			CRM_CUSTOMERS_CRM_INTAKE_TOKEN: 't'.repeat(40)
		};
	});
	afterEach(() => {
		process.env = env;
		global.fetch = originalFetch;
	});
	it('allows only exact proof fields and rejects changed binding or unproven results', () => {
		expect(parseOperationProof(proof, binding, 'customers')).toEqual(
			proof
		);
		for (const invalid of [
			{ ...proof, phone: 'private' },
			{ ...proof, actorSubject: 'other' },
			{ ...proof, operationId: randomUUID() },
			{ ...proof, state: 'ABSENT' },
			{ ...proof, result: { ...proof.result, phone: 'private' } },
			{ ...proof, result: { ...proof.result, contactVersion: 0 } },
			{ ...proof, committedAt: '2026-09-05' }
		])
			expect(() =>
				parseOperationProof(invalid, binding, 'customers')
			).toThrow();
	});
	it('uses a scoped credential, no user JWT, no redirects and bounded response', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(new Response(JSON.stringify(proof)));
		await expect(
			new AcceptanceOperationsClient().request(
				'customers',
				'read',
				binding
			)
		).resolves.toEqual(proof);
		expect(global.fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:5320/internal/v1/crm-customers/intake-operations/read',
			expect.objectContaining({
				redirect: 'error',
				cache: 'no-store',
				headers: expect.objectContaining({
					'x-winwidget-service': 'crm-intake'
				})
			})
		);
		const options = (global.fetch as jest.Mock).mock.calls[0][1];
		expect(options.headers.authorization).toBeUndefined();
		global.fetch = jest
			.fn()
			.mockResolvedValue(new Response('x'.repeat(65537)));
		await expect(
			new AcceptanceOperationsClient().request(
				'customers',
				'read',
				binding
			)
		).rejects.toMatchObject({ status: 503 });
	});
	it.each([
		[401, 503],
		[403, 403],
		[404, 404],
		[409, 409],
		[500, 503]
	])('fails closed for %s as %s', async (status, expected) => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(new Response('private details', { status }));
		await expect(
			new AcceptanceOperationsClient().request(
				'customers',
				'read',
				binding
			)
		).rejects.toMatchObject({ status: expected });
	});
	it('does not use remote HTTP or placeholder credentials', async () => {
		global.fetch = jest.fn();
		process.env.CRM_CUSTOMERS_INTERNAL_BASE_URL =
			'http://customers.example.com';
		await expect(
			new AcceptanceOperationsClient().request(
				'customers',
				'read',
				binding
			)
		).rejects.toMatchObject({ status: 503 });
		expect(global.fetch).not.toHaveBeenCalled();
	});
});
