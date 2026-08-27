import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import {
	AutoRenewalStatus,
	PaymentKind,
	Prisma,
	ProviderOperationKind,
	ProviderOperationStatus
} from '@prisma/billing-client';
import { randomUUID } from 'node:crypto';
import { PaymentDomainService } from '../domain/payment-domain.service';
import { PaymentSuccessTransaction } from '../domain/payment-success.transaction';
import { SubscriptionDomainService } from '../domain/subscription-domain.service';
import { PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS } from '../domain/billing-legal.constants';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { BillingRuntimeService } from '../runtime/billing-runtime.service';
import { PaymentMethodCryptoService } from './payment-method-crypto.service';
import {
	isYooKassaObjectId,
	ProviderRequestError,
	YooKassaService
} from './yookassa.service';

const POLL_INTERVAL_MS = 1_000;
const LEASE_MS = 45_000;

class ProviderDispatchFailure extends Error {
	constructor(
		readonly originalError: unknown,
		readonly providerCallStarted: boolean,
		readonly providerMayHaveReceived: boolean,
		readonly providerResponseReceived: boolean,
		readonly operationProviderPaymentId: string | null
	) {
		super(
			originalError instanceof Error
				? originalError.message
				: 'Provider dispatch failed'
		);
		this.name = 'ProviderDispatchFailure';
	}
}

