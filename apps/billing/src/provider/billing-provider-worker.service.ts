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
const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;

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
		return this.prisma.providerOperation.findUniqueOrThrow({
			where: { id: candidate.id },
			include: { payment: true }
		});
	}

	private async process(operation: any): Promise<boolean> {
		if (operation.kind === ProviderOperationKind.SYNC_RECEIPT) {
			await this.syncReceipt(operation);
			return true;
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
		await this.applyProviderResponse(operation, response);
		return true;
	}

	private async createProviderPaymentUnderFence(
		operation: any
	): Promise<Record<string, unknown> | null> {
		return this.prisma.$transaction(
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
					lockedOperation.status !== ProviderOperationStatus.PROCESSING ||
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
						payment.providerStatus !== 'queued' ||
						payment.recurringAttempt !== renewal.retryAttempt ||
						payment.recurringCycleKey !==
							`${renewal.id}:${renewal.nextChargeAt.toISOString()}:attempt:${payment.recurringAttempt}` ||
						!subscription?.expiresAt ||
						!['ACTIVE', 'EXPIRED'].includes(subscription.status) ||
						subscription.plan !== renewal.plan ||
						subscription.billingPeriod !== renewal.billingPeriod
					) {
						await this.fenceProviderOperation(
							transaction,
							operation.id,
							operation.leaseToken,
							'AUTO_RENEWAL_FENCED'
						);
						return null;
					}
					paymentMethodId = this.crypto.decrypt(
						renewal.paymentMethodCiphertext
					);
				} else if (
					payment.kind !== PaymentKind.ONE_TIME ||
					payment.checkoutExpiresAt <= new Date()
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

				if (payment.yookassaId) {
					return this.provider.getPayment(payment.yookassaId);
				}
				return this.provider.createPayment(
					{
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
								? 'RECURRING'
								: 'ONE_TIME'
					},
					lockedOperation.idempotencyKey
				);
			},
			{
				isolationLevel: 'Serializable',
				maxWait: 5_000,
				timeout: 30_000
			}
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
				providerSnapshot: response
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
			providerSnapshot: response
		});
		return status;
	}

	private async syncReceipt(operation: any): Promise<void> {
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
		const paymentId =
			operation.paymentId ||
			(
				await this.prisma.payment.findUnique({
					where: { yookassaId: providerPaymentId },
					select: { id: true }
				})
			)?.id;
		if (!paymentId) {
			throw new ProviderRequestError(
				'Receipt arrived before local payment binding',
				'LOCAL_PAYMENT_NOT_READY',
				true,
				false
			);
		}
		const response = await this.provider.getReceipts(providerPaymentId);
		const items = Array.isArray(response.items) ? response.items : [];
		for (const raw of items) {
			const receipt = this.record(raw);
			const receiptId = this.providerObjectId(receipt, 'id');
			const fiscal = this.record(receipt.fiscal_document);
			await this.prisma.paymentReceipt.upsert({
				where: { providerReceiptId: receiptId },
				create: {
					paymentId,
					providerReceiptId: receiptId,
					status: this.requiredString(receipt, 'status'),
					type: typeof receipt.type === 'string' ? receipt.type : null,
					fiscalDocumentNumber: this.optionalString(
						fiscal,
						'fiscal_document_number'
					),
					fiscalStorageNumber: this.optionalString(
						fiscal,
						'fiscal_storage_number'
					),
					fiscalAttribute: this.optionalString(fiscal, 'fiscal_attribute'),
					registeredAt: this.dateField(receipt, 'registered_at'),
					publicUrl: this.optionalString(receipt, 'receipt_url'),
					raw: receipt
				},
				update: {
					status: this.requiredString(receipt, 'status'),
					type: typeof receipt.type === 'string' ? receipt.type : null,
					fiscalDocumentNumber: this.optionalString(
						fiscal,
						'fiscal_document_number'
					),
					fiscalStorageNumber: this.optionalString(
						fiscal,
						'fiscal_storage_number'
					),
					fiscalAttribute: this.optionalString(fiscal, 'fiscal_attribute'),
					registeredAt: this.dateField(receipt, 'registered_at'),
					publicUrl: this.optionalString(receipt, 'receipt_url'),
					raw: receipt
				}
			});
		}
	}

	private async handleFailure(
		operation: any,
		error: unknown
	): Promise<void> {
		const providerError =
			error instanceof ProviderRequestError ? error : null;
		const age = Date.now() - operation.createdAt.getTime();
		const retryableOrUnexpected =
			providerError?.retryable || !providerError;
		if (retryableOrUnexpected && age < IDEMPOTENCY_WINDOW_MS) {
			const delay = Math.min(
				60_000 * 2 ** Math.min(operation.attempt, 5),
				30 * 60_000
			);
			await this.prisma.providerOperation.updateMany({
				where: { id: operation.id, leaseToken: operation.leaseToken },
				data: {
					status: ProviderOperationStatus.PENDING,
					availableAt: new Date(Date.now() + delay),
					leaseToken: null,
					leaseUntil: null,
					lastErrorCode: providerError?.code || 'WORKER_ERROR',
					lastErrorSafe: this.safeError(error)
				}
			});
			return;
		}
		const unknown = Boolean(
			!providerError || providerError.ambiguous || providerError.retryable
		);
		await this.prisma.providerOperation.updateMany({
			where: { id: operation.id, leaseToken: operation.leaseToken },
			data: {
				status: unknown
					? ProviderOperationStatus.UNKNOWN
					: ProviderOperationStatus.FAILED,
				leaseToken: null,
				leaseUntil: null,
				lastErrorCode: providerError?.code || 'WORKER_ERROR',
				lastErrorSafe: this.safeError(error)
			}
		});
		const paymentCreation =
			operation.kind === ProviderOperationKind.CREATE_CHECKOUT ||
			operation.kind === ProviderOperationKind.CAPTURE_RECURRING;
		if (!unknown && paymentCreation && operation.paymentId) {
			await this.payments.markProviderCancelled(
				operation.paymentId,
				operation.providerPaymentId || null,
				'rejected',
				providerError?.code || 'provider_rejected'
			);
		}
	}

	private record(value: unknown): Record<string, any> {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, any>)
			: {};
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
