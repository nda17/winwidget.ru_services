import type { ConsumeMessage } from 'amqplib';
import {
	WincrmProviderWorkerService,
	parseWincrmProviderMessage
} from './wincrm-provider-worker.service';
import { WINCRM_PROVIDER_EVENT } from './wincrm-provider.config';
import { WincrmProviderAuthorizationError } from './wincrm-access-authorization.client';
import { ProviderRequestError } from './yookassa.service';
import { PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS } from '../domain/billing-legal.constants';
import { WincrmProviderResponseError } from '../domain/wincrm-commerce.contract';

jest.mock('../domain/wincrm-commerce.service', () => ({
	WincrmCommerceService: class {}
}));

const eventId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '33333333-3333-4333-8333-333333333333';
const orderId = '44444444-4444-4444-8444-444444444444';
const commandId = '55555555-5555-4555-8555-555555555555';
const event = {
	schemaVersion: 1,
	eventType: WINCRM_PROVIDER_EVENT,
	eventId,
	operationId
};
const claim = {
	operationId,
	eventId,
	leaseToken: '66666666-6666-4666-8666-666666666666',
	version: 2
};
const message = (payload: unknown = event) =>
	({
		content: Buffer.from(JSON.stringify(payload)),
		properties: {
			contentType: 'application/json',
			messageId: eventId,
			type: WINCRM_PROVIDER_EVENT
		},
		fields: {
			exchange: 'winwidget.events',
			routingKey: WINCRM_PROVIDER_EVENT
		}
	}) as ConsumeMessage;

