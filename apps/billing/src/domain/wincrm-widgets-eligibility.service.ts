import {
	BadRequestException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { BillingPrismaService } from '../prisma/billing-prisma.service';

const SUBJECT = /^[^\s\x00-\x1f\x7f]{1,256}$/;
const ID = /^[^\s\x00-\x1f\x7f]{1,255}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const FRESHNESS_MS = 5000;

type EligibilityReason =
	| 'ELIGIBLE'
	| 'NO_SUBSCRIPTION'
	| 'TRIAL'
	| 'INACTIVE'
	| 'NOT_STARTED'
	| 'EXPIRED';
export interface WincrmWidgetsEligibility {
	schemaVersion: 1;
	ownerSubject: string;
	eligible: boolean;
	reason: EligibilityReason;
	subscriptionId: string | null;
	version: string | null;
	plan: 'TRIAL' | 'EASY' | 'HARD' | null;
	startsAt: string | null;
	expiresAt: string | null;
	checkedAt: string;
	validUntil: string;
}

const validDate = (value: unknown): value is Date =>
	value instanceof Date &&
	Number.isFinite(value.getTime()) &&
	value.getUTCFullYear() >= 1970 &&
	value.getUTCFullYear() <= 9999;
const unavailable = () =>
	new ServiceUnavailableException({
		code: 'billing_wincrm_eligibility_unavailable',
		message: 'Widgets subscription eligibility could not be confirmed'
	});

@Injectable()
export class WincrmWidgetsEligibilityService {
	constructor(private readonly prisma: BillingPrismaService) {}

	async read(ownerSubject: string): Promise<WincrmWidgetsEligibility> {
		if (typeof ownerSubject !== 'string' || !SUBJECT.test(ownerSubject)) {
			throw new BadRequestException(
				'ownerSubject must be a canonical subject'
			);
		}
		let subscription;
		try {
			// Deliberately does not call subscriptions/me, ensureTrial or usage providers.
			subscription = await this.prisma.subscription.findUnique({
				where: { userId: ownerSubject },
				select: {
					id: true,
					userId: true,
					plan: true,
					status: true,
					startsAt: true,
					expiresAt: true,
					aggregateVersion: true
				}
			});
		} catch {
			throw unavailable();
		}
		// Read latency must not extend an entitlement past its expiration boundary.
		const now = new Date();
		if (!validDate(now)) throw unavailable();
		const checkedAt = now.toISOString();
		if (!subscription)
			return {
				schemaVersion: 1,
				ownerSubject,
				eligible: false,
				reason: 'NO_SUBSCRIPTION',
				subscriptionId: null,
				version: null,
				plan: null,
				startsAt: null,
				expiresAt: null,
				checkedAt,
				validUntil: checkedAt
			};
		if (
			typeof subscription.id !== 'string' ||
			!ID.test(subscription.id) ||
			subscription.userId !== ownerSubject ||
			!['TRIAL', 'EASY', 'HARD'].includes(subscription.plan) ||
			!['ACTIVE', 'EXPIRED', 'CANCELLED'].includes(subscription.status) ||
			typeof subscription.aggregateVersion !== 'bigint' ||
			subscription.aggregateVersion < 0n ||
			subscription.aggregateVersion > MAX_BIGINT ||
			!validDate(subscription.startsAt) ||
			(subscription.expiresAt !== null &&
				!validDate(subscription.expiresAt))
		)
			throw unavailable();

		let reason: EligibilityReason;
		if (subscription.status !== 'ACTIVE') reason = 'INACTIVE';
		else if (subscription.plan === 'TRIAL') reason = 'TRIAL';
		else if (
			!subscription.expiresAt ||
			subscription.expiresAt <= subscription.startsAt
		) {
			// An active paid tier without a finite, consistent period is not a permit.
			throw unavailable();
		} else if (subscription.startsAt > now) reason = 'NOT_STARTED';
		else if (subscription.expiresAt <= now) reason = 'EXPIRED';
		else reason = 'ELIGIBLE';

		const eligible = reason === 'ELIGIBLE';
		return {
			schemaVersion: 1,
			ownerSubject,
			eligible,
			reason,
			subscriptionId: subscription.id,
			version: subscription.aggregateVersion.toString(),
			plan: subscription.plan,
			startsAt: subscription.startsAt.toISOString(),
			expiresAt: subscription.expiresAt?.toISOString() ?? null,
			checkedAt,
			validUntil: eligible
				? new Date(
						Math.min(
							now.getTime() + FRESHNESS_MS,
							subscription.expiresAt!.getTime()
						)
					).toISOString()
				: checkedAt
		};
	}
}
