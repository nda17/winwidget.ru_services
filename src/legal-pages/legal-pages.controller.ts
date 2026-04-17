import { Auth } from '@/auth/decorators/auth.decorator';
import { UpdateLegalPageDto } from '@/legal-pages/dto/update-legal-page.dto';
import { LegalPagesService } from '@/legal-pages/legal-pages.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Patch
} from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('/legal-pages')
export class LegalPagesController {
	constructor(private readonly legalPagesService: LegalPagesService) {}

	@HttpCode(200)
	@Get()
	getAll() {
		return this.legalPagesService.getAll();
	}

	@HttpCode(200)
	@Get(':slug')
	getBySlug(@Param('slug') slug: string) {
		return this.legalPagesService.getBySlug(slug);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch(':slug')
	update(@Param('slug') slug: string, @Body() dto: UpdateLegalPageDto) {
		return this.legalPagesService.update(slug, dto);
	}
}
