import { CrmAdminSubscriptionService } from './crm-admin-subscription.service';
import type { BillingPrismaService } from '../prisma/billing-prisma.service';
import type { BillingActor } from '../auth/billing-request';

const W = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const DAY = 86_400_000;
const NOW = new Date('2026-09-07T12:00:00.000Z');
const actor = (role = 'ADMIN', subject = 'owner'): BillingActor =>
	({
		subject,
		active: true,
		sessionId: 'session',
		roles: [role]
	}) as BillingActor;
const command = {
	schemaVersion: 1 as const,
	commandId: C,
	expectedActorSubject: 'owner',
	expectedEntitlementVersion: '1',
	expectedBillingVersion: '0',
	expectedPeriodId: null,
	expectedPeriodVersion: null,
	days: 7,
	reason: 'Ручное бесплатное начисление'
};

function fixture(paid = false) {
	let entitlement: Record<string, any> | null = {
		id: W,
		workspaceId: W,
		planCode: 'TRIAL',
		status: 'ACTIVE',
		policyVersion: 1,
		seatLimit: 2,
		effectiveFrom: NOW,
		effectiveUntil: new Date(+NOW + 5 * DAY),
		graceUntil: new Date(+NOW + 8 * DAY),
		activatedByUserId: 'owner',
		aggregateVersion: 1n
	};
	const account = paid
		? {
				workspaceId: W,
				ownerSubject: 'owner',
				version: 1n,
				capacityCommandId: null,
				capacityFence: null
			}
		: null;
	const period = paid
		? {
				id: P,
				workspaceId: W,
				version: 1,
				startsAt: new Date(+NOW - DAY),
				expiresAt: new Date(+NOW + 30 * DAY),
				graceUntil: new Date(+NOW + 33 * DAY),
				totalSeats: 2,
				activationNotifiedAt: NOW,
				priceSnapshot: {
					policyVersion: 1,
					monthlyPriceMinor: 100000,
					yearlyPriceMinor: 1000000,
					additionalSeatMonthlyPriceMinor: 10000,
					additionalSeatYearlyPriceMinor: 100000,
					includedSeats: 2,
					graceDays: 3
				}
			}
		: null;
	const renewal = paid
		? {
				status: 'ACTIVE',
				nextChargeAt: period!.expiresAt,
				dispatchPending: false,
				version: 1,
				paymentMethodCiphertext: 'never-return',
				consentVersion: 'existing-consent'
			}
		: null;
	const receipts = new Map<string, any>();
	const grants: any[] = [];
	const tx = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		crmEntitlement: {
			findUnique: jest.fn(async () => entitlement),
			update: jest.fn(async ({ data }) =>
				Object.assign(entitlement!, data)
			)
		},
		crmCommerceAccount: {
			findUnique: jest.fn(async () => account),
			update: jest.fn(async ({ data }) =>
				Object.assign(account!, {
					version: account!.version + BigInt(data.version.increment)
				})
			)
		},
		crmPaidPeriod: {
			findFirst: jest.fn(async ({ where }) =>
				where.startsAt && period && period.startsAt > where.startsAt.lte
					? null
					: period
			),
			findUniqueOrThrow: jest.fn(async () => period),
			update: jest.fn(async ({ data }) =>
				Object.assign(period!, {
					...data,
					version: data.version
						? period!.version + data.version.increment
						: period!.version
				})
			)
		},
		crmAutoRenewal: {
			findUnique: jest.fn(async () => renewal),
			update: jest.fn(async ({ data }) =>
				Object.assign(renewal!, {
					...data,
					version: renewal!.version + data.version.increment
				})
			)
		},
		crmOrder: { count: jest.fn().mockResolvedValue(0) },
		crmCommerceCommand: { count: jest.fn().mockResolvedValue(0) },
		billingSourceSequence: {
			upsert: jest.fn().mockResolvedValue({ nextValue: 3n })
		},
		billingCommandReceipt: {
			findUnique: jest.fn(
				async ({ where }) => receipts.get(where.commandId) ?? null
			),
			create: jest.fn(async ({ data }) => {
				receipts.set(data.commandId, data);
				return data;
			})
		},
		crmAdminDayGrant: {
			create: jest.fn(async ({ data }) => {
				grants.push(data);
				return data;
			}),
			count: jest.fn(async () => grants.length),
			findMany: jest.fn(async () => grants)
		},
		outboxEvent: { create: jest.fn(async ({ data }) => data) }
	};
	const prisma = { ...tx, $transaction: jest.fn(async work => work(tx)) };
	return {
		service: new CrmAdminSubscriptionService(
			prisma as unknown as BillingPrismaService
		),
		tx,
		prisma,
		get entitlement() {
			return entitlement;
		},
		clearEntitlement: () => {
			entitlement = null;
		},
		account,
		period,
		renewal,
		grants,
		receipts
	};
}