describe('WinCRM provider push worker dispatch fences', () => {
	function setup() {
		const actions: string[] = [];
		const prepared = {
			action: 'CREATE',
			orderId,
			workspaceId,
			ownerSubject: 'owner-ci',
			commandId,
			capacityFence: {
				operationId: commandId,
				requestHash: 'a'.repeat(64),
				fenceRevision: 2,
				targetSeats: 2
			},
			providerPaymentId: null,
			idempotencyKey: 'b'.repeat(64),
			firstDispatchAt: new Date().toISOString(),
			request: {
				productCode: 'WINCRM',
				paymentId: orderId,
				plan: 'WINCRM',
				billingPeriod: 'MONTHLY',
				kind: 'ONE_TIME',
				amount: '990.00',
				currency: 'RUB',
				autoRenew: false,
				customerEmail: 'synthetic@example.test',
				customerPhone: null,
				returnUrl: 'https://crm.winwidget.ru/billing/return',
				paymentMethodCiphertext: null
			}
		};
		const commerce = {
			claimProviderOperation: jest
				.fn()
				.mockResolvedValue({ state: 'CLAIMED', claim }),
			prepareProviderOperation: jest.fn().mockImplementation(async () => {
				actions.push('prepare');
				return prepared;
			}),
			beginProviderDispatch: jest.fn().mockImplementation(async () => {
				actions.push('dispatch');
				return prepared;
			}),
			settleProviderOperation: jest.fn().mockImplementation(async () => {
				actions.push('commit');
			}),
			failProviderOperation: jest.fn().mockImplementation(async () => {
				actions.push('failure-commit');
			})
		};
		const provider = {
			createPayment: jest.fn().mockImplementation(async () => {
				actions.push('POST');
				return { id: 'provider-payment-ci', status: 'pending' };
			}),
			getPayment: jest.fn().mockResolvedValue({
				id: 'provider-payment-ci',
				status: 'succeeded'
			}),
			getReceipts: jest.fn().mockResolvedValue({ items: [] })
		};
		const authorization = {
			authorize: jest.fn().mockImplementation(async () => {
				actions.push('authorize');
			})
		};
		const crypto = {
			decrypt: jest.fn().mockReturnValue('synthetic-saved-method')
		};
		const rabbit = {
			ack: jest.fn().mockImplementation(() => {
				actions.push('ack');
			}),
			requeue: jest.fn().mockResolvedValue(undefined),
			isReady: jest.fn().mockReturnValue(true)
		};
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			integrationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({})
			},
			integrationDeliveryFailure: {
				create: jest.fn().mockResolvedValue({})
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			$transaction: jest.fn().mockImplementation(async callback => {
				await callback(transaction);
				actions.push('quarantine-commit');
			})
		};
		const worker = new WincrmProviderWorkerService(
			{ workerEnabled: true } as never,
			rabbit as never,
			commerce as never,
			provider as never,
			crypto as never,
			authorization as never,
			prisma as never
		);
		return {
			worker,
			commerce,
			provider,
			authorization,
			crypto,
			rabbit,
			prepared,
			actions,
			transaction,
			prisma
		};
	}

	it('accepts only the exact ID-only envelope', () => {
		expect(parseWincrmProviderMessage(message())).toEqual(event);
	});
	it.each([
		{ ...event, amount: '990.00' },
		{ ...event, schemaVersion: '1' },
		{ ...event, operationId: 'not-an-id' },
		{
			...event,
			eventId: eventId.toUpperCase().replace('11111111', 'AAAAAAAA')
		},
		[],
		null
	])('rejects malformed or enriched events %#', value => {
		expect(() => parseWincrmProviderMessage(message(value))).toThrow();
	});
	it('rejects mismatched broker metadata and oversized content', () => {
		for (const bad of [
			{
				...message(),
				properties: { ...message().properties, messageId: operationId }
			},
			{
				...message(),
				properties: { ...message().properties, type: 'other' }
			},
			{
				...message(),
				properties: { ...message().properties, contentType: 'text/plain' }
			},
			{ ...message(), fields: { ...message().fields, exchange: 'other' } },
			{ ...message(), content: Buffer.alloc(1025) }
		])
			expect(() =>
				parseWincrmProviderMessage(bad as ConsumeMessage)
			).toThrow();
	});

	it('performs fresh Access authorization then final PG fence, and ACKs only after settle', async () => {
		const test = setup();
		await test.worker.handle(message());
		expect(test.actions).toEqual([
			'prepare',
			'authorize',
			'dispatch',
			'POST',
			'commit',
			'ack'
		]);
		expect(test.provider.createPayment).toHaveBeenCalledWith(
			expect.objectContaining({
				productCode: 'WINCRM',
				paymentId: orderId
			}),
			'b'.repeat(64)
		);
		expect(
			test.provider.createPayment.mock.calls[0][0]
		).not.toHaveProperty('paymentMethodCiphertext');
	});
	it('does not dispatch or ACK a concurrent active receipt', async () => {
		const test = setup();
		test.commerce.claimProviderOperation.mockResolvedValue({
			state: 'BUSY'
		});
		await test.worker.handle(message());
		expect(test.rabbit.requeue).toHaveBeenCalledTimes(1);
		expect(test.rabbit.ack).not.toHaveBeenCalled();
		expect(test.provider.createPayment).not.toHaveBeenCalled();
	});
	it('ACKs a completed duplicate without any external call', async () => {
		const test = setup();
		test.commerce.claimProviderOperation.mockResolvedValue({
			state: 'DONE'
		});
		await test.worker.handle(message());
		expect(test.rabbit.ack).toHaveBeenCalledTimes(1);
		expect(test.provider.createPayment).not.toHaveBeenCalled();
		expect(test.commerce.prepareProviderOperation).not.toHaveBeenCalled();
	});
	it('honors cancellation that wins the final dispatch fence', async () => {
		const test = setup();
		test.commerce.beginProviderDispatch.mockResolvedValue({
			action: 'SKIP'
		});
		await test.worker.handle(message());
		expect(test.provider.createPayment).not.toHaveBeenCalled();
		expect(test.rabbit.ack).toHaveBeenCalledTimes(1);
	});
	it('does not dispatch after fresh owner authorization is revoked', async () => {
		const test = setup();
		test.authorization.authorize.mockRejectedValue(
			new WincrmProviderAuthorizationError('AUTHORIZATION_REVOKED')
		);
		await test.worker.handle(message());
		expect(test.provider.createPayment).not.toHaveBeenCalled();
		expect(test.commerce.failProviderOperation).toHaveBeenCalledWith(
			claim,
			{ code: 'AUTHORIZATION_REVOKED', ambiguous: false, retryable: false }
		);
		expect(test.actions.at(-2)).toBe('failure-commit');
		expect(test.actions.at(-1)).toBe('ack');
	});
	it.each(['VERIFY', 'SYNC_RECEIPT'])(
		'reconciles %s after owner revocation without another charge',
		async action => {
			const test = setup();
			test.commerce.prepareProviderOperation.mockResolvedValue({
				...test.prepared,
				action,
				providerPaymentId: 'provider-payment-ci'
			});
			await test.worker.handle(message());
			expect(test.authorization.authorize).not.toHaveBeenCalled();
			expect(test.commerce.beginProviderDispatch).not.toHaveBeenCalled();
			expect(test.provider.createPayment).not.toHaveBeenCalled();
			expect(
				action === 'VERIFY'
					? test.provider.getPayment
					: test.provider.getReceipts
			).toHaveBeenCalledWith('provider-payment-ci', 'WINCRM');
			expect(test.commerce.settleProviderOperation).toHaveBeenCalledTimes(
				1
			);
		}
	);
	it('keeps the expected provider ID when VERIFY returns a mismatched object', async () => {
		const test = setup();
		test.commerce.prepareProviderOperation.mockResolvedValue({
			...test.prepared,
			action: 'VERIFY',
			providerPaymentId: 'provider-payment-ci'
		});
		test.provider.getPayment.mockResolvedValue({
			id: 'foreign-payment',
			status: 'succeeded'
		});
		test.commerce.settleProviderOperation.mockRejectedValue(
			new WincrmProviderResponseError('PROVIDER_BINDING_MISMATCH')
		);
		await test.worker.handle(message());
		expect(test.commerce.failProviderOperation).toHaveBeenCalledWith(
			claim,
			{
				code: 'PROVIDER_BINDING_MISMATCH',
				ambiguous: false,
				retryable: false,
				providerPaymentId: 'provider-payment-ci'
			}
		);
		expect(test.provider.createPayment).not.toHaveBeenCalled();
		expect(test.actions.at(-1)).toBe('ack');
	});
	it('retains the observed CREATE ID for investigation without retrying an invalid response', async () => {
		const test = setup();
		test.commerce.settleProviderOperation.mockRejectedValue(
			new WincrmProviderResponseError('PROVIDER_INVALID_RESPONSE')
		);
		await test.worker.handle(message());
		expect(test.commerce.failProviderOperation).toHaveBeenCalledWith(
			claim,
			{
				code: 'PROVIDER_INVALID_RESPONSE',
				ambiguous: true,
				retryable: false,
				providerPaymentId: 'provider-payment-ci'
			}
		);
	});
	it('quarantines poison transactionally without copying its raw payload', async () => {
		const test = setup();
		await test.worker.handle(
			message({ secret: 'sensitive-synthetic-content' })
		);
		expect(
			test.transaction.integrationDeliveryFailure.create
		).toHaveBeenCalledTimes(1);
		expect(
			test.transaction.integrationDeliveryReceipt.create
		).toHaveBeenCalledTimes(1);
		expect(test.transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
		expect(
			JSON.stringify(test.transaction.outboxEvent.create.mock.calls)
		).not.toContain('sensitive-synthetic-content');
		expect(test.actions).toEqual(['quarantine-commit', 'ack']);
		expect(test.commerce.claimProviderOperation).not.toHaveBeenCalled();
	});
	it('does not ACK poison when its quarantine transaction fails', async () => {
		const test = setup();
		test.transaction.outboxEvent.create.mockRejectedValue(
			new Error('DB unavailable')
		);
		await expect(test.worker.handle(message(null))).rejects.toThrow(
			'DB unavailable'
		);
		expect(test.rabbit.ack).not.toHaveBeenCalled();
	});
	it('ACKs a durably quarantined duplicate without another DLQ event', async () => {
		const test = setup();
		test.transaction.integrationDeliveryReceipt.findUnique.mockResolvedValue(
			{ status: 'DEAD_LETTERED' }
		);
		await test.worker.handle(message(null));
		expect(test.transaction.outboxEvent.create).not.toHaveBeenCalled();
		expect(test.rabbit.ack).toHaveBeenCalledTimes(1);
	});
	it('keeps the returned provider ID when a success response cannot commit locally', async () => {
		const test = setup();
		test.commerce.settleProviderOperation.mockRejectedValue(
			new Error('database connection lost')
		);
		await test.worker.handle(message());
		expect(test.commerce.failProviderOperation).toHaveBeenCalledWith(
			claim,
			{
				code: 'TRANSPORT_UNKNOWN',
				ambiguous: true,
				retryable: true,
				providerPaymentId: 'provider-payment-ci'
			}
		);
	});
	it('persists unknown transport outcome before ACK without replacing the idempotency key', async () => {
		const test = setup();
		test.provider.createPayment.mockRejectedValue(
			new ProviderRequestError(
				'synthetic timeout',
				'PROVIDER_TRANSPORT_UNKNOWN',
				true,
				true
			)
		);
		await test.worker.handle(message());
		expect(test.commerce.failProviderOperation).toHaveBeenCalledWith(
			claim,
			{ code: 'TRANSPORT_UNKNOWN', ambiguous: true, retryable: true }
		);
		expect(test.provider.createPayment).toHaveBeenCalledTimes(1);
	});
	it('does not ACK when failure persistence itself is unavailable', async () => {
		const test = setup();
		test.authorization.authorize.mockRejectedValue(
			new Error('dependency unavailable')
		);
		test.commerce.failProviderOperation.mockRejectedValue(
			new Error('database unavailable')
		);
		await expect(test.worker.handle(message())).rejects.toThrow(
			'database unavailable'
		);
		expect(test.rabbit.ack).not.toHaveBeenCalled();
		expect(test.provider.createPayment).not.toHaveBeenCalled();
	});
	it('never repeats CREATE after the provider idempotency horizon', async () => {
		const test = setup();
		test.commerce.beginProviderDispatch.mockResolvedValue({
			...test.prepared,
			firstDispatchAt: new Date(
				Date.now() - PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS - 1000
			).toISOString()
		});
		await test.worker.handle(message());
		expect(test.provider.createPayment).not.toHaveBeenCalled();
		expect(test.commerce.failProviderOperation).toHaveBeenCalledWith(
			claim,
			{
				code: 'IDEMPOTENCY_WINDOW_EXPIRED',
				ambiguous: true,
				retryable: false
			}
		);
	});
	it('decrypts a recurring method only at the provider boundary', async () => {
		const test = setup();
		test.commerce.beginProviderDispatch.mockResolvedValue({
			...test.prepared,
			request: {
				...test.prepared.request,
				kind: 'RECURRING',
				paymentMethodCiphertext: 'encrypted-fixture',
				returnUrl: null
			}
		});
		await test.worker.handle(message());
		expect(test.crypto.decrypt).toHaveBeenCalledWith('encrypted-fixture');
		expect(test.provider.createPayment.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				paymentMethodId: 'synthetic-saved-method',
				kind: 'RECURRING'
			})
		);
		expect(
			test.provider.createPayment.mock.calls[0][0]
		).not.toHaveProperty('paymentMethodCiphertext');
		expect(
			test.provider.createPayment.mock.calls[0][0]
		).not.toHaveProperty('returnUrl');
	});
});
