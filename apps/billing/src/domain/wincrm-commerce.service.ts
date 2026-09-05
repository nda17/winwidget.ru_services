import {
	Injectable,
	ForbiddenException,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	type CrmCommerceCommand as StoredCommand,
	type CrmPaidPeriod,
	type CrmOrder
} from '@prisma/billing-client';
import { randomUUID } from 'node:crypto';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { PaymentMethodCryptoService } from '../provider/payment-method-crypto.service';
import { wincrmPaymentsEnabled } from '../provider/wincrm-provider.config';
import {
	billingCommandRequestHash,
	assertBillingCommandReceipt,
	lockBillingCommand
} from './billing-command-idempotency';
import { requireCrmCommercialPolicy } from './crm-commercial-policy.service';
import {
	enqueueBillingAdminAudit,
	type BillingAdminActor
} from './billing-admin-audit';
import { calculateWincrmSeatDuration } from './wincrm-seat-duration';
import {
	WINCRM_PROVIDER_EVENT_TYPE,
	WINCRM_PROVIDER_CONSUMER,
	WincrmProviderResponseError
} from './wincrm-commerce.contract';
import type {
	WincrmCommerceContext,
	WincrmCommerceCommand,
	WincrmCheckoutCommand,
	WincrmSeatChangeCommand,
	WincrmDisableRenewalCommand,
	WincrmConfirmRenewalCommand,
	WincrmQuoteRequest,
	WincrmCommerceQuote,
	WincrmCommerceSummary,
	WincrmCommerceCommandProof,
	WincrmCommandStatusRequest,
	WincrmCloseCommand,
	WincrmOrderRequest,
	WincrmVerifyOrderCommand,
	WincrmHistoryRequest,
	WincrmCapacityFence,
	WincrmProviderEvent,
	WincrmProviderClaim,
	WincrmProviderClaimResult,
	WincrmPreparedProviderOperation,
	WincrmProviderFailure
} from './wincrm-commerce.contract';
import {
	WINCRM_CONSENT_TEXT,
	WINCRM_CONSENT_VERSION,
	WINCRM_DAY_MS,
	WINCRM_HASH,
	commerceConflict,
	commerceInvalid,
	commerceRecord,
	commerceText,
	commerceUuid,
	commerceVersion,
	commerceInt,
	commerceCycle,
	wincrmCommerceRequestHash,
	wincrmProviderKey,
	wincrmPriceSnapshot,
	readWincrmPriceSnapshot,
	wincrmPrice,
	wincrmDecimal,
	wincrmPeriodEnd,
	wincrmPeriodView,
	wincrmOrderView,
	wincrmRenewalView
} from './wincrm-commerce.helpers';

type Tx = Prisma.TransactionClient;
const LEASE_MS = 60_000;
const PROVIDER_WINDOW_MS = 23 * 60 * 60 * 1000;
const json = (value: unknown) => value as Prisma.InputJsonValue;

