import { ConfigService } from '@nestjs/config';
import {
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { BillingCommerceClient } from './billing-commerce.client';

const workspaceId = randomUUID(),
	commandId = randomUUID(),
	requestHash = 'a'.repeat(64);
const token = randomBytes(48).toString('base64url');
const input = {
	schemaVersion: 1,
	workspaceId,
	actorSubject: 'owner',
	commandId,
	requestHash
};
const proof = {
	schemaVersion: 1,
	workspaceId,
	commandId,
	requestHash,
	status: 'PENDING',
	billingVersion: '1',
	releaseFence: false,
	holdUntil: null,
	order: null,
	period: null
};
const configuration = (patch: Record<string, string | undefined> = {}) =>
	new ConfigService({
		CRM_ACCESS_BILLING_ENABLED: 'true',
		BILLING_INTERNAL_BASE_URL: 'https://billing.internal.test',
		BILLING_CRM_ACCESS_TOKEN: token,
		...patch
	});
describe('CRM Access scoped Billing HTTP client', () => {
	const originalFetch = global.fetch;
	let fetchMock: jest.Mock;
	beforeEach(() => {
		fetchMock = jest.fn();
		global.fetch = fetchMock;
	});
	afterEach(() => {
		global.fetch = originalFetch;
	});
	const response = (value: unknown, status = 200) =>
		new Response(JSON.stringify(value), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	it('uses exact origin, one-way scoped credentials, no JWT, redirect:error and exact command header', async () => {
		fetchMock.mockResolvedValue(response(proof));
		const client = new BillingCommerceClient(configuration());
		expect(
			await client.request('operations/close', input, 'proof', true)
		).toEqual(proof);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe(
			'https://billing.internal.test/internal/v1/crm-access/billing/commerce/operations/close'
		);
		expect(options).toMatchObject({
			method: 'POST',
			redirect: 'error',
			cache: 'no-store'
		});
		expect(options.headers).toMatchObject({
			'x-winwidget-service': 'crm-access',
			'x-winwidget-internal-token': token,
			'idempotency-key': commandId
		});
		expect(options.headers.authorization).toBeUndefined();
		expect(JSON.parse(options.body)).toEqual(input);
	});
	it('disabled mode requires no new credentials and performs no request', async () => {
		const client = new BillingCommerceClient(
			configuration({
				CRM_ACCESS_BILLING_ENABLED: 'false',
				BILLING_CRM_ACCESS_TOKEN: undefined,
				BILLING_INTERNAL_BASE_URL: undefined
			})
		);
		await expect(
			client.request('summary', { workspaceId }, 'summary')
		).rejects.toBeInstanceOf(NotFoundException);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it.each([
		'http://10.0.0.1:4800',
		'https://user:pass@billing.internal.test',
		'https://billing.internal.test/path',
		'https://billing.internal.test/?target=other'
	])('rejects unsafe origin %s', origin => {
		expect(
			() =>
				new BillingCommerceClient(
					configuration({ BILLING_INTERNAL_BASE_URL: origin })
				)
		).toThrow();
	});
	it.each([401, 403, 500, 503, 302])(
		'treats dependency status %s as retryable unavailability, never owner revocation',
		async status => {
			fetchMock.mockResolvedValue(
				response({ message: 'secret-upstream-marker' }, status)
			);
			await expect(
				new BillingCommerceClient(configuration()).request(
					'operations/get',
					input,
					'proof'
				)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);
	it('only exposes status 404 as absence, never a cancellation proof', async () => {
		fetchMock.mockResolvedValue(response({}, 404));
		await expect(
			new BillingCommerceClient(configuration()).request(
				'operations/get',
				input,
				'proof'
			)
		).rejects.toBeInstanceOf(NotFoundException);
	});
	it.each([
		{ ...proof, workspaceId: randomUUID() },
		{ ...proof, requestHash: 'b'.repeat(64) },
		{ ...proof, providerSecret: 'forbidden' },
		'x'.repeat(513 * 1024)
	])(
		'fails closed for oversized, extra-field, or foreign proof',
		async value => {
			fetchMock.mockResolvedValue(response(value));
			await expect(
				new BillingCommerceClient(configuration()).request(
					'operations/get',
					input,
					'proof'
				)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);
	it('requires JSON content type and never trusts a redirected response', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(proof), {
				headers: { 'content-type': 'text/html' }
			})
		);
		const redirected = response(proof);
		Object.defineProperty(redirected, 'redirected', { value: true });
		fetchMock.mockResolvedValueOnce(redirected);
		const client = new BillingCommerceClient(configuration());
		await expect(
			client.request('operations/get', input, 'proof')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		await expect(
			client.request('operations/get', input, 'proof')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
