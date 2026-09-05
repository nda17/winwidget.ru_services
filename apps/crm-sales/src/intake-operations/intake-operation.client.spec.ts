import {
	ConflictException,
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { IntakeOperationClient } from './intake-operation.client';
import { type IntakeOperationBinding } from './intake-operation.dto';

const binding: IntakeOperationBinding = {
	schemaVersion: 1,
	workspaceId: '11111111-1111-4111-8111-111111111111',
	workflowId: '22222222-2222-4222-8222-222222222222',
	operationId: '33333333-3333-4333-8333-333333333333',
	actorSubject: 'actor',
	payloadHash: 'a'.repeat(64)
};
const access = {
	schemaVersion: 1,
	workspaceId: binding.workspaceId,
	subject: binding.actorSubject,
	role: 'MANAGER',
	state: 'ACTIVE',
	dataScope: 'OWN',
	teamIds: [],
	permissions: ['sales:read', 'sales:write']
};
const proof = {
	...binding,
	state: 'COMMITTED',
	result: {
		contactId: '44444444-4444-4444-8444-444444444444',
		contactName: 'Клиент',
		contactVersion: 1
	},
	committedAt: '2026-09-06T10:00:00.000Z'
};
const envKeys = [
	'CRM_ACCESS_INTERNAL_BASE_URL',
	'CRM_CUSTOMERS_INTERNAL_BASE_URL',
	'CRM_ACCESS_CRM_SALES_TOKEN',
	'CRM_CUSTOMERS_CRM_SALES_TOKEN'
] as const;
const saved = new Map(envKeys.map(key => [key, process.env[key]]));
const response = (value: unknown) =>
	new Response(JSON.stringify(value), {
		headers: { 'content-type': 'application/json' }
	});
describe('Sales workflow scoped HTTP clients', () => {
	let fetchMock: jest.SpyInstance;
	beforeEach(() => {
		process.env.CRM_ACCESS_INTERNAL_BASE_URL =
			'https://access.internal.example.test';
		process.env.CRM_CUSTOMERS_INTERNAL_BASE_URL =
			'https://customers.internal.example.test';
		process.env.CRM_ACCESS_CRM_SALES_TOKEN =
			'sales-access-client-test-token'.repeat(2);
		process.env.CRM_CUSTOMERS_CRM_SALES_TOKEN =
			'sales-customers-client-test-token'.repeat(2);
		fetchMock = jest.spyOn(globalThis, 'fetch');
	});
	afterEach(() => {
		fetchMock.mockRestore();
		for (const key of envKeys) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	it('sends the exact actor/purpose without JWT or redirects', async () => {
		fetchMock.mockResolvedValue(response(access));
		await expect(
			new IntakeOperationClient().authorize(binding)
		).resolves.toEqual(access);
		const options = fetchMock.mock.calls[0][1];
		expect(options).toMatchObject({
			method: 'POST',
			redirect: 'error',
			cache: 'no-store',
			body: JSON.stringify({
				schemaVersion: 1,
				workspaceId: binding.workspaceId,
				subject: binding.actorSubject,
				purpose: 'INTAKE_ACCEPT'
			})
		});
		expect(options.headers).not.toHaveProperty('Authorization');
		expect(options.headers['x-winwidget-service']).toBe('crm-sales');
	});
	it.each([
		{ ...access, subject: 'other' },
		{ ...access, state: 'READ_ONLY' },
		{ ...access, role: 'ANALYST' },
		{ ...access, permissions: ['customers:write'] },
		{ ...access, dataScope: 'ALL' }
	])('rejects mismatched or unwritable authority', async value => {
		fetchMock.mockResolvedValue(response(value));
		await expect(
			new IntakeOperationClient().authorize(binding)
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('verifies the current contact through exact operation proof, never a supplied contact ID', async () => {
		fetchMock.mockResolvedValue(response(proof));
		await expect(
			new IntakeOperationClient().verifyContact(binding)
		).resolves.toEqual({
			contactId: proof.result.contactId,
			contactName: proof.result.contactName
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://customers.internal.example.test/internal/v1/crm-customers/intake-operations/verify'
		);
		expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify(binding));
	});
	it.each([
		{ ...proof, actorSubject: 'other' },
		{ ...proof, workspaceId: proof.operationId },
		{ ...proof, payloadHash: 'b'.repeat(64) },
		{
			...proof,
			result: { ...proof.result, email: 'not-needed@example.test' }
		},
		{ ...proof, result: { ...proof.result, contactVersion: 0 } }
	])('rejects unbound or expanded proof', async value => {
		fetchMock.mockResolvedValue(response(value));
		await expect(
			new IntakeOperationClient().verifyContact(binding)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
	it('rejects an operation that has not committed', async () => {
		fetchMock.mockResolvedValue(
			response({
				...proof,
				state: 'CANCELLED',
				result: null,
				committedAt: null
			})
		);
		await expect(
			new IntakeOperationClient().verifyContact(binding)
		).rejects.toBeInstanceOf(ConflictException);
	});
	it('bounds streamed response size even without Content-Length', async () => {
		fetchMock.mockResolvedValue(response({ huge: 'x'.repeat(65536) }));
		await expect(
			new IntakeOperationClient().verifyContact(binding)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
	it.each([401, 403])(
		'preserves upstream permission denial %s without leaking its body',
		async status => {
			fetchMock.mockResolvedValue(
				new Response('private upstream body', { status })
			);
			await expect(
				new IntakeOperationClient().verifyContact(binding)
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);
	it('rejects insecure non-loopback origins before sending the scoped token', async () => {
		process.env.CRM_CUSTOMERS_INTERNAL_BASE_URL =
			'http://customers.internal.example.test';
		await expect(
			new IntakeOperationClient().verifyContact(binding)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
