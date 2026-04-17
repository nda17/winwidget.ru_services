import { UpdateLegalPageDto } from '@/legal-pages/dto/update-legal-page.dto';
import { PrismaService } from '@/prisma.service';
import { Injectable, NotFoundException } from '@nestjs/common';

const VALID_SLUGS = [
	'personal-policy',
	'consent-processing',
	'cookie-notice',
	'oferta'
] as const;

@Injectable()
export class LegalPagesService {
	constructor(private readonly prisma: PrismaService) {}

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

	async update(slug: string, dto: UpdateLegalPageDto) {
		if (!VALID_SLUGS.includes(slug as (typeof VALID_SLUGS)[number])) {
			throw new NotFoundException('Legal page not found');
		}
		return this.prisma.legalPage.upsert({
			where: { slug },
			update: { content: dto.content },
			create: { slug, content: dto.content }
		});
	}
}
