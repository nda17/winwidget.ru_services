import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { UpdateLegalPageDto } from '@/legal-pages/dto/update-legal-page.dto';
import { LegalPagesService } from '@/legal-pages/legal-pages.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Patch,
	Req
} from '@nestjs/common';
import { Request } from 'express';

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
	@Auth('ADMIN')
	@Patch(':slug')
	async update(
		@Param('slug') slug: string,
		@Body() dto: UpdateLegalPageDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.legalPagesService.update(slug, dto, {
			adminId,
			request
		});
	}
}
