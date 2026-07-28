import { PrismaService } from '@/prisma.service';
import { PLAN_PRICES } from '@/subscription/subscription.constants';
import { UpdateTariffPricesDto } from '@/tariff-prices/dto/update-tariff-prices.dto';
import {
	BadRequestException,
	ConflictException,
	Injectable
} from '@nestjs/common';
import {
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	Plan,
	Prisma,
	Role,
	TariffPrice
} from '@prisma/client';

const PAID_PLANS = [Plan.EASY, Plan.HARD] as const;
const BILLING_PERIODS = [
	BillingPeriod.MONTHLY,
	BillingPeriod.YEARLY
] as const;
const REQUIRED_PRICES_COUNT = PAID_PLANS.length * BILLING_PERIODS.length;

@Injectable()
export class TariffPricesService {
	constructor(private readonly prisma: PrismaService) {}

	async getAll() {
		const prices = await this.prisma.tariffPrice.findMany({
			where: { plan: { in: [...PAID_PLANS] } }
		});

		if (prices.length < REQUIRED_PRICES_COUNT) {
			await this.ensureDefaults();
			return this.getAll();
		}

		return this.sortPrices(prices);
	}

	async getPrice(plan: Plan, billingPeriod: BillingPeriod) {
		if (!this.isPaidPlan(plan)) {
			return PLAN_PRICES[plan][billingPeriod];
		}

		const existingPrice = await this.prisma.tariffPrice.findUnique({
			where: {
				plan_billingPeriod: {
					plan,
					billingPeriod
				}
			}
		});

		if (existingPrice) {
			return existingPrice.amount;
		}

		const price = await this.prisma.tariffPrice.create({
			data: {
				plan,
				billingPeriod,
				amount: PLAN_PRICES[plan][billingPeriod]
			}
		});

		return price.amount;
	}

	/*
	 * The tariff price and the auto-renewal confirmation gate must change in
	 * the same serializable transaction.
	 */
	async updateAll(
		dto: UpdateTariffPricesDto,
		actor?: { id: string; role: Role }
	) {
		const normalized = this.normalizePrices(dto.prices);

		await this.prisma.$transaction(
			async transaction => {
				for (const price of normalized) {
					await transaction.tariffPrice.upsert({
						where: {
							plan_billingPeriod: {
								plan: price.plan,
								billingPeriod: price.billingPeriod
							}
						},
						update: {
							amount: price.amount
						},
						create: price
					});

					const renewals = await transaction.autoRenewal.findMany({
						where: {
							plan: price.plan,
							billingPeriod: price.billingPeriod,
							status: {
								in: [
									AutoRenewalStatus.ACTIVE,
									AutoRenewalStatus.ADMIN_PAUSED,
									AutoRenewalStatus.TECHNICAL_PAUSE
								]
							}
						}
					});
					const newAmount = this.formatAmount(price.amount);

					for (const renewal of renewals) {
						if (renewal.amount === newAmount) {
							if (renewal.pendingAmount) {
								await transaction.autoRenewal.updateMany({
									where: {
										id: renewal.id,
										stateVersion: renewal.stateVersion
									},
									data: {
										pendingAmount: null,
										priceChangeDetectedAt: null,
										stateVersion: { increment: 1 }
									}
								});
							}
							continue;
						}
						if (renewal.pendingAmount === newAmount) continue;

						const detectedAt = new Date();
						const changed = await transaction.autoRenewal.updateMany({
							where: {
								id: renewal.id,
								stateVersion: renewal.stateVersion
							},
							data: {
								pendingAmount: newAmount,
								priceChangeDetectedAt: detectedAt,
								stateVersion: { increment: 1 }
							}
						});
						if (changed.count !== 1) {
							throw new ConflictException(
								'Состояние автопродления изменилось параллельно. Повторите изменение цен'
							);
						}

						await transaction.autoRenewalConsentEvent.create({
							data: {
								autoRenewalId: renewal.id,
								userId: renewal.userId,
								type: AutoRenewalConsentEventType.PRICE_CHANGE_REQUIRED,
								actorUserId: actor?.id ?? null,
								actorRole: actor?.role ?? null,
								source: 'ADMIN_TARIFF_PRICE_UPDATE',
								reason:
									'Новая стоимость требует явного подтверждения пользователя',
								consentVersion: renewal.consentVersion,
								consentText: renewal.consentText,
								plan: renewal.plan,
								billingPeriod: renewal.billingPeriod,
								amount: renewal.amount,
								currency: renewal.currency,
								metadata: {
									previousAmount: renewal.pendingAmount ?? renewal.amount,
									consentedAmount: renewal.amount,
									newAmount,
									detectedAt: detectedAt.toISOString()
								}
							}
						});
					}
				}
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 5000,
				timeout: 30000
			}
		);

		return this.getAll();
	}

	private formatAmount(amount: number) {
		return `${amount}.00`;
	}

	private async ensureDefaults() {
		await this.prisma.$transaction(
			PAID_PLANS.flatMap(plan =>
				BILLING_PERIODS.map(billingPeriod =>
					this.prisma.tariffPrice.upsert({
						where: {
							plan_billingPeriod: {
								plan,
								billingPeriod
							}
						},
						update: {},
						create: {
							plan,
							billingPeriod,
							amount: PLAN_PRICES[plan][billingPeriod]
						}
					})
				)
			)
		);
	}

	private normalizePrices(prices: UpdateTariffPricesDto['prices']) {
		const map = new Map<string, UpdateTariffPricesDto['prices'][number]>();

		for (const price of prices) {
			if (!this.isPaidPlan(price.plan)) {
				throw new BadRequestException(
					'Можно менять цены только для тарифов Easy и Hard'
				);
			}

			map.set(this.getPriceKey(price.plan, price.billingPeriod), price);
		}

		const expectedKeys = PAID_PLANS.flatMap(plan =>
			BILLING_PERIODS.map(billingPeriod =>
				this.getPriceKey(plan, billingPeriod)
			)
		);
		const missingKey = expectedKeys.find(key => !map.has(key));

		if (missingKey) {
			throw new BadRequestException(
				'Нужно передать цены Easy и Hard для месяца и года'
			);
		}

		return expectedKeys.map(key => map.get(key)!);
	}

	private sortPrices(prices: TariffPrice[]) {
		const order = new Map(
			PAID_PLANS.flatMap((plan, planIndex) =>
				BILLING_PERIODS.map((billingPeriod, periodIndex) => [
					this.getPriceKey(plan, billingPeriod),
					planIndex * BILLING_PERIODS.length + periodIndex
				])
			)
		);

		return [...prices].sort(
			(a, b) =>
				(order.get(this.getPriceKey(a.plan, a.billingPeriod)) ?? 0) -
				(order.get(this.getPriceKey(b.plan, b.billingPeriod)) ?? 0)
		);
	}

	private getPriceKey(plan: Plan, billingPeriod: BillingPeriod) {
		return `${plan}:${billingPeriod}`;
	}

	private isPaidPlan(plan: Plan): plan is (typeof PAID_PLANS)[number] {
		return PAID_PLANS.includes(plan as (typeof PAID_PLANS)[number]);
	}
}