describe('CRM administrative free day grants', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(NOW);
	});
	afterEach(() => jest.useRealTimers());

	it.each(['ADMIN', 'DEV'])(
		'allows %s including self without a payment or commerce account',
		async role => {
			const f = fixture();
			const result = (await f.service.extend(W, command, {
				actor: actor(role)
			})) as any;
			expect(result.grant).toMatchObject({
				commandId: C,
				actorSubject: 'owner',
				actorRole: role,
				target: 'ENTITLEMENT',
				days: 7
			});
			expect(result.grant.newExpiresAt).toBe(
				new Date(+NOW + 12 * DAY).toISOString()
			);
			expect(result.subscription.entitlementVersion).toBe('2');
			expect(result.subscription.billingVersion).toBe('0');
			expect(f.tx.crmPaidPeriod.update).not.toHaveBeenCalled();
			expect(f.tx.crmAutoRenewal.update).not.toHaveBeenCalled();
			expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(2);
			expect(
				f.tx.outboxEvent.create.mock.calls[1][0].data.payload
			).toMatchObject({
				action: 'SUBSCRIPTION_EXTEND_DAYS',
				metadata: {
					productCode: 'WINCRM',
					actorRole: role,
					reason: command.reason
				},
				entity: { type: 'crm_subscription', id: W }
			});
		}
	);

	it.each(['USER', 'CRM_ADMIN'])(
		'rejects %s before all reads or writes',
		async role => {
			const f = fixture();
			await expect(
				f.service.extend(W, command, { actor: actor(role) })
			).rejects.toMatchObject({ status: 403 });
			await expect(f.service.detail(W, actor(role))).rejects.toMatchObject(
				{ status: 403 }
			);
			await expect(
				f.service.command(W, C, actor(role))
			).rejects.toMatchObject({ status: 403 });
			expect(f.prisma.$transaction).not.toHaveBeenCalled();
		}
	);

	it('reactivates an expired trial from now and preserves provisioning and seat count', async () => {
		const f = fixture();
		Object.assign(f.entitlement!, {
			effectiveUntil: new Date(+NOW - 3 * DAY),
			graceUntil: NOW,
			status: 'EXPIRED',
			provisioningCommandId: 'original',
			seatLimit: 2
		});
		const result = (await f.service.extend(
			W,
			{ ...command, expectedActorSubject: 'operator' },
			{
				actor: actor('ADMIN', 'operator')
			}
		)) as any;
		expect(result.grant.newExpiresAt).toBe(
			new Date(+NOW + 7 * DAY).toISOString()
		);
		expect(result.subscription.entitlement.status).toBe('ACTIVE');
		expect(f.entitlement).toMatchObject({
			provisioningCommandId: 'original',
			seatLimit: 2,
			effectiveFrom: NOW
		});
	});

	it('preserves nullable grace for pre-policy entitlements', async () => {
		const f = fixture();
		Object.assign(f.entitlement!, {
			policyVersion: null,
			graceUntil: null
		});
		await f.service.extend(W, command, { actor: actor() });
		expect(f.entitlement!.graceUntil).toBeNull();
	});

	it('preserves the existing non-paid grace duration', async () => {
		const f = fixture();
		f.entitlement!.graceUntil = new Date(+NOW + 7 * DAY);
		await f.service.extend(W, command, { actor: actor() });
		expect(
			+f.entitlement!.graceUntil - +f.entitlement!.effectiveUntil
		).toBe(2 * DAY);
	});

	it('shows the latest started period even when a later paid period is scheduled', async () => {
		const f = fixture(true);
		const current = {
			...f.period!,
			id: C,
			expiresAt: new Date(+NOW + 3 * DAY),
			totalSeats: 4
		};
		f.period!.startsAt = new Date(+NOW + 3 * DAY);
		f.tx.crmPaidPeriod.findFirst.mockImplementation(async ({ where }) =>
			where.startsAt ? current : f.period
		);
		const { subscription } = await f.service.detail(W, actor());
		expect(subscription.entitlement).toMatchObject({
			planCode: 'PAID',
			seatLimit: 4,
			effectiveUntil: current.expiresAt.toISOString()
		});
		expect(subscription.period!.id).toBe(P);
	});

	it('rejects out-of-range grace before changing any dates', async () => {
		const f = fixture();
		f.entitlement!.effectiveUntil = new Date('9999-12-28T00:00:00.000Z');
		f.entitlement!.graceUntil = new Date('9999-12-31T00:00:00.000Z');
		await expect(
			f.service.extend(W, { ...command, days: 1 }, { actor: actor() })
		).rejects.toMatchObject({
			response: { code: 'crm_admin_subscription_date_out_of_range' }
		});
		expect(f.tx.crmEntitlement.update).not.toHaveBeenCalled();
		expect(f.tx.crmAdminDayGrant.create).not.toHaveBeenCalled();
	});

	it.each(['current', 'future', 'expired'])(
		'extends %s paid period and reschedules renewal without enabling it or rewriting purchase terms',
		async kind => {
			const f = fixture(true);
			if (kind === 'future') f.period!.startsAt = new Date(+NOW + 5 * DAY);
			if (kind === 'expired') f.period!.expiresAt = new Date(+NOW - DAY);
			f.renewal!.status = 'USER_DISABLED';
			const startsAt = f.period!.startsAt;
			const priceSnapshot = f.period!.priceSnapshot;
			const oldExpiresAt = f.period!.expiresAt;
			const result = (await f.service.extend(
				W,
				{
					...command,
					expectedActorSubject: 'operator',
					expectedBillingVersion: '1',
					expectedPeriodId: P,
					expectedPeriodVersion: 1
				},
				{ actor: actor('DEV', 'operator') }
			)) as any;
			expect(result.grant.target).toBe('PAID_PERIOD');
			expect(result.grant.newExpiresAt).toBe(
				new Date(Math.max(+NOW, +oldExpiresAt) + 7 * DAY).toISOString()
			);
			expect(f.period).toMatchObject({
				startsAt,
				priceSnapshot,
				totalSeats: 2,
				version: 2
			});
			expect(f.renewal).toMatchObject({
				status: 'USER_DISABLED',
				nextChargeAt: f.period!.expiresAt,
				paymentMethodCiphertext: 'never-return',
				consentVersion: 'existing-consent'
			});
			expect(JSON.stringify(result)).not.toContain('never-return');
			expect(f.account!.version).toBe(2n);
		}
	);

	it('replays once even after expiry changes and binds actor, workspace and payload', async () => {
		const f = fixture();
		const first = await f.service.extend(W, command, { actor: actor() });
		expect(await f.service.extend(W, command, { actor: actor() })).toEqual(
			first
		);
		await expect(
			f.service.extend(W, { ...command, days: 8 }, { actor: actor() })
		).rejects.toMatchObject({ status: 409 });
		await expect(
			f.service.extend(W, command, { actor: actor('ADMIN', 'other') })
		).rejects.toMatchObject({ status: 409 });
		await expect(
			f.service.extend(P, command, { actor: actor() })
		).rejects.toMatchObject({ status: 409 });
		expect(f.grants).toHaveLength(1);
		expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(2);
		expect(await f.service.command(W, C, actor('DEV'))).toMatchObject({
			outcome: 'COMMITTED',
			result: first,
			actorSubject: 'owner'
		});
		await expect(f.service.command(P, C, actor())).rejects.toMatchObject({
			status: 404
		});
	});

	it.each([
		'version',
		'period',
		'order',
		'command',
		'dispatch',
		'renewal-limit',
		'suspended',
		'cancelled'
	])(
		'blocks %s conflicts without granting days or publishing',
		async kind => {
			const f = fixture(true);
			if (kind === 'order') f.tx.crmOrder.count.mockResolvedValue(1);
			if (kind === 'command')
				f.tx.crmCommerceCommand.count.mockResolvedValue(1);
			if (kind === 'dispatch') f.renewal!.dispatchPending = true;
			if (kind === 'renewal-limit') f.renewal!.version = 2_147_483_646;
			if (kind === 'suspended') f.entitlement!.status = 'SUSPENDED';
			if (kind === 'cancelled') f.entitlement!.status = 'CANCELLED';
			await expect(
				f.service.extend(
					W,
					{
						...command,
						expectedBillingVersion: kind === 'version' ? '2' : '1',
						expectedPeriodId: P,
						expectedPeriodVersion: kind === 'period' ? 2 : 1
					},
					{ actor: actor() }
				)
			).rejects.toMatchObject({ status: 409 });
			expect(f.tx.crmAdminDayGrant.create).not.toHaveBeenCalled();
			expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
		}
	);

	it('does not provision a workspace or invent a trial', async () => {
		const f = fixture();
		f.clearEntitlement();
		await expect(
			f.service.extend(W, command, { actor: actor() })
		).rejects.toMatchObject({
			response: { code: 'crm_admin_subscription_not_provisioned' }
		});
		expect(f.tx.crmAdminDayGrant.create).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		'rejects an A-to-B ADMIN session swap before transaction and replay (existing receipt: %s)',
		async committed => {
			const f = fixture();
			if (committed)
				await f.service.extend(W, command, {
					actor: actor('ADMIN', 'owner')
				});
			f.prisma.$transaction.mockClear();
			await expect(
				f.service.extend(W, command, {
					actor: actor('ADMIN', 'other-admin')
				})
			).rejects.toMatchObject({
				response: { code: 'crm_admin_subscription_actor_changed' }
			});
			expect(f.prisma.$transaction).not.toHaveBeenCalled();
			expect(f.grants).toHaveLength(committed ? 1 : 0);
		}
	);

	it('cancels an unconfirmed original ID once and fences all late grants without changing subscriptions', async () => {
		const f = fixture();
		const dto = {
			schemaVersion: 1 as const,
			expectedActorSubject: 'owner'
		};
		const first = await f.service.cancel(W, C, dto, {
			actor: actor('DEV')
		});
		expect(first).toMatchObject({
			outcome: 'CANCELLED',
			workspaceId: W,
			commandId: C,
			actorSubject: 'owner',
			actorRole: 'DEV'
		});
		expect(
			await f.service.cancel(W, C, dto, { actor: actor('ADMIN') })
		).toEqual(first);
		expect(await f.service.command(W, C, actor())).toEqual(first);
		await expect(
			f.service.extend(W, command, { actor: actor() })
		).rejects.toMatchObject({
			response: { code: 'crm_admin_grant_cancelled' }
		});
		expect(f.grants).toHaveLength(0);
		expect(f.tx.crmEntitlement.update).not.toHaveBeenCalled();
		expect(f.tx.crmPaidPeriod.update).not.toHaveBeenCalled();
		expect(f.tx.crmCommerceAccount.update).not.toHaveBeenCalled();
		expect(f.tx.crmAutoRenewal.update).not.toHaveBeenCalled();
		expect(f.tx.billingCommandReceipt.create).toHaveBeenCalledTimes(1);
		expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(1);
		expect(
			f.tx.outboxEvent.create.mock.calls[0][0].data.payload
		).toMatchObject({
			metadata: {
				operation: 'CANCEL_UNCONFIRMED_COMMAND',
				outcome: 'CANCELLED'
			}
		});
	});

	it('returns COMMITTED instead of pretending to cancel an already granted command', async () => {
		const f = fixture();
		const granted = await f.service.extend(W, command, { actor: actor() });
		const proof = await f.service.cancel(
			W,
			C,
			{ schemaVersion: 1, expectedActorSubject: 'owner' },
			{ actor: actor() }
		);
		expect(proof).toMatchObject({ outcome: 'COMMITTED', result: granted });
		expect(f.grants).toHaveLength(1);
		expect(f.tx.billingCommandReceipt.create).toHaveBeenCalledTimes(1);
		expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(2);
	});

	it('recovers a cancellation whose committed HTTP response was lost', async () => {
		const f = fixture();
		const dto = {
			schemaVersion: 1 as const,
			expectedActorSubject: 'owner'
		};
		f.prisma.$transaction.mockImplementationOnce(async work => {
			await work(f.tx);
			throw new Error('synthetic response lost after commit');
		});
		await expect(
			f.service.cancel(W, C, dto, { actor: actor() })
		).rejects.toThrow('response lost');
		expect(await f.service.command(W, C, actor())).toMatchObject({
			outcome: 'CANCELLED',
			commandId: C
		});
		expect(
			await f.service.cancel(W, C, dto, { actor: actor() })
		).toMatchObject({ outcome: 'CANCELLED' });
		expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(1);
	});

	it.each(['workspace', 'actor', 'command-type'])(
		'rejects cancellation collisions with another %s without overwriting the original receipt',
		async kind => {
			const f = fixture();
			await f.service.extend(W, command, { actor: actor() });
			if (kind === 'command-type')
				f.receipts.get(C).commandType = 'UNRELATED_BILLING_OPERATION';
			const cancellingActor =
				kind === 'actor' ? actor('ADMIN', 'another-admin') : actor();
			await expect(
				f.service.cancel(
					kind === 'workspace' ? P : W,
					C,
					{
						schemaVersion: 1,
						expectedActorSubject: cancellingActor.subject
					},
					{ actor: cancellingActor }
				)
			).rejects.toMatchObject({
				response: { code: 'crm_admin_subscription_command_conflict' }
			});
			expect(f.tx.billingCommandReceipt.create).toHaveBeenCalledTimes(1);
		}
	);

	it('requires the captured actor and service role even when cancellation has no grant yet', async () => {
		const f = fixture();
		await expect(
			f.service.cancel(
				W,
				C,
				{ schemaVersion: 1, expectedActorSubject: 'owner' },
				{ actor: actor('ADMIN', 'another-admin') }
			)
		).rejects.toMatchObject({
			response: { code: 'crm_admin_subscription_actor_changed' }
		});
		await expect(
			f.service.cancel(
				W,
				C,
				{ schemaVersion: 1, expectedActorSubject: 'owner' },
				{ actor: actor('USER') }
			)
		).rejects.toMatchObject({ status: 403 });
		expect(f.prisma.$transaction).not.toHaveBeenCalled();
	});

	it.each(['grant', 'cancel'])(
		'reads the winning terminal receipt after a Serializable unique conflict in %s',
		async operation => {
			const f = fixture();
			const cancelInput = {
				schemaVersion: 1 as const,
				expectedActorSubject: 'owner'
			};
			await f.service.cancel(W, C, cancelInput, { actor: actor() });
			f.prisma.$transaction.mockClear();
			f.prisma.$transaction.mockRejectedValueOnce({
				code: 'P2002',
				meta: {
					modelName: 'BillingCommandReceipt',
					target: ['command_id']
				}
			});
			if (operation === 'grant') {
				await expect(
					f.service.extend(W, command, { actor: actor() })
				).rejects.toMatchObject({
					response: { code: 'crm_admin_grant_cancelled' }
				});
			} else {
				await expect(
					f.service.cancel(W, C, cancelInput, { actor: actor() })
				).resolves.toMatchObject({ outcome: 'CANCELLED' });
			}
			expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
			expect(f.tx.billingCommandReceipt.create).toHaveBeenCalledTimes(1);
			expect(f.tx.crmEntitlement.update).not.toHaveBeenCalled();
		}
	);

	it.each(['grant', 'cancel'])(
		'limits retries and never retries unrelated unique violations in %s',
		async operation => {
			for (const [failure, attempts] of [
				[{ code: 'P2034' }, 3],
				[
					{ code: 'P2002', meta: { modelName: 'BillingCommandReceipt' } },
					3
				],
				[{ code: 'P2002', meta: { modelName: 'CrmAdminDayGrant' } }, 1],
				[{ code: 'P2002' }, 1]
			] as const) {
				const f = fixture();
				f.prisma.$transaction.mockRejectedValue(failure);
				const request =
					operation === 'grant'
						? f.service.extend(W, command, { actor: actor() })
						: f.service.cancel(
								W,
								C,
								{ schemaVersion: 1, expectedActorSubject: 'owner' },
								{ actor: actor() }
							);
				await expect(request).rejects.toBe(failure);
				expect(f.prisma.$transaction).toHaveBeenCalledTimes(attempts);
			}
		}
	);
});