@Injectable()
export class BillingProviderWorkerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(BillingProviderWorkerService.name);
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private ready = false;

	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly runtime: BillingRuntimeService,
		private readonly provider: YooKassaService,
		private readonly crypto: PaymentMethodCryptoService,
		private readonly payments: PaymentDomainService,
		private readonly subscriptions: SubscriptionDomainService,
		private readonly success: PaymentSuccessTransaction
	) {}

	onModuleInit(): void {
		if (!this.runtime.workerEnabled) return;
		this.ready = true;
		this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
		this.timer.unref();
		void this.tick();
	}

	isReady(): boolean {
		return !this.runtime.workerEnabled || this.ready;
	}

	async processOne(): Promise<boolean> {
		const operation = await this.claim();
		if (!operation) return false;
		try {
			const completed = await this.process(operation);
			await this.prisma.providerOperation.updateMany({
				where: {
					id: operation.id,
					status: ProviderOperationStatus.PROCESSING,
					leaseToken: operation.leaseToken
				},
				data: {
					status: completed
						? ProviderOperationStatus.SUCCEEDED
						: ProviderOperationStatus.PENDING,
					...(completed
						? {}
						: { availableAt: this.nextVerificationAt(operation.attempt) }),
					leaseToken: null,
					leaseUntil: null,
					lastErrorCode: null,
					lastErrorSafe: null
				}
			});
		} catch (error) {
			await this.handleFailure(operation, error);
		}
		return true;
	}

	onApplicationShutdown(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.ready = false;
	}

	private async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			for (let count = 0; count < 25; count += 1) {
				if (!(await this.processOne())) break;
			}
		} catch (error) {
			this.logger.error(
				`Provider worker tick failed: ${this.safeError(error)}`
			);
		} finally {
			this.running = false;
		}
	}

	private async claim() {
		const now = new Date();
		const candidate = await this.prisma.providerOperation.findFirst({
			where: {
				availableAt: { lte: now },
				OR: [
					{ status: ProviderOperationStatus.PENDING },
					{
						status: ProviderOperationStatus.PROCESSING,
						leaseUntil: { lt: now }
					}
				]
			},
			orderBy: { createdAt: 'asc' }
		});
		if (!candidate) return null;
		const token = randomUUID();
		const changed = await this.prisma.providerOperation.updateMany({
			where: {
				id: candidate.id,
				OR: [
					{ status: ProviderOperationStatus.PENDING },
					{
						status: ProviderOperationStatus.PROCESSING,
						leaseUntil: { lt: now }
					}
				]
			},
			data: {
				status: ProviderOperationStatus.PROCESSING,
				leaseToken: token,
				leaseUntil: new Date(now.getTime() + LEASE_MS),
				attempt: { increment: 1 }
			}
		});
		if (changed.count !== 1) return null;
		const claimed = await this.prisma.providerOperation.findUniqueOrThrow({
			where: { id: candidate.id },
			include: { payment: true }
		});
		return {
			...claimed,
			reclaimedProcessingLease:
				candidate.status === ProviderOperationStatus.PROCESSING
		};
	}

	private async process(operation: any): Promise<boolean> {
		if (operation.kind === ProviderOperationKind.SYNC_RECEIPT) {
			return this.syncReceipt(operation);
		}
		if (operation.kind === ProviderOperationKind.VERIFY_PAYMENT) {
			const providerPaymentId =
				operation.providerPaymentId ||
				this.stringField(operation.payload, 'providerPaymentId');
			if (!isYooKassaObjectId(providerPaymentId)) {
				throw new ProviderRequestError(
					'Provider payment ID is invalid',
					'PROVIDER_PAYMENT_ID_INVALID',
					false,
					false
				);
			}
			const response = await this.provider.getPayment(providerPaymentId);
			const status = await this.applyProviderResponse(operation, response);
			return status === 'succeeded' || status === 'canceled';
		}
		if (
			operation.kind !== ProviderOperationKind.CREATE_CHECKOUT &&
			operation.kind !== ProviderOperationKind.CAPTURE_RECURRING
		) {
			throw new Error('Unsupported provider operation kind');
		}
		if (!operation.payment)
			throw new Error('Provider operation payment is missing');
		const response = await this.createProviderPaymentUnderFence(operation);
		if (!response) return true;
		try {
			await this.applyProviderResponse(operation, response);
		} catch (error) {
			const boundProviderPaymentId = isYooKassaObjectId(
				operation.payment?.yookassaId
			)
				? operation.payment.yookassaId
				: isYooKassaObjectId(operation.providerPaymentId)
					? operation.providerPaymentId
					: null;
			throw new ProviderDispatchFailure(
				error,
				true,
				true,
				true,
				boundProviderPaymentId ||
					(isYooKassaObjectId(response.id) ? response.id : null)
			);
		}
		return true;
	}

	private async createProviderPaymentUnderFence(
		operation: any
	): Promise<Record<string, unknown> | null> {
		let providerMayHaveReceived =
			operation.attempt > 1 || Boolean(operation.reclaimedProcessingLease);
		let providerCallStarted = false;
		let providerResponseReceived = false;
		let operationProviderPaymentId: string | null = null;
		try {
			return await this.prisma.$transaction(
				async transaction => {
					const userId = operation.payment.userId as string;
					await transaction.$queryRaw`
					SELECT user_id FROM billing.identity_contact_projections
					WHERE user_id = ${userId}
					FOR UPDATE
				`;
					await transaction.$queryRaw`
					SELECT id FROM billing.auto_renewals
					WHERE user_id = ${userId}
					FOR UPDATE
				`;
					await transaction.$queryRaw`
					SELECT id FROM billing.payments
					WHERE id = ${operation.payment.id}
					FOR UPDATE
				`;
					await transaction.$queryRaw`
					SELECT id FROM billing.subscriptions
					WHERE user_id = ${userId}
					FOR UPDATE
				`;
					await transaction.$queryRaw`
					SELECT id FROM billing.provider_operations
					WHERE id = ${operation.id}
					FOR UPDATE
				`;
					const [lockedOperation, payment, identity] = await Promise.all([
						transaction.providerOperation.findUnique({
							where: { id: operation.id }
						}),
						transaction.payment.findUnique({
							where: { id: operation.payment.id }
						}),
						transaction.identityContactProjection.findUnique({
							where: { userId }
						})
					]);
					if (
						!lockedOperation ||
						lockedOperation.status !==
							ProviderOperationStatus.PROCESSING ||
						lockedOperation.leaseToken !== operation.leaseToken ||
						!payment ||
						payment.status !== 'PENDING' ||
						!payment.plan ||
						!payment.billingPeriod ||
						!identity ||
						identity.status !== 'ACTIVE' ||
						identity.deletedAt
					) {
						await this.fenceProviderOperation(
							transaction,
							operation.id,
							operation.leaseToken,
							'PAYMENT_OR_IDENTITY_FENCED'
						);
						return null;
					}
					if (
						!payment.yookassaId &&
						lockedOperation.attempt > 1 &&
						this.providerCreateWindowExpired(lockedOperation.createdAt)
					) {
						providerMayHaveReceived = true;
						await this.markProviderOperationUnknown(
							transaction,
							lockedOperation,
							payment,
							'PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED'
						);
						return null;
					}
					if (
						!payment.yookassaId &&
						operation.reclaimedProcessingLease &&
						payment.checkoutExpiresAt <= new Date()
					) {
						providerMayHaveReceived = true;
						await this.markProviderOperationUnknown(
							transaction,
							lockedOperation,
							payment,
							'PROVIDER_STALE_CLAIM_RECONCILIATION_REQUIRED'
						);
						return null;
					}
					if (payment.yookassaId) {
						providerMayHaveReceived = true;
						providerCallStarted = true;
						operationProviderPaymentId = payment.yookassaId;
						const response = await this.provider.getPayment(
							payment.yookassaId
						);
						providerResponseReceived = true;
						if (isYooKassaObjectId(response.id)) {
							operationProviderPaymentId = response.id;
						}
						return response;
					}
					let paymentMethodId: string | undefined;
					if (operation.kind === ProviderOperationKind.CAPTURE_RECURRING) {
						const [renewal, subscription] = await Promise.all([
							transaction.autoRenewal.findUnique({ where: { userId } }),
							transaction.subscription.findUnique({ where: { userId } })
						]);
						if (
							!renewal ||
							renewal.status !== AutoRenewalStatus.ACTIVE ||
							!renewal.dispatchPending ||
							renewal.pendingAmount ||
							!renewal.paymentMethodCiphertext ||
							payment.kind !== PaymentKind.RECURRING ||
							!['queued', 'creating'].includes(
								payment.providerStatus || ''
							) ||
							payment.recurringAttempt !== renewal.retryAttempt ||
							payment.recurringCycleKey !==
								`${renewal.id}:${renewal.nextChargeAt.toISOString()}:attempt:${payment.recurringAttempt}` ||
							!subscription?.expiresAt ||
							!['ACTIVE', 'EXPIRED'].includes(subscription.status) ||
							subscription.plan !== renewal.plan ||
							subscription.billingPeriod !== renewal.billingPeriod
						) {
							if (
								!payment.yookassaId &&
								['creating', 'unknown'].includes(
									payment.providerStatus || ''
								)
							) {
								providerMayHaveReceived = true;
								await this.markProviderOperationUnknown(
									transaction,
									lockedOperation,
									payment,
									'AUTO_RENEWAL_RECONCILIATION_REQUIRED'
								);
							} else {
								await this.fenceProviderOperation(
									transaction,
									operation.id,
									operation.leaseToken,
									'AUTO_RENEWAL_FENCED'
								);
							}
							return null;
						}
						if (payment.providerStatus === 'creating') {
							providerMayHaveReceived = true;
						}
						const dispatchNow = new Date();
						if (
							payment.checkoutExpiresAt <= dispatchNow &&
							lockedOperation.attempt <= 1
						) {
							if (providerMayHaveReceived) {
								await this.markProviderOperationUnknown(
									transaction,
									lockedOperation,
									payment,
									'AUTO_RENEWAL_RECONCILIATION_REQUIRED'
								);
							} else {
								await this.closeExpiredRecurringDispatch(
									transaction,
									lockedOperation,
									payment,
									renewal,
									dispatchNow,
									operation.id
								);
							}
							return null;
						}
						paymentMethodId = this.crypto.decrypt(
							renewal.paymentMethodCiphertext
						);
					} else if (
						payment.kind !== PaymentKind.ONE_TIME ||
						(payment.checkoutExpiresAt <= new Date() &&
							lockedOperation.attempt <= 1)
					) {
						await this.fenceProviderOperation(
							transaction,
							operation.id,
							operation.leaseToken,
							'CHECKOUT_FENCED'
						);
						return null;
					}
					if (
						payment.kind === PaymentKind.RECURRING &&
						payment.providerStatus === 'queued'
					) {
						await transaction.payment.update({
							where: { id: payment.id },
							data: {
								providerStatus: 'creating',
								lastProviderCheckedAt: new Date()
							}
						});
					}

					const providerRequest = {
						paymentId: payment.id,
						amount: payment.amount,
						currency: payment.currency,
						plan: payment.plan,
						billingPeriod: payment.billingPeriod,
						autoRenew: payment.autoRenew,
						customerEmail: payment.customerEmail,
						customerPhone: payment.customerPhone,
						returnUrl: this.returnUrl(payment.id),
						paymentMethodId,
						kind:
							payment.kind === PaymentKind.RECURRING
								? ('RECURRING' as const)
								: ('ONE_TIME' as const)
					};
					if (!payment.customerEmail && !payment.customerPhone) {
						throw new ProviderRequestError(
							'Payment customer contact is missing',
							'CUSTOMER_CONTACT_MISSING',
							false,
							false
						);
					}
					if (!this.provider.isConfigured()) {
						throw new Error('YooKassa credentials are missing');
					}
					if (
						(payment.kind === PaymentKind.RECURRING &&
							lockedOperation.attempt <= 1) ||
						operation.reclaimedProcessingLease
					) {
						const finalDispatchNow = new Date();
						if (payment.checkoutExpiresAt <= finalDispatchNow) {
							if (providerMayHaveReceived) {
								await this.markProviderOperationUnknown(
									transaction,
									lockedOperation,
									payment,
									'AUTO_RENEWAL_RECONCILIATION_REQUIRED',
									finalDispatchNow
								);
							} else {
								const renewal = await transaction.autoRenewal.findUnique({
									where: { userId }
								});
								if (!renewal) {
									throw new Error(
										'Auto-renewal disappeared under provider lock'
									);
								}
								await this.closeExpiredRecurringDispatch(
									transaction,
									lockedOperation,
									payment,
									renewal,
									finalDispatchNow,
									operation.id
								);
							}
							return null;
						}
					}
					providerMayHaveReceived = true;
					providerCallStarted = true;
					const response = await this.provider.createPayment(
						providerRequest,
						lockedOperation.idempotencyKey
					);
					providerResponseReceived = true;
					if (isYooKassaObjectId(response.id)) {
						operationProviderPaymentId = response.id;
					}
					return response;
				},
				{
					isolationLevel: 'Serializable',
					maxWait: 5_000,
					timeout: 30_000
				}
			);
		} catch (error) {
			throw new ProviderDispatchFailure(
				error,
				providerCallStarted,
				providerMayHaveReceived,
				providerResponseReceived,
				operationProviderPaymentId
			);
		}
	}

	private async closeExpiredRecurringDispatch(
		transaction: Prisma.TransactionClient,
		operation: {
			id: string;
			leaseToken: string | null;
			attempt: number;
		},
		payment: {
			id: string;
			userId: string;
			recurringCycleKey: string | null;
		},
		renewal: { id: string },
		now: Date,
		triggerId: string
	): Promise<void> {
		if (!operation.leaseToken || !payment.recurringCycleKey) {
			throw new Error('Recurring provider claim is incomplete');
		}
		const closeResult =
			await this.subscriptions.closeExpiredRecurringDispatch(transaction, {
				paymentId: payment.id,
				autoRenewalId: renewal.id,
				cycleKey: payment.recurringCycleKey,
				now,
				triggerId,
				trustedClaim: {
					operationId: operation.id,
					leaseToken: operation.leaseToken
				}
			});
		if (closeResult === 'CLOSED' || closeResult === 'ALREADY_CLOSED') {
			return;
		}
		if (closeResult === 'NOT_EXPIRED') {
			throw new Error('Recurring dispatch deadline changed under lock');
		}
		await this.markProviderOperationUnknown(
			transaction,
			operation,
			payment,
			'AUTO_RENEWAL_RECONCILIATION_REQUIRED',
			now
		);
	}

	private async markProviderOperationUnknown(
		transaction: Prisma.TransactionClient,
		operation: {
			id: string;
			leaseToken: string | null;
			attempt: number;
		},
		payment: { id: string; userId: string },
		code: string,
		now = new Date()
	): Promise<void> {
		if (!operation.leaseToken) {
			throw new Error('Provider operation lease token is missing');
		}
		await this.payments.settleProviderOperationTerminalInTransaction(
			transaction,
			{
				operationId: operation.id,
				paymentId: payment.id,
				userId: payment.userId,
				leaseToken: operation.leaseToken,
				operationAttempt: operation.attempt,
				terminalStatus: ProviderOperationStatus.UNKNOWN,
				errorCode: code,
				errorSafe:
					'Provider operation requires reconciliation without another POST',
				now
			}
		);
	}

	private providerCreateWindowExpired(createdAt: Date): boolean {
		return (
			Date.now() - createdAt.getTime() >=
			PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS
		);
	}

	private async fenceProviderOperation(
		transaction: Prisma.TransactionClient,
		operationId: string,
		leaseToken: string,
		code: string
	): Promise<void> {
		await transaction.providerOperation.updateMany({
			where: {
				id: operationId,
				status: ProviderOperationStatus.PROCESSING,
				leaseToken
			},
			data: {
				status: ProviderOperationStatus.FAILED,
				leaseToken: null,
				leaseUntil: null,
				lastErrorCode: code,
				lastErrorSafe: 'Provider operation fenced before external call'
			}
		});
	}

	private async applyProviderResponse(
		operation: any,
		response: Record<string, unknown>
	): Promise<string> {
		const providerPaymentId = this.providerObjectId(response, 'id');
		const expectedProviderPaymentId =
			operation.providerPaymentId ||
			this.stringField(operation.payload, 'providerPaymentId');
		if (
			expectedProviderPaymentId &&
			providerPaymentId !== expectedProviderPaymentId
		) {
			throw new ProviderRequestError(
				'Provider response ID does not match operation',
				'PROVIDER_PAYMENT_ID_MISMATCH',
				false,
				false
			);
		}
		const status = this.requiredString(response, 'status');
		const amount = this.record(response.amount);
		const value = this.requiredString(amount, 'value');
		const currency = this.requiredString(amount, 'currency');
		const metadata = this.record(response.metadata);
		const metadataPaymentId = this.localPaymentId(metadata, 'paymentId');
		const localPaymentId = operation.paymentId || metadataPaymentId;
		if (metadataPaymentId !== localPaymentId) {
			throw new ProviderRequestError(
				'Provider metadata paymentId does not match operation',
				'PROVIDER_PAYMENT_BINDING_MISMATCH',
				false,
				false
			);
		}
		const payment =
			operation.payment ||
			(await this.prisma.payment.findUnique({
				where: { id: localPaymentId }
			}));
		if (!payment) {
			throw new ProviderRequestError(
				'Late provider payment has no local match',
				'LOCAL_PAYMENT_NOT_FOUND',
				false,
				false
			);
		}
		if (payment.amount !== value || payment.currency !== currency) {
			throw new Error(
				'Provider payment amount or currency does not match'
			);
		}
		if (status === 'succeeded') {
			const method = this.record(response.payment_method);
			const methodId = typeof method.id === 'string' ? method.id : null;
			const saved = method.saved === true;
			const card = this.record(method.card);
			await this.success.apply({
				paymentId: payment.id,
				providerPaymentId,
				providerAmount: value,
				providerCurrency: currency,
				succeededAt:
					this.dateField(response, 'captured_at') ||
					this.dateField(response, 'created_at') ||
					new Date(),
				paymentMethodCiphertext:
					saved && methodId ? this.crypto.encrypt(methodId) : null,
				paymentMethodType:
					typeof method.type === 'string' ? method.type : null,
				paymentMethodTitle:
					typeof method.title === 'string' ? method.title : null,
				paymentMethodLast4:
					typeof card.last4 === 'string' ? card.last4 : null,
				providerSnapshot: this.sanitizeProviderSnapshot(response)
			});
			return status;
		}
		if (status === 'canceled') {
			const cancellation = this.record(response.cancellation_details);
			const reason =
				typeof cancellation.reason === 'string' && cancellation.reason
					? cancellation.reason
					: 'provider_cancelled';
			await this.payments.markProviderCancelled(
				payment.id,
				providerPaymentId,
				status,
				reason
			);
			return status;
		}
		const confirmation = this.record(response.confirmation);
		await this.payments.bindProviderState(payment.id, {
			providerPaymentId,
			providerStatus: status,
			confirmationUrl:
				typeof confirmation.confirmation_url === 'string'
					? confirmation.confirmation_url
					: null,
			providerCreatedAt: this.dateField(response, 'created_at'),
			providerExpiresAt: this.dateField(response, 'expires_at'),
			providerSnapshot: this.sanitizeProviderSnapshot(response)
		});
		return status;
	}

	private async syncReceipt(operation: any): Promise<boolean> {
		const providerPaymentId =
			operation.providerPaymentId || operation.payment?.yookassaId;
		if (!isYooKassaObjectId(providerPaymentId)) {
			throw new ProviderRequestError(
				'Receipt operation provider payment ID is invalid',
				'PROVIDER_PAYMENT_ID_INVALID',
				false,
				false
			);
		}
		const payment = await this.prisma.payment.findUnique({
			where: operation.paymentId
				? { id: operation.paymentId }
				: { yookassaId: providerPaymentId },
			select: { id: true, yookassaId: true }
		});
		if (!payment) {
			throw new ProviderRequestError(
				'Receipt arrived before local payment binding',
				'LOCAL_PAYMENT_NOT_READY',
				true,
				false
			);
		}
		if (
			!isYooKassaObjectId(payment.yookassaId) ||
			payment.yookassaId !== providerPaymentId
		) {
			throw new ProviderRequestError(
				'Receipt operation local payment binding is invalid',
				'LOCAL_PAYMENT_PROVIDER_MISMATCH',
				false,
				false
			);
		}
		const paymentId = payment.id;
		const response = await this.provider.getReceipts(providerPaymentId);
		const items = Array.isArray(response.items) ? response.items : [];
		if (items.length === 0) return false;
		const receiptIds = new Set<string>();
		const receipts = items.map(raw => {
			const receipt = this.record(raw);
			const receiptId = this.providerObjectId(receipt, 'id');
			const receiptPaymentId = this.providerObjectId(
				receipt,
				'payment_id'
			);
			if (receiptPaymentId !== providerPaymentId) {
				throw new ProviderRequestError(
					'Provider receipt payment binding is invalid',
					'PROVIDER_RECEIPT_PAYMENT_MISMATCH',
					false,
					false
				);
			}
			if (receiptIds.has(receiptId)) {
				throw new ProviderRequestError(
					'Provider returned a duplicate receipt ID',
					'PROVIDER_RECEIPT_DUPLICATE',
					false,
					false
				);
			}
			receiptIds.add(receiptId);
			const status = this.receiptStatus(receipt);
			const type = receipt.type;
			if (type !== 'payment' && type !== 'refund') {
				throw new ProviderRequestError(
					'Provider receipt type is invalid',
					'PROVIDER_RECEIPT_TYPE_INVALID',
					false,
					false
				);
			}
			return {
				providerReceiptId: receiptId,
				status,
				type,
				fiscalDocumentNumber: this.optionalString(
					receipt,
					'fiscal_document_number'
				),
				fiscalStorageNumber: this.optionalString(
					receipt,
					'fiscal_storage_number'
				),
				fiscalAttribute: this.optionalString(receipt, 'fiscal_attribute'),
				registeredAt: this.dateField(receipt, 'registered_at'),
				publicUrl: null,
				raw: receipt as Prisma.InputJsonValue
			};
		});
		await this.prisma.$transaction(
			async transaction => {
				const ownedPayments = await transaction.$queryRaw<
					Array<{ id: string }>
				>`
					SELECT id
					FROM billing.payments
					WHERE id = ${paymentId}
						AND yookassa_id = ${providerPaymentId}
					FOR UPDATE
				`;
				if (ownedPayments.length !== 1) {
					throw new ProviderRequestError(
						'Receipt operation local payment binding changed',
						'LOCAL_PAYMENT_PROVIDER_MISMATCH',
						false,
						false
					);
				}
				await transaction.paymentReceipt.createMany({
					data: receipts.map(receipt => ({
						paymentId,
						...receipt
					})),
					skipDuplicates: true
				});
				for (const receipt of receipts) {
					const updated = await transaction.paymentReceipt.updateMany({
						where: {
							paymentId,
							providerReceiptId: receipt.providerReceiptId
						},
						data: {
							status: receipt.status,
							type: receipt.type,
							fiscalDocumentNumber: receipt.fiscalDocumentNumber,
							fiscalStorageNumber: receipt.fiscalStorageNumber,
							fiscalAttribute: receipt.fiscalAttribute,
							registeredAt: receipt.registeredAt,
							publicUrl: receipt.publicUrl,
							raw: receipt.raw
						}
					});
					if (updated.count !== 1) {
						throw new ProviderRequestError(
							'Provider receipt ownership is invalid',
							'PROVIDER_RECEIPT_OWNERSHIP_MISMATCH',
							false,
							false
						);
					}
				}
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		return receipts.every(receipt => receipt.status !== 'pending');
	}

	private async handleFailure(
		operation: any,
		error: unknown
	): Promise<void> {
		const dispatchFailure =
			error instanceof ProviderDispatchFailure ? error : null;
		const failure = dispatchFailure?.originalError ?? error;
		const providerError =
			failure instanceof ProviderRequestError ? failure : null;
		const age = Date.now() - operation.createdAt.getTime();
		const paymentCreation =
			operation.kind === ProviderOperationKind.CREATE_CHECKOUT ||
			operation.kind === ProviderOperationKind.CAPTURE_RECURRING;
		const knownProviderPaymentLookup = Boolean(
			paymentCreation &&
			(isYooKassaObjectId(operation.payment?.yookassaId) ||
				isYooKassaObjectId(dispatchFailure?.operationProviderPaymentId))
		);
		const postResponseFailure = Boolean(
			paymentCreation && dispatchFailure?.providerResponseReceived
		);
		const reclaimedPreProviderFailure = Boolean(
			paymentCreation &&
			operation.reclaimedProcessingLease &&
			dispatchFailure &&
			!dispatchFailure.providerCallStarted
		);
		const knownPreProviderFailure = Boolean(
			paymentCreation &&
			dispatchFailure &&
			!dispatchFailure.providerCallStarted &&
			!operation.reclaimedProcessingLease
		);
		const retryableOrUnexpected =
			providerError?.retryable || !providerError;
		if (
			!postResponseFailure &&
			!reclaimedPreProviderFailure &&
			(knownPreProviderFailure ||
				(retryableOrUnexpected &&
					(operation.kind === ProviderOperationKind.SYNC_RECEIPT ||
						knownProviderPaymentLookup ||
						age < PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS)))
		) {
			if (knownPreProviderFailure && operation.attempt < 1) {
				throw new Error(
					'Provider operation attempt cannot be decremented'
				);
			}
			const delay = Math.min(
				60_000 * 2 ** Math.min(operation.attempt, 5),
				30 * 60_000
			);
			const changed = await this.prisma.providerOperation.updateMany({
				where: {
					id: operation.id,
					status: ProviderOperationStatus.PROCESSING,
					leaseToken: operation.leaseToken,
					attempt: operation.attempt
				},
				data: {
					status: ProviderOperationStatus.PENDING,
					...(knownPreProviderFailure
						? { attempt: { decrement: 1 } }
						: {}),
					availableAt: new Date(Date.now() + delay),
					leaseToken: null,
					leaseUntil: null,
					lastErrorCode: providerError?.code || 'WORKER_ERROR',
					lastErrorSafe: this.safeError(failure)
				}
			});
			if (changed.count !== 1) {
				throw new Error('Provider operation retry claim changed');
			}
			return;
		}
		const unknown = Boolean(
			postResponseFailure ||
			reclaimedPreProviderFailure ||
			knownProviderPaymentLookup ||
			!providerError ||
			providerError.ambiguous ||
			providerError.retryable
		);
		const errorCode = providerError?.code || 'WORKER_ERROR';
		const errorSafe = this.safeError(failure);
		if (paymentCreation && operation.paymentId) {
			if (!operation.leaseToken) {
				throw new Error('Provider operation lease token is missing');
			}
			await this.payments.settleProviderOperationTerminal({
				operationId: operation.id,
				paymentId: operation.paymentId,
				leaseToken: operation.leaseToken,
				operationAttempt: operation.attempt,
				terminalStatus: unknown
					? ProviderOperationStatus.UNKNOWN
					: ProviderOperationStatus.FAILED,
				errorCode,
				errorSafe,
				now: new Date(),
				...(unknown
					? {
							operationProviderPaymentId:
								dispatchFailure?.operationProviderPaymentId ||
								operation.providerPaymentId ||
								null
						}
					: {
							providerPaymentId: operation.providerPaymentId || null,
							paymentProviderStatus: 'rejected',
							cancellationReason: errorCode
						})
			});
			return;
		}
		const changed = await this.prisma.providerOperation.updateMany({
			where: {
				id: operation.id,
				status: ProviderOperationStatus.PROCESSING,
				leaseToken: operation.leaseToken,
				attempt: operation.attempt
			},
			data: {
				status: unknown
					? ProviderOperationStatus.UNKNOWN
					: ProviderOperationStatus.FAILED,
				leaseToken: null,
				leaseUntil: null,
				lastErrorCode: errorCode,
				lastErrorSafe: errorSafe
			}
		});
		if (changed.count !== 1) {
			throw new Error('Provider operation terminal claim changed');
		}
	}

	private record(value: unknown): Record<string, any> {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, any>)
			: {};
	}

	private sanitizeProviderSnapshot(
		response: Record<string, unknown>
	): Record<string, unknown> {
		if (
			!response.payment_method ||
			typeof response.payment_method !== 'object' ||
			Array.isArray(response.payment_method)
		) {
			return response;
		}
		const paymentMethod = {
			...(response.payment_method as Record<string, unknown>)
		};
		delete paymentMethod.id;
		return { ...response, payment_method: paymentMethod };
	}

	private requiredString(
		value: Record<string, unknown>,
		key: string
	): string {
		const result = value[key];
		if (typeof result !== 'string' || !result) {
			throw new Error(`Provider response ${key} is invalid`);
		}
		return result;
	}

	private optionalString(
		value: Record<string, unknown>,
		key: string
	): string | null {
		return typeof value[key] === 'string' ? (value[key] as string) : null;
	}

	private receiptStatus(
		value: Record<string, unknown>
	): 'pending' | 'succeeded' | 'canceled' {
		const status = this.requiredString(value, 'status');
		if (!['pending', 'succeeded', 'canceled'].includes(status)) {
			throw new ProviderRequestError(
				'Provider receipt status is invalid',
				'PROVIDER_RECEIPT_STATUS_INVALID',
				false,
				false
			);
		}
		return status as 'pending' | 'succeeded' | 'canceled';
	}

	private providerObjectId(
		value: Record<string, unknown>,
		key: string
	): string {
		const result = value[key];
		if (!isYooKassaObjectId(result)) {
			throw new ProviderRequestError(
				`Provider response ${key} is invalid`,
				'PROVIDER_OBJECT_ID_INVALID',
				false,
				false
			);
		}
		return result;
	}

	private localPaymentId(
		value: Record<string, unknown>,
		key: string
	): string {
		const result = value[key];
		if (
			typeof result !== 'string' ||
			!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result)
		) {
			throw new ProviderRequestError(
				`Provider metadata ${key} is invalid`,
				'PROVIDER_METADATA_PAYMENT_ID_INVALID',
				false,
				false
			);
		}
		return result;
	}

	private nextVerificationAt(attempt: number): Date {
		const delay = Math.min(
			60_000 * 2 ** Math.min(Math.max(attempt, 0), 5),
			30 * 60_000
		);
		return new Date(Date.now() + delay);
	}

	private stringField(value: unknown, key: string): string | undefined {
		const record = this.record(value);
		return typeof record[key] === 'string' ? record[key] : undefined;
	}

	private returnUrl(paymentId: string): string {
		const raw = process.env.RECAPTCHA_CLIENT_URL?.trim();
		if (!raw) {
			throw new Error('Не настроен адрес возврата после оплаты');
		}
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error('Не настроен адрес возврата после оплаты');
		}
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error('Не настроен адрес возврата после оплаты');
		}
		return `${url.toString().replace(/\/$/, '')}/payment/success?paymentId=${encodeURIComponent(paymentId)}`;
	}

	private dateField(
		value: Record<string, unknown>,
		key: string
	): Date | null {
		if (typeof value[key] !== 'string') return null;
		const date = new Date(value[key] as string);
		return Number.isFinite(date.getTime()) ? date : null;
	}

	private safeError(error: unknown): string {
		return error instanceof Error
			? error.message.slice(0, 500)
			: 'Unknown worker error';
	}
}
