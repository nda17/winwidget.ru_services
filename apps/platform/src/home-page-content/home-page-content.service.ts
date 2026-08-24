import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/platform-client';
import { createHash } from 'node:crypto';
import type { PlatformActor } from '../auth/platform-request';
import {
	validateAndSanitizeStructuredHomeContent,
	validateRawHomeContent
} from '../content/platform-content.validation';
import { enqueuePlatformAdminAudit } from '../domain/platform-admin-audit';
import {
	nextPlatformSequence,
	refreshPlatformSemanticFingerprint
} from '../domain/platform-sequence';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';
import type {
	UpdateRawHomePageContentDto,
	UpdateStructuredHomePageContentDto
} from './home-page-content.dto';

const EMPTY_RAW_SECTION = { enabled: false, html: '' } as const;

@Injectable()
export class PlatformHomePageContentService {
	constructor(private readonly prisma: PlatformPrismaService) {}

	async get() {
		const item = await this.prisma.homePageContent.findUnique({
			where: { id: 'singleton' }
		});
		if (!item) {
			throw new ServiceUnavailableException(
				'Platform home-page content is unavailable'
			);
		}
		return this.serialize(item);
	}

	updateStructured(
		dto: UpdateStructuredHomePageContentDto,
		context: {
			actor: PlatformActor;
			ip?: string | null;
			userAgent?: string | null;
		}
	) {
		const structured = validateAndSanitizeStructuredHomeContent(
			dto.content
		);
		return this.update(structured, 'STRUCTURED', context);
	}

	updateRaw(
		dto: UpdateRawHomePageContentDto,
		context: {
			actor: PlatformActor;
			ip?: string | null;
			userAgent?: string | null;
		}
	) {
		const raw = validateRawHomeContent(dto.content);
		return this.update(raw, 'RAW', context);
	}

	private async update(
		patch: Record<string, unknown>,
		kind: 'STRUCTURED' | 'RAW',
		context: {
			actor: PlatformActor;
			ip?: string | null;
			userAgent?: string | null;
		}
	) {
		return this.prisma.$transaction(
			async transaction => {
				await transaction.$queryRaw(
					Prisma.sql`SELECT id FROM platform.home_page_content WHERE id = 'singleton' FOR UPDATE`
				);
				const current = await transaction.homePageContent.findUnique({
					where: { id: 'singleton' }
				});
				if (!current) {
					throw new ServiceUnavailableException(
						'Platform home-page content is unavailable'
					);
				}
				const currentContent = this.asRecord(current.content);
				const content =
					kind === 'STRUCTURED'
						? {
								...patch,
								head: this.rawSection(currentContent.head),
								body: this.rawSection(currentContent.body)
							}
						: { ...currentContent, ...patch };
				const sourceSequence = await nextPlatformSequence(transaction);
				const updated = await transaction.homePageContent.update({
					where: { id: 'singleton' },
					data: {
						content: content as Prisma.InputJsonObject,
						aggregateVersion: { increment: 1n },
						sourceSequence
					}
				});
				await refreshPlatformSemanticFingerprint(transaction);
				const serialized = JSON.stringify(content);
				await enqueuePlatformAdminAudit(transaction, {
					actor: context.actor,
					action:
						kind === 'STRUCTURED'
							? 'PLATFORM_HOME_PAGE_CONTENT_UPDATE'
							: 'PLATFORM_HOME_PAGE_RAW_CODE_UPDATE',
					description:
						kind === 'STRUCTURED'
							? 'Обновлён структурированный контент главной страницы'
							: 'Обновлён DEV-код head/body главной страницы',
					entity: {
						type: 'home_page_content',
						id: 'singleton',
						label: 'Главная страница'
					},
					metadata: {
						updateKind: kind,
						changedFields: Object.keys(patch).sort(),
						contentBytes: Buffer.byteLength(serialized, 'utf8'),
						contentSha256: createHash('sha256')
							.update(serialized, 'utf8')
							.digest('hex')
					},
					ip: context.ip,
					userAgent: context.userAgent
				});
				return this.serialize(updated);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private asRecord(value: Prisma.JsonValue): Record<string, unknown> {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	}

	private rawSection(value: unknown): { enabled: boolean; html: string } {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return { ...EMPTY_RAW_SECTION };
		}
		const candidate = value as Record<string, unknown>;
		return Object.keys(candidate).length === 2 &&
			typeof candidate.enabled === 'boolean' &&
			typeof candidate.html === 'string'
			? { enabled: candidate.enabled, html: candidate.html }
			: { ...EMPTY_RAW_SECTION };
	}

	private serialize(item: {
		id: string;
		content: Prisma.JsonValue;
		updatedAt: Date;
	}) {
		return {
			id: item.id,
			content: item.content,
			updatedAt: item.updatedAt.toISOString()
		};
	}
}
