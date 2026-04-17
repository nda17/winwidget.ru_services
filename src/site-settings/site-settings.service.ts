import { PrismaService } from '@/prisma.service';
import { UpdateSiteSettingsDto } from '@/site-settings/dto/update-site-settings.dto';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SiteSettingsService {
	constructor(private readonly prisma: PrismaService) {}

	async get() {
		return this.prisma.siteSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
	}

	async update(dto: UpdateSiteSettingsDto) {
		return this.prisma.siteSettings.upsert({
			where: { id: 'singleton' },
			update: dto,
			create: { id: 'singleton', ...dto }
		});
	}
}