@Injectable()
export class WincrmCommerceService {
	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly crypto: PaymentMethodCryptoService
	) {}

	async summary(
		dto: WincrmCommerceContext
	): Promise<WincrmCommerceSummary> {
		this.context(dto);
		const [account, policy, trial, period, pending, renewal] =
			await Promise.all([
				this.prisma.crmCommerceAccount.findUnique({
					where: { workspaceId: dto.workspaceId }
				}),
				requireCrmCommercialPolicy(this.prisma),
				this.prisma.crmEntitlement.findUnique({
					where: { workspaceId: dto.workspaceId }
				}),
				this.latestPeriod(this.prisma, dto.workspaceId),
				this.prisma.crmOrder.findFirst({
					where: {
						workspaceId: dto.workspaceId,
						status: { in: ['PENDING', 'UNKNOWN'] }
					},
					orderBy: { createdAt: 'desc' },
					include: { period: true }
				}),
				this.prisma.crmAutoRenewal.findUnique({
					where: { workspaceId: dto.workspaceId }
				})
			]);
		this.owner(account, dto);
		const now = new Date();
		return {
			schemaVersion: 1,
			workspaceId: dto.workspaceId,
			billingVersion: account?.version.toString() ?? '0',
			serverTime: now.toISOString(),
			policy: wincrmPriceSnapshot(policy),
			trial:
				trial?.trialStartedAt && trial.planCode === 'TRIAL'
					? {
							startsAt: trial.trialStartedAt.toISOString(),
							expiresAt: trial.effectiveUntil.toISOString(),
							seatLimit: trial.seatLimit!
						}
					: null,
			period: period ? wincrmPeriodView(period, now) : null,
			pendingOrder: pending
				? wincrmOrderView(pending, pending.period, now)
				: null,
			renewal: wincrmRenewalView(renewal)
		};
	}

	async quote(dto: WincrmQuoteRequest): Promise<WincrmCommerceQuote> {
		this.context(dto);
		if (
			!['CHECKOUT', 'SEAT_CHANGE', 'RENEWAL'].includes(dto.intent) ||
			!commerceCycle(dto.cycle) ||
			!commerceInt(dto.totalSeats, 2, 10000)
		)
			commerceInvalid();
		const summary = await this.summary(dto);
		const now = new Date();
		const current = await this.latestPeriod(this.prisma, dto.workspaceId);
		let snapshot = summary.policy;
		let startsAt = now;
		let expiresAt: Date;
		let period: WincrmCommerceQuote['period'] = null;
		if (dto.intent === 'SEAT_CHANGE') {
			if (
				!current ||
				current.startsAt > now ||
				current.expiresAt <= now ||
				current.cycle !== dto.cycle
			)
				commerceConflict('wincrm_paid_period_required');
			snapshot = readWincrmPriceSnapshot(current.priceSnapshot);
			const conversion = this.convert(current, dto.totalSeats, now);
			startsAt = current.startsAt;
			expiresAt = new Date(conversion.expiresAtMs);
			period = {
				id: current.id,
				version: current.version,
				oldTotalSeats: current.totalSeats,
				oldExpiresAt: current.expiresAt.toISOString(),
				oldPeriodPriceMinor: conversion.oldPeriodPriceMinor.toString(),
				newPeriodPriceMinor: conversion.newPeriodPriceMinor.toString()
			};
		} else {
			if (
				dto.intent === 'CHECKOUT' &&
				(summary.pendingOrder || (current && current.expiresAt > now))
			)
				commerceConflict('wincrm_checkout_not_available');
			if (dto.intent === 'RENEWAL') {
				const renewal = await this.prisma.crmAutoRenewal.findUnique({
					where: { workspaceId: dto.workspaceId }
				});
				if (
					!renewal ||
					renewal.cycle !== dto.cycle ||
					renewal.totalSeats !== dto.totalSeats
				)
					commerceConflict('wincrm_renewal_not_available');
				startsAt = new Date(
					Math.max(now.getTime(), current?.expiresAt.getTime() ?? 0)
				);
			} else if (summary.trial)
				startsAt = new Date(
					Math.max(now.getTime(), Date.parse(summary.trial.expiresAt))
				);
			expiresAt = wincrmPeriodEnd(startsAt, dto.cycle);
		}
		return {
			schemaVersion: 1,
			workspaceId: dto.workspaceId,
			billingVersion: summary.billingVersion,
			serverTime: now.toISOString(),
			validUntil: new Date(now.getTime() + 30_000).toISOString(),
			intent: dto.intent,
			cycle: dto.cycle,
			totalSeats: dto.totalSeats,
			amountMinor: wincrmPrice(
				snapshot,
				dto.cycle,
				dto.totalSeats
			).toString(),
			currency: 'RUB',
			priceSnapshot: snapshot,
			startsAt: startsAt.toISOString(),
			expiresAt: expiresAt.toISOString(),
			period,
			consent: {
				version: WINCRM_CONSENT_VERSION,
				text: WINCRM_CONSENT_TEXT
			}
		};
	}

	async checkout(dto: WincrmCheckoutCommand) {
		this.command(dto);
		if (
			!commerceCycle(dto.cycle) ||
			!commerceInt(dto.totalSeats, 2, 10000) ||
			!commerceInt(dto.expectedPolicyVersion, 1, 2147483646) ||
			typeof dto.autoRenew !== 'boolean' ||
			(dto.autoRenew
				? dto.consentVersion !== WINCRM_CONSENT_VERSION
				: dto.consentVersion !== null)
		)
			commerceInvalid();
		const type = 'WINCRM_CHECKOUT',
			hash = wincrmCommerceRequestHash(type, dto);
		this.fence(dto.capacityFence, dto.commandId, hash, dto.totalSeats);
		return this.transaction(dto.workspaceId, dto.commandId, async tx => {
			const replay = await this.replay(tx, dto, type, hash);
			if (replay) return replay;
			this.requireEnabled();
			const account = await this.accountForCommand(tx, dto);
			const now = new Date();
			const [policy, period, pending, identity] = await Promise.all([
				requireCrmCommercialPolicy(tx),
				this.latestPeriod(tx, dto.workspaceId),
				tx.crmOrder.findFirst({
					where: {
						workspaceId: dto.workspaceId,
						status: { in: ['PENDING', 'UNKNOWN'] }
					}
				}),
				tx.identityContactProjection.findUnique({
					where: { userId: dto.actorSubject }
				})
			]);
			if (policy.version !== dto.expectedPolicyVersion)
				commerceConflict('wincrm_policy_version_conflict');
			if (pending || (period && period.expiresAt > now))
				commerceConflict('wincrm_checkout_not_available');
			if (
				!identity ||
				identity.status !== 'ACTIVE' ||
				identity.tombstone ||
				identity.deletedAt ||
				(!identity.email && !identity.phone)
			)
				commerceConflict('wincrm_billing_contact_required');
			const snapshot = wincrmPriceSnapshot(policy);
			const orderId = randomUUID();
			const order = await tx.crmOrder.create({
				data: {
					id: orderId,
					workspaceId: dto.workspaceId,
					ownerSubject: dto.actorSubject,
					commandId: dto.commandId,
					capacityCommandId: dto.commandId,
					capacityFence: json(dto.capacityFence),
					kind: 'ONE_TIME',
					cycle: dto.cycle,
					totalSeats: dto.totalSeats,
					amountMinor: wincrmPrice(snapshot, dto.cycle, dto.totalSeats),
					priceSnapshot: json(snapshot),
					policyVersion: policy.version,
					autoRenew: dto.autoRenew,
					consentVersion: dto.consentVersion,
					consentText: dto.autoRenew ? WINCRM_CONSENT_TEXT : null,
					consentedAt: dto.autoRenew ? now : null,
					customerEmail: identity.email,
					customerPhone: identity.phone,
					providerIdempotencyKey: wincrmProviderKey('checkout', orderId),
					checkoutExpiresAt: new Date(now.getTime() + 3600000)
				}
			});
			await tx.crmCommerceCommand.create({
				data: {
					commandId: dto.commandId,
					workspaceId: dto.workspaceId,
					actorSubject: dto.actorSubject,
					commandType: type,
					requestHash: hash,
					expectedVersion: BigInt(dto.expectedBillingVersion),
					capacityFence: json(dto.capacityFence),
					orderId: order.id
				}
			});
			await tx.crmCommerceAccount.update({
				where: { workspaceId: dto.workspaceId },
				data: { version: account.version + 1n }
			});
			await this.enqueue(
				tx,
				order,
				'CREATE',
				order.providerIdempotencyKey
			);
			return this.proof(
				tx,
				dto.workspaceId,
				dto.commandId,
				hash,
				dto.actorSubject
			);
		});
	}

	async changeSeats(dto: WincrmSeatChangeCommand) {
		this.command(dto);
		if (
			!commerceUuid(dto.expectedPeriodId) ||
			!commerceInt(dto.expectedPeriodVersion, 1, 2147483646) ||
			!commerceInt(dto.newTotalSeats, 2, 10000)
		)
			commerceInvalid();
		const type = 'WINCRM_SEAT_CHANGE',
			hash = wincrmCommerceRequestHash(type, dto);
		this.fence(dto.capacityFence, dto.commandId, hash, dto.newTotalSeats);
		return this.transaction(dto.workspaceId, dto.commandId, async tx => {
			const replay = await this.replay(tx, dto, type, hash);
			if (replay) return replay;
			this.requireEnabled();
			const account = await this.accountForCommand(tx, dto);
			const now = new Date(),
				current = await this.latestPeriod(tx, dto.workspaceId);
			if (
				!current ||
				current.id !== dto.expectedPeriodId ||
				current.version !== dto.expectedPeriodVersion
			)
				commerceConflict('wincrm_period_version_conflict');
			const renewal = await tx.crmAutoRenewal.findUnique({
				where: { workspaceId: dto.workspaceId }
			});
			if (
				renewal?.dispatchPending ||
				(await tx.crmOrder.count({
					where: {
						workspaceId: dto.workspaceId,
						status: { in: ['PENDING', 'UNKNOWN'] }
					}
				}))
			)
				commerceConflict('wincrm_provider_operation_pending');
			const conversion = this.convert(current, dto.newTotalSeats, now);
			const snapshot = readWincrmPriceSnapshot(current.priceSnapshot),
				expiresAt = new Date(conversion.expiresAtMs);
			await tx.crmPaidPeriod.update({
				where: { id: current.id, version: current.version },
				data: {
					totalSeats: dto.newTotalSeats,
					expiresAt,
					graceUntil: new Date(
						expiresAt.getTime() + snapshot.graceDays * WINCRM_DAY_MS
					),
					version: { increment: 1 }
				}
			});
			await tx.crmCommerceAccount.update({
				where: { workspaceId: dto.workspaceId },
				data: {
					version: account.version + 1n,
					capacityCommandId: dto.commandId,
					capacityFence: json(dto.capacityFence)
				}
			});
			if (renewal) {
				const updated = await tx.crmAutoRenewal.update({
					where: { workspaceId: dto.workspaceId },
					data: {
						totalSeats: dto.newTotalSeats,
						amountMinor: wincrmPrice(
							readWincrmPriceSnapshot(renewal.priceSnapshot),
							renewal.cycle as 'MONTHLY' | 'YEARLY',
							dto.newTotalSeats
						),
						nextChargeAt: expiresAt,
						retryStartedAt: null,
						nextRetryAt: null,
						retryAttempt: 0,
						version: { increment: 1 }
					}
				});
				await this.consent(
					tx,
					updated,
					dto.actorSubject,
					dto.commandId,
					'SEATS_CHANGED',
					{
						beforeSeats: current.totalSeats,
						afterSeats: dto.newTotalSeats,
						oldExpiresAt: current.expiresAt.toISOString(),
						newExpiresAt: expiresAt.toISOString()
					}
				);
			}
			await this.commitCommand(
				tx,
				dto,
				type,
				hash,
				account.version + 1n,
				current.id,
				dto.capacityFence
			);
			await this.entitlementWake(tx, dto.workspaceId);
			return this.proof(
				tx,
				dto.workspaceId,
				dto.commandId,
				hash,
				dto.actorSubject
			);
		});
	}

	async disableRenewal(dto: WincrmDisableRenewalCommand) {
		return this.renewalCommand(dto, false);
	}
	async confirmRenewal(dto: WincrmConfirmRenewalCommand) {
		return this.renewalCommand(dto, true);
	}
	private async renewalCommand(
		dto: WincrmDisableRenewalCommand | WincrmConfirmRenewalCommand,
		confirm: boolean
	) {
		this.command(dto);
		if (!commerceInt(dto.expectedRenewalVersion, 1, 2147483646))
			commerceInvalid();
		const type = confirm
				? 'WINCRM_CONFIRM_RENEWAL'
				: 'WINCRM_DISABLE_RENEWAL',
			hash = wincrmCommerceRequestHash(type, dto);
		return this.transaction(dto.workspaceId, dto.commandId, async tx => {
			const replay = await this.replay(tx, dto, type, hash);
			if (replay) return replay;
			if (confirm) this.requireEnabled();
			const account = await this.accountForCommand(tx, dto),
				renewal = await tx.crmAutoRenewal.findUnique({
					where: { workspaceId: dto.workspaceId }
				});
			if (!renewal || renewal.version !== dto.expectedRenewalVersion)
				commerceConflict('wincrm_renewal_version_conflict');
			let data: Prisma.CrmAutoRenewalUpdateInput = {
				status: 'USER_DISABLED',
				disabledAt: new Date(),
				version: { increment: 1 }
			};
			if (confirm) {
				const input = dto as WincrmConfirmRenewalCommand,
					policy = await requireCrmCommercialPolicy(tx),
					snapshot = wincrmPriceSnapshot(policy);
				if (
					policy.version !== input.expectedPolicyVersion ||
					input.consentVersion !== WINCRM_CONSENT_VERSION ||
					renewal.status !== 'PRICE_CONFIRMATION_REQUIRED' ||
					renewal.dispatchPending
				)
					commerceConflict('wincrm_renewal_confirmation_conflict');
				data = {
					status: 'ACTIVE',
					amountMinor: wincrmPrice(
						snapshot,
						renewal.cycle as 'MONTHLY' | 'YEARLY',
						renewal.totalSeats
					),
					priceSnapshot: json(snapshot),
					consentVersion: WINCRM_CONSENT_VERSION,
					consentText: WINCRM_CONSENT_TEXT,
					consentedAt: new Date(),
					disabledAt: null,
					lastErrorCode: null,
					version: { increment: 1 }
				};
			}
			const updated = await tx.crmAutoRenewal.update({
				where: { workspaceId: dto.workspaceId },
				data
			});
			await this.consent(
				tx,
				updated,
				dto.actorSubject,
				dto.commandId,
				confirm ? 'PRICE_CONFIRMED' : 'DISABLED',
				{
					previousVersion: renewal.version,
					previousAmountMinor: renewal.amountMinor.toString(),
					nextAmountMinor: updated.amountMinor.toString(),
					dispatchPending: renewal.dispatchPending,
					consentVersion: updated.consentVersion,
					consentText: updated.consentText
				}
			);
			await tx.crmCommerceAccount.update({
				where: { workspaceId: dto.workspaceId },
				data: { version: account.version + 1n }
			});
			await this.commitCommand(tx, dto, type, hash, account.version + 1n);
			return this.proof(
				tx,
				dto.workspaceId,
				dto.commandId,
				hash,
				dto.actorSubject
			);
		});
	}

	async order(dto: WincrmOrderRequest) {
		this.context(dto);
		if (!commerceUuid(dto.orderId)) commerceInvalid();
		const row = await this.prisma.crmOrder.findFirst({
			where: {
				id: dto.orderId,
				workspaceId: dto.workspaceId,
				ownerSubject: dto.actorSubject
			},
			include: { period: true }
		});
		if (!row) throw new NotFoundException('WinCRM order not found');
		const now = new Date();
		return {
			schemaVersion: 1,
			workspaceId: dto.workspaceId,
			serverTime: now.toISOString(),
			order: wincrmOrderView(row, row.period, now)
		};
	}
	async verifyOrder(dto: WincrmVerifyOrderCommand) {
		this.command(dto);
		if (
			!commerceUuid(dto.orderId) ||
			!commerceInt(dto.expectedOrderVersion, 1, 2147483646)
		)
			commerceInvalid();
		const type = 'WINCRM_VERIFY_ORDER',
			hash = wincrmCommerceRequestHash(type, dto);
		return this.transaction(dto.workspaceId, dto.commandId, async tx => {
			const prior = await this.replay(tx, dto, type, hash);
			if (prior) return prior;
			const account = await this.accountForCommand(tx, dto);
			const order = await tx.crmOrder.findFirst({
				where: {
					id: dto.orderId,
					workspaceId: dto.workspaceId,
					ownerSubject: dto.actorSubject
				}
			});
			if (!order) throw new NotFoundException('WinCRM order not found');
			if (order.version !== dto.expectedOrderVersion)
				commerceConflict('wincrm_order_version_conflict');
			if (
				!order.providerPaymentId ||
				!['PENDING', 'UNKNOWN'].includes(order.status)
			)
				commerceConflict('wincrm_order_verification_unavailable');
			await this.enqueue(
				tx,
				order,
				'VERIFY',
				wincrmProviderKey('manual-verify', dto.commandId),
				order.providerPaymentId
			);
			await tx.crmCommerceAccount.update({
				where: { workspaceId: dto.workspaceId },
				data: { version: account.version + 1n }
			});
			await this.commitCommand(
				tx,
				dto,
				type,
				hash,
				account.version + 1n,
				undefined,
				undefined,
				order.id
			);
			return this.proof(
				tx,
				dto.workspaceId,
				dto.commandId,
				hash,
				dto.actorSubject
			);
		});
	}
	async history(dto: WincrmHistoryRequest) {
		this.context(dto);
		if (
			!commerceInt(dto.page, 1, 1000000) ||
			!commerceInt(dto.pageSize, 1, 100)
		)
			commerceInvalid();
		const where = {
			workspaceId: dto.workspaceId,
			ownerSubject: dto.actorSubject
		};
		const [items, total] = await this.prisma.$transaction([
			this.prisma.crmOrder.findMany({
				where,
				skip: (dto.page - 1) * dto.pageSize,
				take: dto.pageSize,
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
				include: { period: true }
			}),
			this.prisma.crmOrder.count({ where })
		]);
		const now = new Date();
		return {
			schemaVersion: 1,
			workspaceId: dto.workspaceId,
			page: dto.page,
			pageSize: dto.pageSize,
			total,
			items: items.map(item => wincrmOrderView(item, item.period, now))
		};
	}
	async commandStatus(dto: WincrmCommandStatusRequest) {
		this.context(dto);
		if (!commerceUuid(dto.commandId) || !WINCRM_HASH.test(dto.requestHash))
			commerceInvalid();
		return this.proof(
			this.prisma,
			dto.workspaceId,
			dto.commandId,
			dto.requestHash,
			dto.actorSubject
		);
	}
	async closeCommand(dto: WincrmCloseCommand) {
		this.context(dto);
		if (
			!commerceUuid(dto.commandId) ||
			!WINCRM_HASH.test(dto.requestHash) ||
			!['WINCRM_CHECKOUT', 'WINCRM_SEAT_CHANGE'].includes(dto.commandType)
		)
			commerceInvalid();
		this.fence(
			dto.capacityFence,
			dto.commandId,
			dto.requestHash,
			dto.capacityFence?.targetSeats
		);
		return this.transaction(dto.workspaceId, dto.commandId, async tx => {
			const current = await tx.crmCommerceCommand.findUnique({
				where: { commandId: dto.commandId }
			});
			if (!current) {
				if (
					await tx.billingCommandReceipt.findUnique({
						where: { commandId: dto.commandId }
					})
				)
					commerceConflict('wincrm_command_conflict');
				await tx.crmCommerceCommand.create({
					data: {
						commandId: dto.commandId,
						workspaceId: dto.workspaceId,
						actorSubject: dto.actorSubject,
						commandType: dto.commandType,
						requestHash: dto.requestHash,
						expectedVersion: 0n,
						capacityFence: json(dto.capacityFence),
						status: 'CANCELLED'
					}
				});
			} else {
				this.matchCommand(
					current,
					dto.workspaceId,
					dto.actorSubject,
					dto.requestHash
				);
				if (current.status === 'PENDING' && current.orderId) {
					const dispatched = await tx.crmProviderOperation.count({
						where: {
							orderId: current.orderId,
							OR: [
								{ firstDispatchAt: { not: null } },
								{ status: 'PROCESSING' }
							]
						}
					});
					if (!dispatched) {
						await tx.crmOrder.updateMany({
							where: { id: current.orderId, status: 'PENDING' },
							data: {
								status: 'CANCELLED',
								cancellationReason: 'USER_CANCELLED_BEFORE_DISPATCH',
								version: { increment: 1 }
							}
						});
						await tx.crmCommerceCommand.update({
							where: { commandId: current.commandId },
							data: { status: 'CANCELLED' }
						});
					}
				}
			}
			return this.proof(
				tx,
				dto.workspaceId,
				dto.commandId,
				dto.requestHash,
				dto.actorSubject
			);
		});
	}

	private context(dto: WincrmCommerceContext) {
		if (
			dto.schemaVersion !== 1 ||
			!commerceUuid(dto.workspaceId) ||
			!commerceText(dto.actorSubject, 256) ||
			/\s/u.test(dto.actorSubject)
		)
			commerceInvalid();
	}
	private command(dto: WincrmCommerceCommand) {
		this.context(dto);
		if (
			!commerceUuid(dto.commandId) ||
			!commerceVersion(dto.expectedBillingVersion)
		)
			commerceInvalid();
	}
	private fence(
		value: WincrmCapacityFence,
		commandId: string,
		hash: string,
		seats: number
	) {
		if (
			!commerceRecord(value) ||
			Object.keys(value).length !== 4 ||
			value.operationId !== commandId ||
			value.requestHash !== hash ||
			!commerceInt(value.fenceRevision, 1, 2147483646) ||
			value.targetSeats !== seats ||
			!commerceInt(seats, 2, 10000)
		)
			commerceInvalid();
	}
	private owner(
		account: { ownerSubject: string } | null,
		dto: WincrmCommerceContext
	) {
		if (account && account.ownerSubject !== dto.actorSubject)
			commerceConflict('wincrm_owner_binding_conflict');
	}
	private requireEnabled() {
		if (!wincrmPaymentsEnabled())
			throw new ServiceUnavailableException({
				code: 'wincrm_payments_disabled',
				message: 'Оплата WinCRM временно недоступна'
			});
	}
	private async transaction<T>(
		workspaceId: string,
		commandId: string | null,
		work: (tx: Tx) => Promise<T>
	): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
						await tx.$executeRaw`SET LOCAL statement_timeout = '20s'`;
						if (commandId) await lockBillingCommand(tx, commandId);
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-wincrm-entitlement:${workspaceId}`}, 0))`;
						const result = await work(tx);
						// Surface deferred constraints before Prisma's implicit COMMIT.
						await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5000,
						timeout: 25000
					}
				);
			} catch (error) {
				if (
					attempt >= 2 ||
					!['P2034'].includes((error as { code?: string }).code ?? '')
				)
					throw error;
			}
		}
	}
	private async accountForCommand(tx: Tx, dto: WincrmCommerceCommand) {
		const current = await tx.crmCommerceAccount.findUnique({
			where: { workspaceId: dto.workspaceId }
		});
		this.owner(current, dto);
		if ((current?.version ?? 0n) !== BigInt(dto.expectedBillingVersion))
			commerceConflict('wincrm_billing_version_conflict');
		return (
			current ??
			tx.crmCommerceAccount.create({
				data: {
					workspaceId: dto.workspaceId,
					ownerSubject: dto.actorSubject,
					version: 1n
				}
			})
		);
	}
	private latestPeriod(
		tx: Pick<Tx, 'crmPaidPeriod'>,
		workspaceId: string
	) {
		return tx.crmPaidPeriod.findFirst({
			where: { workspaceId },
			orderBy: [{ startsAt: 'desc' }, { id: 'desc' }]
		});
	}
	private convert(
		period: CrmPaidPeriod,
		newTotalSeats: number,
		now: Date
	) {
		return calculateWincrmSeatDuration({
			nowMs: now.getTime(),
			newTotalSeats,
			period: {
				kind: 'PAID',
				status: 'ACTIVE',
				cycle: period.cycle as 'MONTHLY' | 'YEARLY',
				startsAtMs: period.startsAt.getTime(),
				expiresAtMs: period.expiresAt.getTime(),
				totalSeats: period.totalSeats,
				priceSnapshot: readWincrmPriceSnapshot(period.priceSnapshot)
			}
		});
	}
	private matchCommand(
		row: StoredCommand,
		workspaceId: string,
		actor: string,
		hash: string
	) {
		if (
			row.workspaceId !== workspaceId ||
			row.actorSubject !== actor ||
			row.requestHash !== hash
		)
			commerceConflict('wincrm_command_conflict');
	}
	private async replay(
		tx: Tx,
		dto: WincrmCommerceCommand,
		type: string,
		hash: string
	) {
		const row = await tx.crmCommerceCommand.findUnique({
			where: { commandId: dto.commandId }
		});
		if (!row) {
			if (
				await tx.billingCommandReceipt.findUnique({
					where: { commandId: dto.commandId }
				})
			)
				commerceConflict('wincrm_command_conflict');
			return null;
		}
		this.matchCommand(row, dto.workspaceId, dto.actorSubject, hash);
		if (row.commandType !== type || row.status === 'CANCELLED')
			commerceConflict('wincrm_command_conflict');
		return this.proof(
			tx,
			dto.workspaceId,
			dto.commandId,
			hash,
			dto.actorSubject
		);
	}
	private async proof(
		tx: Pick<
			Tx,
			| 'crmCommerceCommand'
			| 'crmCommerceAccount'
			| 'crmOrder'
			| 'crmPaidPeriod'
		>,
		workspaceId: string,
		commandId: string,
		hash: string,
		actor: string
	): Promise<WincrmCommerceCommandProof> {
		const row = await tx.crmCommerceCommand.findUnique({
			where: { commandId }
		});
		if (!row) throw new NotFoundException('WinCRM command not found');
		this.matchCommand(row, workspaceId, actor, hash);
		const [account, order, period] = await Promise.all([
			tx.crmCommerceAccount.findUnique({ where: { workspaceId } }),
			row.orderId
				? tx.crmOrder.findUnique({ where: { id: row.orderId } })
				: null,
			row.periodId
				? tx.crmPaidPeriod.findUnique({ where: { id: row.periodId } })
				: null
		]);
		const now = new Date(),
			scheduled =
				row.status === 'COMMITTED' && period && period.startsAt > now;
		return {
			schemaVersion: 1,
			workspaceId,
			commandId,
			requestHash: hash,
			status: row.status as WincrmCommerceCommandProof['status'],
			billingVersion: (account?.version ?? 0n).toString(),
			releaseFence: row.status !== 'PENDING' && !scheduled,
			holdUntil: scheduled ? period.startsAt.toISOString() : null,
			order: order ? wincrmOrderView(order, period, now) : null,
			period: period ? wincrmPeriodView(period, now) : null
		};
	}
	private async commitCommand(
		tx: Tx,
		dto: WincrmCommerceCommand,
		type: string,
		hash: string,
		version: bigint,
		periodId?: string,
		capacityFence?: WincrmCapacityFence,
		orderId?: string
	) {
		await tx.crmCommerceCommand.create({
			data: {
				commandId: dto.commandId,
				workspaceId: dto.workspaceId,
				actorSubject: dto.actorSubject,
				commandType: type,
				requestHash: hash,
				expectedVersion: BigInt(dto.expectedBillingVersion),
				status: 'COMMITTED',
				resultVersion: version,
				periodId,
				orderId,
				...(capacityFence ? { capacityFence: json(capacityFence) } : {})
			}
		});
		await tx.billingCommandReceipt.create({
			data: {
				commandId: dto.commandId,
				commandType: type,
				requestHash: hash,
				requestHashVersion: 1,
				result: json({
					workspaceId: dto.workspaceId,
					status: 'COMMITTED',
					billingVersion: version.toString(),
					periodId: periodId ?? null
				})
			}
		});
	}
	private async consent(
		tx: Tx,
		renewal: { workspaceId: string; version: number },
		actor: string,
		commandId: string,
		eventType: string,
		evidence: unknown
	) {
		await tx.crmAutoRenewalConsent.create({
			data: {
				workspaceId: renewal.workspaceId,
				actorSubject: actor,
				commandId,
				eventType,
				renewalVersion: renewal.version,
				evidence: json(evidence)
			}
		});
	}

	private async enqueue(
		tx: Tx,
		order: CrmOrder,
		kind: string,
		key: string,
		providerPaymentId?: string,
		availableAt = new Date()
	) {
		const existing = await tx.crmProviderOperation.findUnique({
			where: { idempotencyKey: key }
		});
		if (existing) return existing;
		const renewal =
			kind === 'CREATE' && order.kind === 'RECURRING'
				? await tx.crmAutoRenewal.findUniqueOrThrow({
						where: { workspaceId: order.workspaceId }
					})
				: null;
		const id = randomUUID(),
			eventId = randomUUID(),
			outboxId = randomUUID();
		const operation = await tx.crmProviderOperation.create({
			data: {
				id,
				workspaceId: order.workspaceId,
				orderId: order.id,
				kind,
				idempotencyKey: key,
				providerPaymentId: providerPaymentId ?? null,
				pendingEventId: eventId,
				outboxId,
				availableAt,
				requestSnapshot: {
					orderId: order.id,
					workspaceId: order.workspaceId,
					kind,
					amountMinor: order.amountMinor.toString(),
					currency: 'RUB',
					providerKey: order.providerIdempotencyKey,
					returnUrl:
						kind === 'CREATE' && order.kind === 'ONE_TIME'
							? this.returnUrl(order)
							: null,
					paymentMethodCiphertext: renewal?.paymentMethodCiphertext ?? null
				}
			}
		});
		await this.providerOutbox(tx, id, eventId, outboxId, availableAt);
		return operation;
	}
	private async providerOutbox(
		tx: Tx,
		operationId: string,
		eventId: string,
		outboxId: string,
		availableAt: Date,
		deadLetter = false
	) {
		await tx.outboxEvent.create({
			data: {
				id: outboxId,
				eventId,
				messageId: eventId,
				deduplicationKey: `wincrm-provider:${operationId}:${eventId}`,
				eventType: WINCRM_PROVIDER_EVENT_TYPE,
				aggregateType: 'billing.wincrm-provider-operation',
				aggregateId: operationId,
				exchange: deadLetter
					? 'winwidget.billing.wincrm-provider.dead-letter'
					: 'winwidget.events',
				routingKey: WINCRM_PROVIDER_EVENT_TYPE,
				availableAt,
				payload: {
					schemaVersion: 1,
					eventType: WINCRM_PROVIDER_EVENT_TYPE,
					eventId,
					operationId
				}
			}
		});
	}

	async claimProviderOperation(
		event: WincrmProviderEvent
	): Promise<WincrmProviderClaimResult> {
		if (
			!commerceRecord(event) ||
			Object.keys(event).length !== 4 ||
			event.schemaVersion !== 1 ||
			event.eventType !== WINCRM_PROVIDER_EVENT_TYPE ||
			!commerceUuid(event.eventId) ||
			!commerceUuid(event.operationId)
		)
			throw new Error('INVALID_WINCRM_PROVIDER_EVENT');
		const operation = await this.prisma.crmProviderOperation.findUnique({
			where: { id: event.operationId }
		});
		if (!operation) throw new Error('WINCRM_PROVIDER_OPERATION_NOT_FOUND');
		const hash = billingCommandRequestHash('WINCRM_PROVIDER_EVENT', {
			...event
		});
		return this.transaction(operation.workspaceId, null, async tx => {
			const current = await tx.crmProviderOperation.findUniqueOrThrow({
				where: { id: operation.id }
			});
			const receipt = await tx.crmProviderDelivery.findUnique({
				where: {
					eventId_consumer: {
						eventId: event.eventId,
						consumer: WINCRM_PROVIDER_CONSUMER
					}
				}
			});
			if (
				receipt &&
				(receipt.payloadHash !== hash ||
					receipt.operationId !== current.id)
			)
				throw new Error('WINCRM_PROVIDER_EVENT_BINDING_CONFLICT');
			if (receipt && receipt.status !== 'PROCESSING')
				return { state: 'DONE' };
			const now = new Date();
			if (
				current.pendingEventId !== event.eventId ||
				['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(current.status)
			) {
				await tx.crmProviderDelivery.upsert({
					where: {
						eventId_consumer: {
							eventId: event.eventId,
							consumer: WINCRM_PROVIDER_CONSUMER
						}
					},
					create: {
						eventId: event.eventId,
						consumer: WINCRM_PROVIDER_CONSUMER,
						operationId: current.id,
						payloadHash: hash,
						status: 'DELIVERED'
					},
					update: {
						status: 'DELIVERED',
						leaseToken: null,
						leaseUntil: null,
						version: { increment: 1 }
					}
				});
				return { state: 'DONE' };
			}
			if (
				current.availableAt > now ||
				(current.status === 'PROCESSING' &&
					current.leaseUntil &&
					current.leaseUntil > now)
			)
				return { state: 'BUSY' };
			const token = randomUUID(),
				leaseUntil = new Date(now.getTime() + LEASE_MS);
			const claimed = await tx.crmProviderOperation.update({
				where: { id: current.id, version: current.version },
				data: {
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil,
					version: { increment: 1 }
				}
			});
			await tx.crmProviderDelivery.upsert({
				where: {
					eventId_consumer: {
						eventId: event.eventId,
						consumer: WINCRM_PROVIDER_CONSUMER
					}
				},
				create: {
					eventId: event.eventId,
					consumer: WINCRM_PROVIDER_CONSUMER,
					operationId: current.id,
					payloadHash: hash,
					leaseToken: token,
					leaseUntil
				},
				update: {
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil,
					version: { increment: 1 }
				}
			});
			return {
				state: 'CLAIMED',
				claim: {
					operationId: claimed.id,
					eventId: event.eventId,
					leaseToken: token,
					version: claimed.version
				}
			};
		});
	}

	async prepareProviderOperation(
		claim: WincrmProviderClaim
	): Promise<WincrmPreparedProviderOperation> {
		const operation = await this.prisma.crmProviderOperation.findUnique({
			where: { id: claim.operationId },
			include: { order: true }
		});
		if (!operation || !this.ownsLease(operation, claim))
			throw new Error('WINCRM_PROVIDER_LEASE_LOST');
		return this.prepared(this.prisma, operation);
	}
	async beginProviderDispatch(
		claim: WincrmProviderClaim
	): Promise<WincrmPreparedProviderOperation> {
		const initial =
			await this.prisma.crmProviderOperation.findUniqueOrThrow({
				where: { id: claim.operationId }
			});
		return this.transaction(initial.workspaceId, null, async tx => {
			const operation = await tx.crmProviderOperation.findUniqueOrThrow({
				where: { id: claim.operationId },
				include: { order: true }
			});
			if (!this.ownsLease(operation, claim))
				throw new Error('WINCRM_PROVIDER_LEASE_LOST');
			const prepared = await this.prepared(tx, operation);
			if (prepared.action !== 'CREATE') return prepared;
			const order = operation.order,
				now = new Date();
			const [account, command, renewal] = await Promise.all([
				tx.crmCommerceAccount.findUnique({
					where: { workspaceId: order.workspaceId }
				}),
				tx.crmCommerceCommand.findUnique({
					where: { commandId: order.capacityCommandId }
				}),
				tx.crmAutoRenewal.findUnique({
					where: { workspaceId: order.workspaceId }
				})
			]);
			const capacityMatches =
				!!command &&
				command.status !== 'CANCELLED' &&
				command.workspaceId === order.workspaceId &&
				command.actorSubject === order.ownerSubject &&
				JSON.stringify(command.capacityFence) ===
					JSON.stringify(order.capacityFence) &&
				(command.status === 'PENDING' ||
					account?.capacityCommandId === order.capacityCommandId);
			const renewalMatches =
				order.kind !== 'RECURRING' ||
				(!!renewal &&
					renewal.status === 'ACTIVE' &&
					renewal.dispatchPending &&
					renewal.version === order.expectedRenewalVersion &&
					renewal.ownerSubject === order.ownerSubject &&
					renewal.totalSeats === order.totalSeats &&
					renewal.amountMinor === order.amountMinor);
			if (
				!wincrmPaymentsEnabled() ||
				!capacityMatches ||
				!renewalMatches ||
				order.status !== 'PENDING' ||
				order.checkoutExpiresAt <= now
			) {
				if (operation.firstDispatchAt) {
					await tx.crmOrder.updateMany({
						where: { id: order.id, status: 'PENDING' },
						data: { status: 'UNKNOWN', version: { increment: 1 } }
					});
					await this.finish(
						tx,
						operation,
						claim,
						'UNKNOWN',
						'AUTHORIZATION_REVOKED'
					);
				} else {
					await this.cancelOrder(tx, order, 'DISPATCH_FENCED');
					await this.finish(
						tx,
						operation,
						claim,
						'FAILED',
						'AUTHORIZATION_REVOKED'
					);
				}
				return { action: 'SKIP' };
			}
			if (
				operation.firstDispatchAt &&
				now.getTime() - operation.firstDispatchAt.getTime() >=
					PROVIDER_WINDOW_MS
			) {
				await tx.crmOrder.update({
					where: { id: order.id },
					data: { status: 'UNKNOWN', version: { increment: 1 } }
				});
				await this.finish(
					tx,
					operation,
					claim,
					'UNKNOWN',
					'IDEMPOTENCY_WINDOW_EXPIRED'
				);
				return { action: 'SKIP' };
			}
			const changed = await tx.crmProviderOperation.update({
				where: {
					id: operation.id,
					version: claim.version,
					leaseToken: claim.leaseToken
				},
				data: {
					firstDispatchAt: operation.firstDispatchAt ?? now,
					dispatchAttempt: { increment: 1 }
				},
				include: { order: true }
			});
			return this.prepared(tx, changed);
		});
	}
	private ownsLease(
		operation: {
			status: string;
			version: number;
			leaseToken: string | null;
			leaseUntil: Date | null;
			pendingEventId: string;
		},
		claim: WincrmProviderClaim
	) {
		return (
			operation.status === 'PROCESSING' &&
			operation.version === claim.version &&
			operation.leaseToken === claim.leaseToken &&
			operation.pendingEventId === claim.eventId &&
			!!operation.leaseUntil &&
			operation.leaseUntil > new Date()
		);
	}
	private async prepared(
		_tx: Pick<Tx, 'crmAutoRenewal'>,
		operation: Prisma.CrmProviderOperationGetPayload<{
			include: { order: true };
		}>
	): Promise<WincrmPreparedProviderOperation> {
		const order = operation.order,
			snapshot = operation.requestSnapshot;
		if (
			!commerceRecord(snapshot) ||
			snapshot.orderId !== order.id ||
			snapshot.workspaceId !== order.workspaceId ||
			snapshot.amountMinor !== order.amountMinor.toString() ||
			snapshot.currency !== 'RUB' ||
			snapshot.providerKey !== order.providerIdempotencyKey ||
			snapshot.kind !== operation.kind
		)
			throw new Error('WINCRM_PROVIDER_REQUEST_BINDING_INVALID');
		const providerPaymentId =
			order.providerPaymentId ?? operation.providerPaymentId;
		const action =
			operation.kind === 'SYNC_RECEIPT'
				? 'SYNC_RECEIPT'
				: providerPaymentId
					? 'VERIFY'
					: operation.kind === 'CREATE'
						? 'CREATE'
						: null;
		if (!action) throw new Error('WINCRM_PROVIDER_ID_REQUIRED');
		const fence = order.capacityFence as unknown as WincrmCapacityFence;
		let request: Extract<
			WincrmPreparedProviderOperation,
			{ orderId: string }
		>['request'] = null;
		if (action === 'CREATE') {
			if (
				order.kind === 'ONE_TIME'
					? !commerceText(snapshot.returnUrl, 2048) ||
						snapshot.paymentMethodCiphertext !== null
					: snapshot.returnUrl !== null ||
						!commerceText(snapshot.paymentMethodCiphertext, 10000)
			)
				throw new Error('WINCRM_PROVIDER_REQUEST_BINDING_INVALID');
			request = {
				productCode: 'WINCRM',
				paymentId: order.id,
				plan: 'WINCRM',
				billingPeriod: order.cycle as 'MONTHLY' | 'YEARLY',
				kind: order.kind as 'ONE_TIME' | 'RECURRING',
				amount: wincrmDecimal(order.amountMinor),
				currency: 'RUB',
				autoRenew: order.autoRenew,
				customerEmail: order.customerEmail,
				customerPhone: order.customerPhone,
				returnUrl: snapshot.returnUrl as string | null,
				paymentMethodCiphertext: snapshot.paymentMethodCiphertext as
					| string
					| null
			};
		}
		return {
			action,
			orderId: order.id,
			workspaceId: order.workspaceId,
			ownerSubject: order.ownerSubject,
			commandId: order.capacityCommandId,
			capacityFence: fence,
			providerPaymentId,
			idempotencyKey: order.providerIdempotencyKey,
			request,
			firstDispatchAt: operation.firstDispatchAt?.toISOString() ?? null
		};
	}
	private returnUrl(order: CrmOrder) {
		const raw =
			process.env.BILLING_WINCRM_FRONTEND_ORIGIN ??
			'https://crm.winwidget.ru';
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error('WINCRM_FRONTEND_ORIGIN_INVALID');
		}
		if (
			!commerceText(raw, 2048) ||
			/\s|\\/u.test(raw) ||
			raw !== url.origin ||
			url.username ||
			url.password ||
			url.hash ||
			url.search ||
			url.pathname !== '/' ||
			!(
				url.protocol === 'https:' ||
				(url.protocol === 'http:' &&
					['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
			)
		)
			throw new Error('WINCRM_FRONTEND_ORIGIN_INVALID');
		url.pathname = '/billing/return';
		url.searchParams.set('workspaceId', order.workspaceId);
		url.searchParams.set('orderId', order.id);
		return url.toString();
	}
	private confirmationUrl(
		value: unknown,
		providerId: string
	): string | null {
		if (value === undefined || value === null) return null;
		if (
			!commerceText(value, 2048) ||
			/\s|\\|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
		)
			throw new WincrmProviderResponseError('PROVIDER_INVALID_RESPONSE');
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new WincrmProviderResponseError('PROVIDER_INVALID_RESPONSE');
		}
		if (
			url.protocol !== 'https:' ||
			url.hostname !== 'yoomoney.ru' ||
			url.port ||
			url.username ||
			url.password ||
			url.hash ||
			![
				'/checkout/payments/v2/contract',
				'/api-pages/v2/payment-confirm/epl'
			].includes(url.pathname) ||
			url.searchParams.getAll('orderId').length !== 1 ||
			url.searchParams.get('orderId') !== providerId ||
			[...url.searchParams.keys()].some(key => key !== 'orderId')
		)
			throw new WincrmProviderResponseError('PROVIDER_INVALID_RESPONSE');
		return value;
	}

	async settleProviderOperation(
		claim: WincrmProviderClaim,
		value: unknown
	): Promise<void> {
		const initial =
			await this.prisma.crmProviderOperation.findUniqueOrThrow({
				where: { id: claim.operationId }
			});
		await this.transaction(initial.workspaceId, null, async tx => {
			const operation = await tx.crmProviderOperation.findUniqueOrThrow({
				where: { id: claim.operationId },
				include: { order: true }
			});
			if (!this.ownsLease(operation, claim))
				throw new Error('WINCRM_PROVIDER_LEASE_LOST');
			const order = operation.order;
			if (operation.kind === 'SYNC_RECEIPT') {
				const state = await this.settleReceipts(tx, order, value);
				if (state === 'PENDING')
					await this.rescheduleReceipt(tx, operation, claim);
				else
					await this.finish(
						tx,
						operation,
						claim,
						state === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
						state === 'FAILED' ? 'PROVIDER_REJECTED' : null
					);
				return;
			}
			if (
				!commerceRecord(value) ||
				!this.providerId(value.id) ||
				!commerceRecord(value.metadata) ||
				value.metadata.productCode !== 'WINCRM' ||
				value.metadata.paymentId !== order.id ||
				value.metadata.plan !== 'WINCRM' ||
				value.metadata.billingPeriod !== order.cycle ||
				value.metadata.kind !== order.kind ||
				!commerceRecord(value.amount) ||
				value.amount.currency !== 'RUB' ||
				value.amount.value !== wincrmDecimal(order.amountMinor) ||
				(order.providerPaymentId &&
					value.id !== order.providerPaymentId) ||
				(operation.providerPaymentId &&
					value.id !== operation.providerPaymentId) ||
				![
					'pending',
					'waiting_for_capture',
					'succeeded',
					'canceled'
				].includes(value.status as string)
			)
				throw new WincrmProviderResponseError('PROVIDER_BINDING_MISMATCH');
			await tx.crmProviderOperation.update({
				where: { id: operation.id },
				data: { providerPaymentId: value.id }
			});
			if (value.status === 'succeeded') {
				if (value.paid !== true)
					throw new WincrmProviderResponseError(
						'PROVIDER_INVALID_RESPONSE'
					);
				await this.fulfill(tx, order, value);
				await this.finish(tx, operation, claim, 'SUCCEEDED');
				await this.enqueue(
					tx,
					order,
					'SYNC_RECEIPT',
					wincrmProviderKey('receipt', order.id, value.id),
					value.id
				);
				return;
			}
			if (value.status === 'canceled') {
				if (order.status !== 'SUCCEEDED') {
					await tx.crmOrder.update({
						where: { id: order.id },
						data: {
							providerPaymentId: value.id,
							providerStatus: 'canceled',
							version: { increment: 1 }
						}
					});
					const details = commerceRecord(value.cancellation_details)
						? value.cancellation_details
						: {};
					const reason = commerceText(details.reason, 128)
						? details.reason
						: 'PROVIDER_CANCELLED';
					await this.cancelOrder(tx, order, reason);
				}
				await this.finish(tx, operation, claim, 'SUCCEEDED');
				return;
			}
			if (order.status !== 'SUCCEEDED') {
				const confirmation = commerceRecord(value.confirmation)
					? value.confirmation
					: {};
				await tx.crmOrder.update({
					where: { id: order.id },
					data: {
						providerPaymentId: value.id,
						providerStatus: value.status as string,
						confirmationUrl: this.confirmationUrl(
							confirmation.confirmation_url,
							value.id
						),
						status: 'PENDING',
						version: { increment: 1 }
					}
				});
			}
			await this.finish(tx, operation, claim, 'SUCCEEDED');
			await this.enqueue(
				tx,
				order,
				'VERIFY',
				wincrmProviderKey('poll', operation.id, value.id),
				value.id,
				new Date(Date.now() + 30_000)
			);
		});
	}

	async failProviderOperation(
		claim: WincrmProviderClaim,
		failure: WincrmProviderFailure
	): Promise<void> {
		const initial =
			await this.prisma.crmProviderOperation.findUniqueOrThrow({
				where: { id: claim.operationId }
			});
		await this.transaction(initial.workspaceId, null, async tx => {
			const operation = await tx.crmProviderOperation.findUniqueOrThrow({
				where: { id: claim.operationId },
				include: { order: true }
			});
			if (!this.ownsLease(operation, claim))
				throw new Error('WINCRM_PROVIDER_LEASE_LOST');
			const providerId = this.providerId(failure.providerPaymentId)
				? failure.providerPaymentId
				: (operation.providerPaymentId ??
					operation.order.providerPaymentId);
			if (
				providerId &&
				operation.order.providerPaymentId &&
				providerId !== operation.order.providerPaymentId
			)
				throw new Error('WINCRM_PROVIDER_BINDING_MISMATCH');
			const ambiguous =
				failure.ambiguous || operation.firstDispatchAt !== null;
			const expired =
				!!operation.firstDispatchAt &&
				Date.now() - operation.firstDispatchAt.getTime() >=
					PROVIDER_WINDOW_MS;
			const retry =
				failure.retryable &&
				(!!providerId || operation.kind !== 'CREATE' || !expired);
			if (retry) {
				const eventId = randomUUID(),
					outboxId = randomUUID(),
					availableAt = new Date(
						Date.now() +
							Math.min(
								300_000,
								5000 * 2 ** Math.min(operation.retryAttempt, 6)
							)
					);
				await tx.crmProviderOperation.update({
					where: { id: operation.id, leaseToken: claim.leaseToken },
					data: {
						status: 'PENDING',
						leaseToken: null,
						leaseUntil: null,
						version: { increment: 1 },
						retryAttempt: { increment: 1 },
						availableAt,
						pendingEventId: eventId,
						outboxId,
						providerPaymentId: providerId,
						lastErrorCode: failure.code
					}
				});
				await tx.crmProviderDelivery.update({
					where: {
						eventId_consumer: {
							eventId: claim.eventId,
							consumer: WINCRM_PROVIDER_CONSUMER
						}
					},
					data: {
						status: 'RETRY_SCHEDULED',
						leaseToken: null,
						leaseUntil: null,
						version: { increment: 1 },
						lastErrorCode: failure.code
					}
				});
				await this.providerOutbox(
					tx,
					operation.id,
					eventId,
					outboxId,
					availableAt
				);
			} else {
				// Failed validation may retain a read-only provider hint on the operation,
				// never on the order's verified binding and never as proof of payment.
				if (providerId && !operation.providerPaymentId)
					await tx.crmProviderOperation.update({
						where: { id: operation.id, leaseToken: claim.leaseToken },
						data: { providerPaymentId: providerId }
					});
				if (
					operation.kind === 'CREATE' &&
					operation.order.status !== 'SUCCEEDED'
				) {
					if (ambiguous || providerId)
						await tx.crmOrder.update({
							where: { id: operation.orderId },
							data: { status: 'UNKNOWN', version: { increment: 1 } }
						});
					else await this.cancelOrder(tx, operation.order, failure.code);
				}
				await this.finish(
					tx,
					operation,
					claim,
					ambiguous ? 'UNKNOWN' : 'FAILED',
					failure.code
				);
			}
		});
	}
	private async finish(
		tx: Tx,
		operation: { id: string },
		claim: WincrmProviderClaim,
		status: string,
		error: string | null = null
	) {
		const changed = await tx.crmProviderOperation.updateMany({
			where: {
				id: operation.id,
				status: 'PROCESSING',
				version: claim.version,
				leaseToken: claim.leaseToken
			},
			data: {
				status,
				leaseToken: null,
				leaseUntil: null,
				version: { increment: 1 },
				lastErrorCode: error
			}
		});
		if (changed.count !== 1) throw new Error('WINCRM_PROVIDER_LEASE_LOST');
		await tx.crmProviderDelivery.update({
			where: {
				eventId_consumer: {
					eventId: claim.eventId,
					consumer: WINCRM_PROVIDER_CONSUMER
				}
			},
			data: {
				status: status === 'SUCCEEDED' ? 'DELIVERED' : 'DEAD_LETTERED',
				leaseToken: null,
				leaseUntil: null,
				version: { increment: 1 },
				lastErrorCode: error
			}
		});
		if (status !== 'SUCCEEDED')
			await this.providerOutbox(
				tx,
				operation.id,
				randomUUID(),
				randomUUID(),
				new Date(),
				true
			);
	}
	private providerId(value: unknown): value is string {
		return (
			typeof value === 'string' &&
			/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
		);
	}
	async enqueueProviderVerification(value: unknown): Promise<boolean> {
		if (
			!commerceRecord(value) ||
			![
				'payment.succeeded',
				'payment.canceled',
				'payment.waiting_for_capture'
			].includes(value.event as string) ||
			!commerceRecord(value.object) ||
			!this.providerId(value.object.id)
		)
			return false;
		const providerId = value.object.id,
			metadata = commerceRecord(value.object.metadata)
				? value.object.metadata
				: {};
		const candidate = await this.prisma.crmOrder.findFirst({
			where: {
				OR: [
					{ providerPaymentId: providerId },
					...(metadata.productCode === 'WINCRM' &&
					commerceUuid(metadata.paymentId)
						? [{ id: metadata.paymentId, providerPaymentId: null }]
						: [])
				]
			}
		});
		if (!candidate) return false;
		await this.transaction(candidate.workspaceId, null, async tx => {
			const current = await tx.crmOrder.findUniqueOrThrow({
				where: { id: candidate.id }
			});
			if (
				current.providerPaymentId &&
				current.providerPaymentId !== providerId
			)
				throw new Error('WINCRM_PROVIDER_BINDING_MISMATCH');
			await this.enqueue(
				tx,
				current,
				'VERIFY',
				wincrmProviderKey(
					'webhook',
					current.id,
					providerId,
					String(value.event)
				),
				providerId
			);
		});
		return true;
	}
	async retryProviderOperation(
		operationId: string,
		dto: { schemaVersion: 1; commandId: string; expectedVersion: number },
		actor: BillingAdminActor
	) {
		if (actor.role !== 'DEV')
			throw new ForbiddenException('WinCRM provider retry requires DEV');
		if (
			dto.schemaVersion !== 1 ||
			!commerceUuid(operationId) ||
			!commerceUuid(dto.commandId) ||
			!commerceInt(dto.expectedVersion, 1, 2147483646) ||
			!commerceText(actor.id, 256)
		)
			commerceInvalid();
		const initial = await this.prisma.crmProviderOperation.findUnique({
			where: { id: operationId }
		});
		if (!initial)
			throw new NotFoundException('WinCRM provider operation not found');
		const type = 'WINCRM_RETRY_PROVIDER',
			hash = billingCommandRequestHash(type, {
				...dto,
				operationId,
				actorId: actor.id
			});
		return this.transaction(
			initial.workspaceId,
			dto.commandId,
			async tx => {
				const prior = await tx.billingCommandReceipt.findUnique({
					where: { commandId: dto.commandId }
				});
				if (prior) return assertBillingCommandReceipt(prior, type, hash);
				if (
					await tx.crmCommerceCommand.findUnique({
						where: { commandId: dto.commandId }
					})
				)
					commerceConflict('wincrm_command_conflict');
				const operation = await tx.crmProviderOperation.findUniqueOrThrow({
					where: { id: operationId },
					include: { order: true }
				});
				if (operation.version !== dto.expectedVersion)
					commerceConflict('wincrm_provider_version_conflict');
				if (!['FAILED', 'UNKNOWN'].includes(operation.status))
					commerceConflict('wincrm_provider_retry_unavailable');
				const providerId =
					operation.order.providerPaymentId ?? operation.providerPaymentId;
				if (!providerId)
					commerceConflict('wincrm_provider_evidence_required');
				await tx.crmProviderOperation.update({
					where: { id: operationId, version: dto.expectedVersion },
					data: { version: { increment: 1 } }
				});
				const retry = await this.enqueue(
					tx,
					operation.order,
					operation.kind === 'SYNC_RECEIPT' ? 'SYNC_RECEIPT' : 'VERIFY',
					wincrmProviderKey('dev-retry', dto.commandId),
					providerId
				);
				const result = {
					schemaVersion: 1,
					operationId,
					retryOperationId: retry.id,
					eventId: retry.pendingEventId,
					state: 'QUEUED'
				};
				await tx.billingCommandReceipt.create({
					data: {
						commandId: dto.commandId,
						commandType: type,
						requestHash: hash,
						requestHashVersion: 1,
						result
					}
				});
				await enqueueBillingAdminAudit(tx, {
					actor,
					section: 'MESSAGING',
					action: 'BILLING_DELIVERY_RETRY',
					description: 'Повторная проверка операции провайдера WinCRM',
					entity: {
						type: 'crm_provider_operation',
						id: operationId,
						label: null,
						targetUserId: null
					},
					metadata: {
						retryOperationId: retry.id,
						previousState: operation.status,
						action: retry.kind
					}
				});
				return result;
			}
		);
	}

	private async fulfill(
		tx: Tx,
		order: CrmOrder,
		provider: Record<string, unknown>
	) {
		if (order.status === 'SUCCEEDED') return;
		const now = new Date(),
			account = await tx.crmCommerceAccount.findUniqueOrThrow({
				where: { workspaceId: order.workspaceId }
			});
		const [entitlement, previousPeriod] = await Promise.all([
			tx.crmEntitlement.findUnique({
				where: { workspaceId: order.workspaceId }
			}),
			this.latestPeriod(tx, order.workspaceId)
		]);
		if (previousPeriod && previousPeriod.expiresAt > now)
			throw new Error(
				'WINCRM_PAID_PERIOD_OVERLAP_REQUIRES_RECONCILIATION'
			);
		const snapshot = readWincrmPriceSnapshot(order.priceSnapshot);
		const startsAt = new Date(
			Math.max(
				now.getTime(),
				entitlement?.planCode === 'TRIAL'
					? entitlement.effectiveUntil.getTime()
					: 0
			)
		);
		const expiresAt = wincrmPeriodEnd(
			startsAt,
			order.cycle as 'MONTHLY' | 'YEARLY'
		);
		const paidAt =
			typeof provider.captured_at === 'string'
				? new Date(provider.captured_at)
				: now;
		if (
			!Number.isFinite(paidAt.getTime()) ||
			paidAt > new Date(now.getTime() + 60_000)
		)
			throw new WincrmProviderResponseError('PROVIDER_INVALID_RESPONSE');
		await tx.crmOrder.update({
			where: { id: order.id },
			data: {
				status: 'SUCCEEDED',
				providerStatus: 'succeeded',
				providerPaymentId: String(provider.id),
				confirmationUrl: null,
				succeededAt: paidAt,
				cancellationReason: null,
				version: { increment: 1 }
			}
		});
		const period = await tx.crmPaidPeriod.create({
			data: {
				workspaceId: order.workspaceId,
				orderId: order.id,
				cycle: order.cycle,
				totalSeats: order.totalSeats,
				originalSeats: order.totalSeats,
				priceSnapshot: order.priceSnapshot as Prisma.InputJsonValue,
				startsAt,
				expiresAt,
				originalExpiresAt: expiresAt,
				graceUntil: new Date(
					expiresAt.getTime() + snapshot.graceDays * WINCRM_DAY_MS
				)
			}
		});
		if (!entitlement)
			await tx.crmEntitlement.create({
				data: {
					workspaceId: order.workspaceId,
					productCode: 'WINCRM',
					planCode: 'PAID',
					seatLimit: order.totalSeats,
					policyVersion: order.policyVersion,
					effectiveFrom: startsAt,
					effectiveUntil: expiresAt,
					graceUntil: period.graceUntil,
					provisioningCommandId: order.commandId,
					provisioningCommandType: 'ACTIVATE_WINCRM_PAID',
					activatedByUserId: order.ownerSubject,
					sourceSequence: await this.nextSequence(tx)
				}
			});
		await tx.crmCommerceAccount.update({
			where: { workspaceId: order.workspaceId },
			data: {
				version: account.version + 1n,
				capacityCommandId: order.capacityCommandId,
				capacityFence: order.capacityFence as Prisma.InputJsonValue
			}
		});
		if (order.kind === 'ONE_TIME') {
			const command = await tx.crmCommerceCommand.findUniqueOrThrow({
				where: { commandId: order.commandId }
			});
			await tx.crmCommerceCommand.update({
				where: { commandId: order.commandId },
				data: {
					status: 'COMMITTED',
					periodId: period.id,
					resultVersion: account.version + 1n
				}
			});
			await tx.billingCommandReceipt.create({
				data: {
					commandId: command.commandId,
					commandType: command.commandType,
					requestHash: command.requestHash,
					requestHashVersion: 1,
					result: {
						workspaceId: order.workspaceId,
						status: 'COMMITTED',
						orderId: order.id,
						periodId: period.id,
						billingVersion: (account.version + 1n).toString()
					}
				}
			});
		}
		const renewal = await tx.crmAutoRenewal.findUnique({
			where: { workspaceId: order.workspaceId }
		});
		if (order.kind === 'RECURRING' && renewal) {
			await tx.crmAutoRenewal.update({
				where: { workspaceId: order.workspaceId },
				data: {
					nextChargeAt: expiresAt,
					nextRetryAt: null,
					retryStartedAt: null,
					retryAttempt: 0,
					dispatchPending: false,
					lastErrorCode: null,
					version: { increment: 1 }
				}
			});
		} else if (
			order.autoRenew &&
			order.consentVersion &&
			order.consentText &&
			order.consentedAt &&
			!(renewal?.disabledAt && renewal.disabledAt > order.consentedAt)
		) {
			const method = commerceRecord(provider.payment_method)
				? provider.payment_method
				: {};
			const card = commerceRecord(method.card) ? method.card : {};
			if (method.saved === true && this.providerId(method.id)) {
				const data = {
					ownerSubject: order.ownerSubject,
					status: 'ACTIVE',
					cycle: order.cycle,
					totalSeats: order.totalSeats,
					amountMinor: order.amountMinor,
					priceSnapshot: order.priceSnapshot as Prisma.InputJsonValue,
					paymentMethodCiphertext: this.crypto.encrypt(method.id),
					paymentMethodTitle: commerceText(method.title, 256)
						? method.title
						: null,
					paymentMethodLast4:
						typeof card.last4 === 'string' && /^[0-9]{4}$/.test(card.last4)
							? card.last4
							: null,
					consentVersion: order.consentVersion,
					consentText: order.consentText,
					consentedAt: order.consentedAt,
					nextChargeAt: expiresAt,
					nextRetryAt: null,
					retryStartedAt: null,
					retryAttempt: 0,
					dispatchPending: false,
					disabledAt: null,
					lastErrorCode: null
				};
				const updated = await tx.crmAutoRenewal.upsert({
					where: { workspaceId: order.workspaceId },
					create: { workspaceId: order.workspaceId, ...data },
					update: { ...data, version: { increment: 1 } }
				});
				await this.consent(
					tx,
					updated,
					order.ownerSubject,
					order.commandId,
					'ENABLED',
					{
						orderId: order.id,
						consentVersion: order.consentVersion,
						consentText: order.consentText,
						consentedAt: order.consentedAt.toISOString(),
						amountMinor: order.amountMinor.toString(),
						cycle: order.cycle,
						totalSeats: order.totalSeats
					}
				);
			}
		}
		await this.entitlementWake(tx, order.workspaceId);
	}
	private async cancelOrder(tx: Tx, order: CrmOrder, reason: string) {
		if (order.status === 'SUCCEEDED') return;
		await tx.crmOrder.update({
			where: { id: order.id },
			data: {
				status: 'CANCELLED',
				confirmationUrl: null,
				cancellationReason: reason,
				version: { increment: 1 }
			}
		});
		await tx.crmCommerceCommand.updateMany({
			where: { commandId: order.commandId, status: 'PENDING' },
			data: { status: 'CANCELLED' }
		});
		if (order.kind !== 'RECURRING') return;
		const renewal = await tx.crmAutoRenewal.findUnique({
			where: { workspaceId: order.workspaceId }
		});
		if (!renewal) return;
		const retryable =
			['insufficient_funds', 'issuer_unavailable'].includes(reason) &&
			renewal.status === 'ACTIVE' &&
			renewal.retryAttempt < 2;
		const retryStartedAt = renewal.retryStartedAt ?? new Date();
		await tx.crmAutoRenewal.update({
			where: { workspaceId: order.workspaceId },
			data: {
				dispatchPending: false,
				status:
					renewal.status !== 'ACTIVE'
						? renewal.status
						: retryable
							? 'ACTIVE'
							: 'TECHNICAL_PAUSE',
				retryStartedAt: retryable
					? retryStartedAt
					: renewal.retryStartedAt,
				retryAttempt: retryable
					? renewal.retryAttempt + 1
					: renewal.retryAttempt,
				nextRetryAt: retryable
					? new Date(
							retryStartedAt.getTime() +
								(renewal.retryAttempt === 0 ? 24 : 72) * 3600000
						)
					: null,
				lastErrorCode: reason,
				version: { increment: 1 }
			}
		});
	}
	private async settleReceipts(tx: Tx, order: CrmOrder, value: unknown) {
		if (
			!commerceRecord(value) ||
			!Array.isArray(value.items) ||
			value.items.length > 1000
		)
			throw new WincrmProviderResponseError('PROVIDER_INVALID_RESPONSE');
		for (const item of value.items) {
			if (
				!commerceRecord(item) ||
				!this.providerId(item.id) ||
				item.payment_id !== order.providerPaymentId ||
				!['pending', 'succeeded', 'canceled'].includes(
					item.status as string
				)
			)
				throw new WincrmProviderResponseError('PROVIDER_BINDING_MISMATCH');
			const field = (key: string, max = 128) =>
				commerceText(item[key], max) ? (item[key] as string) : null;
			const registeredAt =
				typeof item.registered_at === 'string'
					? new Date(item.registered_at)
					: null;
			if (registeredAt && !Number.isFinite(registeredAt.getTime()))
				throw new WincrmProviderResponseError('PROVIDER_INVALID_RESPONSE');
			const data = {
				status: item.status as string,
				type: field('type', 32),
				fiscalDocumentNumber: field('fiscal_document_number'),
				fiscalStorageNumber: field('fiscal_storage_number'),
				fiscalAttribute: field('fiscal_attribute'),
				registeredAt
			};
			const prior = await tx.crmPaymentReceipt.findUnique({
				where: { providerReceiptId: item.id }
			});
			if (
				prior &&
				(prior.orderId !== order.id ||
					prior.workspaceId !== order.workspaceId)
			)
				throw new WincrmProviderResponseError('PROVIDER_BINDING_MISMATCH');
			await tx.crmPaymentReceipt.upsert({
				where: { providerReceiptId: item.id },
				create: {
					workspaceId: order.workspaceId,
					orderId: order.id,
					providerReceiptId: item.id,
					...data
				},
				update: data
			});
		}
		if (
			!value.items.length ||
			value.items.some(
				item => (item as Record<string, unknown>).status === 'pending'
			)
		)
			return 'PENDING';
		return value.items.some(
			item => (item as Record<string, unknown>).status === 'canceled'
		)
			? 'FAILED'
			: 'SUCCEEDED';
	}
	private async rescheduleReceipt(
		tx: Tx,
		operation: { id: string },
		claim: WincrmProviderClaim
	) {
		const eventId = randomUUID(),
			outboxId = randomUUID(),
			availableAt = new Date(Date.now() + 60000);
		await tx.crmProviderOperation.update({
			where: {
				id: operation.id,
				version: claim.version,
				leaseToken: claim.leaseToken
			},
			data: {
				status: 'PENDING',
				version: { increment: 1 },
				retryAttempt: { increment: 1 },
				leaseToken: null,
				leaseUntil: null,
				pendingEventId: eventId,
				outboxId,
				availableAt,
				lastErrorCode: 'PROVIDER_RETRYABLE'
			}
		});
		await tx.crmProviderDelivery.update({
			where: {
				eventId_consumer: {
					eventId: claim.eventId,
					consumer: WINCRM_PROVIDER_CONSUMER
				}
			},
			data: {
				status: 'RETRY_SCHEDULED',
				version: { increment: 1 },
				leaseToken: null,
				leaseUntil: null,
				lastErrorCode: 'PROVIDER_RETRYABLE'
			}
		});
		await this.providerOutbox(
			tx,
			operation.id,
			eventId,
			outboxId,
			availableAt
		);
	}
	private async nextSequence(tx: Tx) {
		const sequence = await tx.billingSourceSequence.upsert({
			where: { id: 'billing' },
			create: { id: 'billing', nextValue: 2n },
			update: { nextValue: { increment: 1n } }
		});
		return sequence.nextValue - 1n;
	}
	private async entitlementWake(tx: Tx, workspaceId: string) {
		const base = await tx.crmEntitlement.findUnique({
			where: { workspaceId }
		});
		if (!base) return;
		const now = new Date(),
			period = await tx.crmPaidPeriod.findFirst({
				where: { workspaceId, startsAt: { lte: now } },
				orderBy: [{ startsAt: 'desc' }, { id: 'desc' }]
			});
		const account = await tx.crmCommerceAccount.findUnique({
			where: { workspaceId }
		});
		const eventId = randomUUID(),
			sequence = await this.nextSequence(tx),
			version =
				(account?.version ?? 0n) > base.aggregateVersion
					? account!.version
					: base.aggregateVersion + 1n;
		await tx.crmEntitlement.update({
			where: { workspaceId },
			data: { sourceSequence: sequence, aggregateVersion: version }
		});
		if (period && !period.activationNotifiedAt)
			await tx.crmPaidPeriod.update({
				where: { id: period.id },
				data: { activationNotifiedAt: now }
			});
		await tx.outboxEvent.create({
			data: {
				eventId,
				eventType: 'billing.crm-entitlement.changed.v1',
				aggregateType: 'billing.crm-entitlement',
				aggregateId: base.id,
				aggregateVersion: version,
				sourceSequence: sequence,
				exchange: 'winwidget.events',
				routingKey: 'billing.crm-entitlement.changed.v1',
				payload: {
					schemaVersion: 1,
					eventType: 'billing.crm-entitlement.changed.v1',
					eventId,
					aggregateId: base.id,
					aggregateVersion: version.toString(),
					sourceSequence: sequence.toString(),
					occurredAt: now.toISOString(),
					tombstone: false,
					state: {
						workspaceId,
						productCode: 'WINCRM',
						planCode: period ? 'PAID' : base.planCode,
						status: base.status,
						seatLimit: period?.totalSeats ?? base.seatLimit,
						effectiveFrom: (
							period?.startsAt ?? base.effectiveFrom
						).toISOString(),
						effectiveUntil: (
							period?.expiresAt ?? base.effectiveUntil
						).toISOString()
					}
				}
			}
		});
	}

	async advanceRenewals(now: Date): Promise<number> {
		if (!Number.isFinite(now.getTime()))
			throw new Error('WINCRM_SCHEDULER_TIME_INVALID');
		const starts = await this.prisma.crmPaidPeriod.findMany({
			where: { activationNotifiedAt: null, startsAt: { lte: now } },
			orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
			take: 100
		});
		for (const due of starts)
			await this.transaction(due.workspaceId, null, async tx => {
				const current = await tx.crmPaidPeriod.findUniqueOrThrow({
					where: { id: due.id }
				});
				if (current.activationNotifiedAt || current.startsAt > new Date())
					return;
				await this.entitlementWake(tx, current.workspaceId);
				await tx.crmPaidPeriod.update({
					where: { id: current.id },
					data: { activationNotifiedAt: new Date() }
				});
			});
		if (!wincrmPaymentsEnabled()) return 0;
		const candidates = await this.prisma.crmAutoRenewal.findMany({
			where: {
				status: 'ACTIVE',
				dispatchPending: false,
				OR: [
					{ nextRetryAt: { lte: now } },
					{ nextRetryAt: null, nextChargeAt: { lte: now } }
				]
			},
			orderBy: { nextChargeAt: 'asc' },
			take: 100
		});
		let created = 0;
		for (const candidate of candidates)
			created += await this.transaction(
				candidate.workspaceId,
				null,
				async tx => {
					const renewal = await tx.crmAutoRenewal.findUniqueOrThrow({
							where: { workspaceId: candidate.workspaceId }
						}),
						account = await tx.crmCommerceAccount.findUniqueOrThrow({
							where: { workspaceId: candidate.workspaceId }
						});
					if (
						renewal.status !== 'ACTIVE' ||
						renewal.dispatchPending ||
						!account.capacityCommandId ||
						!account.capacityFence
					)
						return 0;
					const due = renewal.nextRetryAt ?? renewal.nextChargeAt,
						clock = new Date();
					if (due > clock) return 0;
					const pause = async (status: string, code: string) => {
						const updated = await tx.crmAutoRenewal.update({
							where: { workspaceId: renewal.workspaceId },
							data: {
								status,
								lastErrorCode: code,
								version: { increment: 1 }
							}
						});
						await this.consent(
							tx,
							updated,
							renewal.ownerSubject,
							randomUUID(),
							status === 'REVOKED' ? 'REVOKED' : 'PAUSED',
							{ reason: code }
						);
						return 0;
					};
					if (
						clock.getTime() - due.getTime() >=
						(renewal.nextRetryAt ? 1 : 24) * 3600000
					)
						return pause('TECHNICAL_PAUSE', 'CHARGE_WINDOW_MISSED');
					const identity = await tx.identityContactProjection.findUnique({
						where: { userId: renewal.ownerSubject }
					});
					if (
						!identity ||
						identity.status !== 'ACTIVE' ||
						identity.tombstone ||
						identity.deletedAt
					)
						return pause('REVOKED', 'OWNER_UNAVAILABLE');
					const period = await this.latestPeriod(tx, renewal.workspaceId);
					if (
						!period ||
						period.expiresAt > clock ||
						period.expiresAt.getTime() !==
							renewal.nextChargeAt.getTime() ||
						period.totalSeats !== renewal.totalSeats
					)
						return pause('TECHNICAL_PAUSE', 'PAID_PERIOD_CHANGED');
					if (
						await tx.crmOrder.count({
							where: {
								workspaceId: renewal.workspaceId,
								status: { in: ['PENDING', 'UNKNOWN'] }
							}
						})
					)
						return 0;
					const policy = wincrmPriceSnapshot(
							await requireCrmCommercialPolicy(tx)
						),
						snapshot = readWincrmPriceSnapshot(renewal.priceSnapshot);
					const comparable = (value: typeof snapshot) =>
						JSON.stringify([
							value.monthlyPriceMinor,
							value.yearlyPriceMinor,
							value.additionalSeatMonthlyPriceMinor,
							value.additionalSeatYearlyPriceMinor,
							value.includedSeats,
							value.graceDays
						]);
					if (comparable(policy) !== comparable(snapshot))
						return pause('PRICE_CONFIRMATION_REQUIRED', 'PRICE_CHANGED');
					const cycleKey = `${renewal.id}:${renewal.nextChargeAt.toISOString()}:attempt:${renewal.retryAttempt}`;
					if (
						await tx.crmOrder.findUnique({
							where: { recurringCycleKey: cycleKey }
						})
					)
						return 0;
					const id = randomUUID();
					const order = await tx.crmOrder.create({
						data: {
							id,
							workspaceId: renewal.workspaceId,
							ownerSubject: renewal.ownerSubject,
							commandId: randomUUID(),
							capacityCommandId: account.capacityCommandId,
							capacityFence:
								account.capacityFence as Prisma.InputJsonValue,
							kind: 'RECURRING',
							cycle: renewal.cycle,
							totalSeats: renewal.totalSeats,
							amountMinor: renewal.amountMinor,
							priceSnapshot:
								renewal.priceSnapshot as Prisma.InputJsonValue,
							policyVersion: snapshot.policyVersion,
							autoRenew: true,
							consentVersion: renewal.consentVersion,
							consentText: renewal.consentText,
							consentedAt: renewal.consentedAt,
							customerEmail: identity.email,
							customerPhone: identity.phone,
							providerIdempotencyKey: wincrmProviderKey(
								'recurring',
								cycleKey
							),
							recurringCycleKey: cycleKey,
							recurringAttempt: renewal.retryAttempt,
							expectedRenewalVersion: renewal.version + 1,
							checkoutExpiresAt: new Date(
								Math.min(
									clock.getTime() + PROVIDER_WINDOW_MS,
									due.getTime() + (renewal.nextRetryAt ? 1 : 24) * 3600000
								)
							)
						}
					});
					await tx.crmAutoRenewal.update({
						where: { workspaceId: renewal.workspaceId },
						data: { dispatchPending: true, version: { increment: 1 } }
					});
					await tx.crmCommerceAccount.update({
						where: { workspaceId: renewal.workspaceId },
						data: { version: { increment: 1n } }
					});
					await this.enqueue(
						tx,
						order,
						'CREATE',
						order.providerIdempotencyKey
					);
					return 1;
				}
			);
		return created;
	}
}
