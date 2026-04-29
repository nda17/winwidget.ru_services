import { Auth } from '@/auth/decorators/auth.decorator';
import { UpdateHomePageContentDto } from '@/home-page-content/dto/update-home-page-content.dto';
import { HomePageContentService } from '@/home-page-content/home-page-content.service';
import { Body, Controller, Get, HttpCode, Patch } from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('/home-page-content')
export class HomePageContentController {
	constructor(
		private readonly homePageContentService: HomePageContentService
	) {}

	@HttpCode(200)
	@Get()
	get() {
		return this.homePageContentService.get();
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch()
	update(@Body() dto: UpdateHomePageContentDto) {
		return this.homePageContentService.update(dto);
	}
}
