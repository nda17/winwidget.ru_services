import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { UpdateLegalPageDto } from '@/legal-pages/dto/update-legal-page.dto';
import { isAutoRenewalOfferCompatible } from '@/billing-boundary/billing-boundary.constants';
import { PrismaService } from '@/prisma.service';
import {
	BadRequestException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { Request } from 'express';
import { createHash } from 'node:crypto';

const VALID_SLUGS = [
	'personal-policy',
	'consent-processing',
	'cookie-notice',
	'oferta'
] as const;

@Injectable()
export class LegalPagesService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	async getAll() {
		const pages = await this.prisma.legalPage.findMany();
		return VALID_SLUGS.map(slug => {
			const found = pages.find(p => p.slug === slug);
			return found ?? { slug, content: '', updatedAt: new Date() };
		});
	}

	async getBySlug(slug: string) {
		if (!VALID_SLUGS.includes(slug as (typeof VALID_SLUGS)[number])) {
			throw new NotFoundException('Legal page not found');
		}
		const page = await this.prisma.legalPage.findUnique({
			where: { slug }
		});
		return page ?? { slug, content: '', updatedAt: new Date() };
	}

	async update(
		slug: string,
		dto: UpdateLegalPageDto,
		audit: { adminId: string; request: Request }
	) {
		if (!VALID_SLUGS.includes(slug as (typeof VALID_SLUGS)[number])) {
			throw new NotFoundException('Legal page not found');
		}
		if (slug === 'oferta' && !isAutoRenewalOfferCompatible(dto.content)) {
			throw new BadRequestException(
				'Раздел автопродления защищён версией согласия. Измените его через релиз с новой версией условий или сохраните без изменений'
			);
		}
		return this.prisma.$transaction(async transaction => {
			const page = await transaction.legalPage.upsert({
				where: { slug },
				update: { content: dto.content },
				create: { slug, content: dto.content }
			});
			await this.adminEventLogService.recordInTransaction(transaction, {
				adminId: audit.adminId,
				section: 'SITE_SETTINGS',
				action: 'LEGAL_PAGE_UPDATE',
				description: `Обновлена юридическая страница ${slug}`,
				entityType: 'legal_page',
				entityId: slug,
				entityLabel: slug,
				metadata: {
					contentLength: dto.content.length,
					contentSha256: createHash('sha256')
						.update(dto.content)
						.digest('hex')
				},
				request: audit.request
			});
			return page;
		});
	}
}
