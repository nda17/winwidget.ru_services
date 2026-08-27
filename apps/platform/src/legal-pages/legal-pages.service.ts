import {
	BadRequestException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	type BillingOfferProducerState
} from '@prisma/platform-client';
import { createHash } from 'node:crypto';
import type { PlatformActor } from '../auth/platform-request';
import { sanitizeLegalHtml } from '../content/platform-content.validation';
import {
	buildBillingOfferChangedEvent,
	isAutoRenewalOfferCompatible,
	nextBillingOfferCursor
} from '../domain/billing-offer-continuity';
import { enqueuePlatformAdminAudit } from '../domain/platform-admin-audit';
import {
	nextPlatformSequence,
	refreshPlatformSemanticFingerprint
} from '../domain/platform-sequence';
import { PLATFORM_EVENTS_EXCHANGE } from '../messaging/platform-messaging.constants';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';
import type { UpdatePlatformLegalPageDto } from './legal-pages.dto';

export const PLATFORM_LEGAL_PAGE_SLUGS = [
	'personal-policy',
	'consent-processing',
	'cookie-notice',
	'oferta'
] as const;

@Injectable()
export class PlatformLegalPagesService {
	constructor(private readonly prisma: PlatformPrismaService) {}

	async getAll() {
		const pages = await this.prisma.legalPage.findMany({
			where: { slug: { in: [...PLATFORM_LEGAL_PAGE_SLUGS] } },
			orderBy: { slug: 'asc' }
		});
		const bySlug = new Map(pages.map(page => [page.slug, page]));
		return PLATFORM_LEGAL_PAGE_SLUGS.map(slug => {
			const page = bySlug.get(slug);
			if (!page) {
				throw new ServiceUnavailableException(
					'Platform legal-page seed is incomplete'
				);
			}
			return this.serialize(page);
		});
	}

	async getBySlug(slug: string) {
		this.assertSlug(slug);
		const page = await this.prisma.legalPage.findUnique({
			where: { slug }
		});
		if (!page) {
			throw new ServiceUnavailableException(
				'Platform legal-page seed is incomplete'
			);
		}
		return this.serialize(page);
	}

	async update(
		slug: string,
		dto: UpdatePlatformLegalPageDto,
		context: {
			actor: PlatformActor;
			ip?: string | null;
			userAgent?: string | null;
		}
	) {
		this.assertSlug(slug);
		if (slug === 'oferta' && !isAutoRenewalOfferCompatible(dto.content)) {
			throw this.incompatibleOffer();
		}
		const content = sanitizeLegalHtml(dto.content);
		if (slug === 'oferta' && !isAutoRenewalOfferCompatible(content)) {
			throw this.incompatibleOffer();
		}
		return this.prisma.$transaction(
			async transaction => {
				await transaction.$queryRaw(
					Prisma.sql`SELECT slug FROM platform.legal_pages WHERE slug = ${slug} FOR UPDATE`
				);
				const offerProducer =
					slug === 'oferta'
						? await this.lockOfferProducer(transaction)
						: null;
				const offerCursor = offerProducer
					? this.requireOfferCursor(offerProducer)
					: null;
				const sourceSequence = await nextPlatformSequence(transaction);
				const page = await transaction.legalPage.upsert({
					where: { slug },
					create: {
						slug,
						content,
						aggregateVersion: 1n,
						sourceSequence
					},
					update: {
						content,
						aggregateVersion: { increment: 1n },
						sourceSequence
					}
				});
				if (offerProducer && offerCursor) {
					const event = buildBillingOfferChangedEvent({
						content: page.content,
						updatedAt: page.updatedAt,
						cursor: offerCursor
					});
					await transaction.outboxEvent.create({
						data: {
							eventId: event.eventId,
							messageId: event.eventId,
							deduplicationKey: `${event.eventType}:${event.sourceSequenceScope}:${event.aggregateVersion}`,
							eventType: event.eventType,
							aggregateType: 'billing.offer',
							aggregateId: 'offer',
							aggregateVersion: offerCursor.aggregateVersion,
							sourceSequence: offerCursor.sourceSequence,
							exchange: PLATFORM_EVENTS_EXCHANGE,
							routingKey: event.eventType,
							payload: event as Prisma.InputJsonValue
						}
					});
					const advanced =
						await transaction.billingOfferProducerState.updateMany({
							where: {
								id: 'offer',
								producerContractVersion:
									offerProducer.producerContractVersion,
								sourceSequenceScope: offerProducer.sourceSequenceScope,
								currentAggregateVersion:
									offerProducer.currentAggregateVersion,
								currentSourceSequence: offerProducer.currentSourceSequence
							},
							data: {
								currentAggregateVersion: offerCursor.aggregateVersion,
								currentSourceSequence: offerCursor.sourceSequence
							}
						});
					if (advanced.count !== 1) throw this.offerProducerUnavailable();
				}
				await refreshPlatformSemanticFingerprint(transaction);
				await enqueuePlatformAdminAudit(transaction, {
					actor: context.actor,
					action: 'PLATFORM_LEGAL_PAGE_UPDATE',
					description: `Обновлена юридическая страница ${slug}`,
					entity: {
						type: 'legal_page',
						id: slug,
						label: slug
					},
					metadata: {
						contentLength: content.length,
						contentSha256: createHash('sha256')
							.update(content, 'utf8')
							.digest('hex')
					},
					ip: context.ip,
					userAgent: context.userAgent
				});
				return this.serialize(page);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private async lockOfferProducer(transaction: Prisma.TransactionClient) {
		await transaction.$queryRaw(
			Prisma.sql`SELECT id FROM platform.billing_offer_producer_state WHERE id = 'offer' FOR UPDATE`
		);
		const state = await transaction.billingOfferProducerState.findUnique({
			where: { id: 'offer' }
		});
		if (!state) throw this.offerProducerUnavailable();
		return state;
	}

	private requireOfferCursor(state: BillingOfferProducerState) {
		try {
			return nextBillingOfferCursor(state);
		} catch {
			throw this.offerProducerUnavailable();
		}
	}

	private assertSlug(
		slug: string
	): asserts slug is (typeof PLATFORM_LEGAL_PAGE_SLUGS)[number] {
		if (
			!PLATFORM_LEGAL_PAGE_SLUGS.includes(
				slug as (typeof PLATFORM_LEGAL_PAGE_SLUGS)[number]
			)
		) {
			throw new NotFoundException('Legal page not found');
		}
	}

	private incompatibleOffer(): BadRequestException {
		return new BadRequestException(
			'Раздел автопродления защищён версией согласия. Измените его через релиз с новой версией условий или сохраните без изменений'
		);
	}

	private offerProducerUnavailable(): ServiceUnavailableException {
		return new ServiceUnavailableException(
			'Billing offer producer cursor is unavailable'
		);
	}

	private serialize(page: {
		slug: string;
		content: string;
		updatedAt: Date;
	}) {
		return {
			slug: page.slug,
			content: sanitizeLegalHtml(page.content),
			updatedAt: page.updatedAt.toISOString()
		};
	}
}
