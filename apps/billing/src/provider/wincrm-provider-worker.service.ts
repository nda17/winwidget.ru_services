import {
	Injectable,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { DeliveryReceiptStatus, Prisma } from '@prisma/billing-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash, randomUUID } from 'node:crypto';
import { WincrmCommerceService } from '../domain/wincrm-commerce.service';
import type {
	WincrmPreparedProviderOperation,
	WincrmProviderClaim,
	WincrmProviderEvent,
	WincrmProviderFailure
} from '../domain/wincrm-commerce.contract';
import { WincrmProviderResponseError } from '../domain/wincrm-commerce.contract';
import { PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS } from '../domain/billing-legal.constants';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { BillingRuntimeService } from '../runtime/billing-runtime.service';
import { PaymentMethodCryptoService } from './payment-method-crypto.service';
import {
	isYooKassaObjectId,
	ProviderRequestError,
	YooKassaService
} from './yookassa.service';
import {
	WincrmAccessAuthorizationClient,
	WincrmProviderAuthorizationError
} from './wincrm-access-authorization.client';
import { WincrmProviderRabbitMqService } from './wincrm-provider-rabbitmq.service';
import {
	WINCRM_PROVIDER_DEAD_EXCHANGE,
	WINCRM_PROVIDER_EVENT,
	wincrmProviderMessagingEnabled
} from './wincrm-provider.config';

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POISON_CONSUMER = 'billing.wincrm-provider-invalid.v1';

export function parseWincrmProviderMessage(
	message: ConsumeMessage
): WincrmProviderEvent {
	if (
		message.content.length > 1_024 ||
		message.properties.contentType !== 'application/json'
	)
		throw new Error('INVALID_EVENT');
	const value: unknown = JSON.parse(message.content.toString('utf8'));
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('INVALID_EVENT');
	const event = value as Record<string, unknown>;
	if (
		Object.keys(event).length !== 4 ||
		!['schemaVersion', 'eventType', 'eventId', 'operationId'].every(key =>
			Object.prototype.hasOwnProperty.call(event, key)
		) ||
		event.schemaVersion !== 1 ||
		event.eventType !== WINCRM_PROVIDER_EVENT ||
		typeof event.eventId !== 'string' ||
		!UUID_V4.test(event.eventId) ||
		typeof event.operationId !== 'string' ||
		!UUID_V4.test(event.operationId) ||
		message.properties.messageId !== event.eventId ||
		message.properties.type !== WINCRM_PROVIDER_EVENT ||
		message.fields.exchange !== 'winwidget.events' ||
		message.fields.routingKey !== WINCRM_PROVIDER_EVENT
	)
		throw new Error('INVALID_EVENT');
	return event as unknown as WincrmProviderEvent;
}

@Injectable()
export class WincrmProviderWorkerService
	implements OnModuleInit, OnApplicationShutdown
{
	private stopping = false;
	constructor(
		private readonly runtime: BillingRuntimeService,
		private readonly rabbit: WincrmProviderRabbitMqService,
		private readonly commerce: WincrmCommerceService,
		private readonly provider: YooKassaService,
		private readonly crypto: PaymentMethodCryptoService,
		private readonly authorization: WincrmAccessAuthorizationClient,
		private readonly prisma: BillingPrismaService
	) {}

	async onModuleInit() {
		if (!wincrmProviderMessagingEnabled() || !this.runtime.workerEnabled)
			return;
		await this.rabbit.consume(message => this.handle(message));
	}

	onApplicationShutdown() {
		this.stopping = true;
	}
	isReady() {
		return this.rabbit.isReady() && !this.stopping;
	}

	async handle(message: ConsumeMessage): Promise<void> {
		let event: WincrmProviderEvent;
		try {
			event = parseWincrmProviderMessage(message);
		} catch {
			await this.quarantineInvalidMessage(message);
			this.rabbit.ack(message);
			return;
		}
		const result = await this.commerce.claimProviderOperation(event);
		if (result.state === 'BUSY') {
			await this.rabbit.requeue(message);
			return;
		}
		if (result.state === 'DONE') {
			this.rabbit.ack(message);
			return;
		}
		if (result.state !== 'CLAIMED')
			throw new Error('INVALID_PROVIDER_CLAIM');
		await this.execute(result.claim);
		// settle/fail commits the receipt and any next Outbox delivery before ACK.
		this.rabbit.ack(message);
	}

	private async execute(claim: WincrmProviderClaim) {
		let providerCallStarted = false;
		let providerPaymentId: string | undefined;
		let prepared: WincrmPreparedProviderOperation = { action: 'SKIP' };
		try {
			prepared = await this.commerce.prepareProviderOperation(claim);
			if (prepared.action === 'SKIP') return;
			if (prepared.providerPaymentId)
				providerPaymentId = prepared.providerPaymentId;
			if (prepared.action === 'CREATE') {
				await this.authorization.authorize(prepared);
				prepared = await this.commerce.beginProviderDispatch(claim);
				if (prepared.action === 'SKIP') return;
			}
			let response: Record<string, unknown>;
			if (prepared.action === 'CREATE') {
				const request = prepared.request;
				if (!request || !prepared.firstDispatchAt)
					throw new Error('INVALID_PROVIDER_PREPARATION');
				const firstDispatchMs = Date.parse(prepared.firstDispatchAt);
				if (
					!Number.isFinite(firstDispatchMs) ||
					Date.now() - firstDispatchMs >=
						PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS
				) {
					await this.commerce.failProviderOperation(claim, {
						code: 'IDEMPOTENCY_WINDOW_EXPIRED',
						ambiguous: true,
						retryable: false
					});
					return;
				}
				const { paymentMethodCiphertext, returnUrl, ...input } = request;
				const paymentMethodId = paymentMethodCiphertext
					? this.crypto.decrypt(paymentMethodCiphertext)
					: undefined;
				if (request.kind === 'RECURRING' && !paymentMethodId)
					throw new Error('SAVED_METHOD_MISSING');
				providerCallStarted = true;
				response = await this.provider.createPayment(
					{
						...input,
						...(returnUrl ? { returnUrl } : {}),
						...(paymentMethodId ? { paymentMethodId } : {})
					},
					prepared.idempotencyKey
				);
			} else {
				if (!isYooKassaObjectId(prepared.providerPaymentId))
					throw new Error('INVALID_PROVIDER_BINDING');
				providerPaymentId = prepared.providerPaymentId;
				response =
					prepared.action === 'SYNC_RECEIPT'
						? await this.provider.getReceipts(
								prepared.providerPaymentId,
								'WINCRM'
							)
						: await this.provider.getPayment(
								prepared.providerPaymentId,
								'WINCRM'
							);
			}
			if (prepared.action === 'CREATE' && isYooKassaObjectId(response.id))
				providerPaymentId = response.id;
			await this.commerce.settleProviderOperation(claim, response);
		} catch (error) {
			const failure = this.classifyFailure(error, providerCallStarted);
			await this.commerce.failProviderOperation(claim, {
				...failure,
				...(providerPaymentId ? { providerPaymentId } : {})
			});
		}
	}

	private classifyFailure(
		error: unknown,
		externalCallStarted: boolean
	): WincrmProviderFailure {
		if (error instanceof WincrmProviderResponseError)
			return {
				code: error.code,
				ambiguous: externalCallStarted,
				retryable: false
			};
		if (error instanceof WincrmProviderAuthorizationError)
			return {
				code: error.code,
				ambiguous: false,
				retryable: error.code !== 'AUTHORIZATION_REVOKED'
			};
		if (error instanceof ProviderRequestError) {
			const code =
				error.code === 'PROVIDER_TRANSPORT_UNKNOWN'
					? 'TRANSPORT_UNKNOWN'
					: error.code === 'PROVIDER_REJECTED'
						? 'PROVIDER_REJECTED'
						: error.code === 'PROVIDER_RETRYABLE'
							? 'PROVIDER_RETRYABLE'
							: 'PROVIDER_INVALID_RESPONSE';
			return {
				code,
				ambiguous:
					error.ambiguous || (externalCallStarted && error.retryable),
				retryable: error.retryable
			};
		}
		// Database errors after a successful provider response must never become a new charge.
		return {
			code: externalCallStarted
				? 'TRANSPORT_UNKNOWN'
				: 'DEPENDENCY_UNAVAILABLE',
			ambiguous: externalCallStarted,
			retryable: true
		};
	}

	private async quarantineInvalidMessage(message: ConsumeMessage) {
		const hash = createHash('sha256')
			.update(message.content)
			.digest('hex');
		const eventId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
		await this.prisma.$transaction(
			async transaction => {
				await transaction.$executeRaw(
					Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-wincrm-provider-invalid:${hash}`}, 0))`
				);
				const prior =
					await transaction.integrationDeliveryReceipt.findUnique({
						where: {
							eventId_consumer: { eventId, consumer: POISON_CONSUMER }
						}
					});
				if (prior) return;
				const safeEvidence = {
					schemaVersion: 1,
					eventType: WINCRM_PROVIDER_EVENT,
					eventId,
					code: 'INVALID_EVENT',
					contentSha256: hash
				};
				await transaction.integrationDeliveryFailure.create({
					data: {
						eventId,
						consumer: POISON_CONSUMER,
						routingKey: WINCRM_PROVIDER_EVENT,
						payload: safeEvidence,
						errorCode: 'INVALID_EVENT',
						errorSafe: 'WinCRM provider message contract is invalid',
						retryable: false
					}
				});
				await transaction.outboxEvent.create({
					data: {
						eventId: randomUUID(),
						messageId: eventId,
						eventType: WINCRM_PROVIDER_EVENT,
						aggregateType: 'billing.wincrm-provider-invalid',
						aggregateId: eventId,
						exchange: WINCRM_PROVIDER_DEAD_EXCHANGE,
						routingKey: WINCRM_PROVIDER_EVENT,
						payload: safeEvidence,
						deduplicationKey: `wincrm-provider-invalid:${hash}`
					}
				});
				await transaction.integrationDeliveryReceipt.create({
					data: {
						eventId,
						consumer: POISON_CONSUMER,
						status: DeliveryReceiptStatus.DELIVERED,
						deliveredAt: new Date()
					}
				});
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}
}