describe('CRM administrative subscription list batching', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(NOW);
	});
	afterEach(() => jest.useRealTimers());

	function batchFixture(size: number) {
		const base = fixture(true);
		const id = (index: number) =>
			`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
		const entitlements = Array.from({ length: size }, (_, index) => ({
			...base.entitlement!,
			id: id(index + 1),
			workspaceId: id(index + 1)
		}));
		const accounts = entitlements.map(item => ({
			...base.account!,
			workspaceId: item.workspaceId
		}));
		const renewals = entitlements.map(item => ({
			...base.renewal!,
			workspaceId: item.workspaceId
		}));
		const future = entitlements.map((item, index) => ({
			...base.period!,
			id: id(1000 + index),
			workspaceId: item.workspaceId,
			startsAt: new Date(+NOW + 5 * DAY)
		}));
		const current = entitlements.map((item, index) => ({
			...base.period!,
			id: id(2000 + index),
			workspaceId: item.workspaceId,
			expiresAt: new Date(+NOW + 5 * DAY),
			totalSeats: 4
		}));
		const references = entitlements.map((item, index) => ({
			workspace_id: item.workspaceId,
			period_id: future[index].id,
			current_period_id: current[index].id
		}));
		const tx = {
			$queryRaw: jest
				.fn()
				.mockResolvedValueOnce([{ total: BigInt(size) }])
				.mockResolvedValueOnce(
					entitlements.map(item => ({ workspace_id: item.workspaceId }))
				)
				.mockResolvedValueOnce(references),
			crmEntitlement: {
				findMany: jest.fn().mockResolvedValue(entitlements),
				findUnique: jest.fn()
			},
			crmCommerceAccount: {
				findMany: jest.fn().mockResolvedValue(accounts)
			},
			crmAutoRenewal: { findMany: jest.fn().mockResolvedValue(renewals) },
			crmOrder: {
				groupBy: jest.fn().mockResolvedValue(
					size
						? [
								{
									workspaceId: entitlements[0].workspaceId,
									_count: { _all: 2 }
								}
							]
						: []
				)
			},
			crmCommerceCommand: { groupBy: jest.fn().mockResolvedValue([]) },
			crmPaidPeriod: {
				findMany: jest.fn().mockResolvedValue([...current, ...future]),
				findFirst: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(async (work, options) => {
				void options;
				return work(tx);
			})
		};
		return {
			service: new CrmAdminSubscriptionService(
				prisma as unknown as BillingPrismaService
			),
			tx,
			prisma,
			entitlements,
			references,
			future,
			current
		};
	}

	it.each([1, 100])(
		'uses exactly nine bounded queries for %s populated workspaces with separate current/future periods',
		async size => {
			const f = batchFixture(size);
			const result = await f.service.list(
				{ page: 1, pageSize: size, ownerSubject: 'owner' },
				actor()
			);
			expect(result.items).toHaveLength(size);
			expect(f.tx.$queryRaw).toHaveBeenCalledTimes(3);
			for (const model of [
				f.tx.crmEntitlement,
				f.tx.crmCommerceAccount,
				f.tx.crmAutoRenewal,
				f.tx.crmPaidPeriod
			])
				expect(model.findMany).toHaveBeenCalledTimes(1);
			expect(f.tx.crmOrder.groupBy).toHaveBeenCalledTimes(1);
			expect(f.tx.crmCommerceCommand.groupBy).toHaveBeenCalledTimes(1);
			expect(f.tx.crmEntitlement.findUnique).not.toHaveBeenCalled();
			expect(f.tx.crmPaidPeriod.findFirst).not.toHaveBeenCalled();
			const where = f.tx.crmPaidPeriod.findMany.mock.calls[0][0].where;
			expect(where.workspaceId.in).toEqual(
				f.entitlements.map(item => item.workspaceId)
			);
			expect(new Set(where.id.in)).toEqual(
				new Set(
					f.references.flatMap(row => [
						row.period_id,
						row.current_period_id
					])
				)
			);
			expect(where.id.in).toHaveLength(2 * size);
			for (let index = 0; index < size; index += 1) {
				expect(result.items[index].workspaceId).toBe(
					f.entitlements[index].workspaceId
				);
				expect(result.items[index].period!.id).toBe(f.future[index].id);
				expect(result.items[index].entitlement).toMatchObject({
					planCode: 'PAID',
					seatLimit: 4,
					effectiveUntil: f.current[index].expiresAt.toISOString()
				});
			}
			expect(result.items[0].blockedReason).toBe(
				'crm_admin_subscription_operation_pending'
			);
			if (size > 1) expect(result.items[1].blockedReason).toBeNull();
			const selection = f.tx.$queryRaw.mock.calls[2][0];
			expect(selection.text).toContain('LEFT JOIN LATERAL');
			expect(selection.text).toContain('LIMIT 1');
			expect(selection.values).toContainEqual(NOW);
			expect(f.prisma.$transaction.mock.calls[0][1]).toMatchObject({
				isolationLevel: 'RepeatableRead'
			});
		}
	);

	it('does not query dependencies when the requested server page is empty', async () => {
		const f = batchFixture(0);
		const result = await f.service.list(
			{ page: 2, pageSize: 20 },
			actor()
		);
		expect(result.items).toEqual([]);
		expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
		expect(f.tx.crmEntitlement.findMany).not.toHaveBeenCalled();
		expect(f.tx.crmPaidPeriod.findMany).not.toHaveBeenCalled();
	});

	it('fails closed instead of projecting a cross-workspace or missing period as a valid subscription', async () => {
		const f = batchFixture(1);
		f.tx.crmPaidPeriod.findMany.mockResolvedValue([
			{ ...f.future[0], workspaceId: W },
			f.current[0]
		]);
		await expect(
			f.service.list({ page: 1, pageSize: 20 }, actor())
		).rejects.toThrow('WinCRM period snapshot binding is invalid');
	});
});
