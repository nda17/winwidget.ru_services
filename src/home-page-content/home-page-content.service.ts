import { UpdateHomePageContentDto } from '@/home-page-content/dto/update-home-page-content.dto';
import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class HomePageContentService {
	constructor(private readonly prisma: PrismaService) {}

	async get() {
		return this.prisma.homePageContent.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton', content: {} }
		});
	}

	async update(dto: UpdateHomePageContentDto) {
		const content = dto.content as Prisma.InputJsonObject;

		return this.prisma.homePageContent.upsert({
			where: { id: 'singleton' },
			update: { content },
			create: { id: 'singleton', content }
		});
	}
}
