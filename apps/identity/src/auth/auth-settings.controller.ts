import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/identity-client';
import type { Request } from 'express';
import { Auth, CurrentUser, IdentityAuthGuard } from './auth.guard';
import { UpdateAuthSettingsDto } from './auth.dto';
import { AuthSettingsService } from './auth-settings.service';

@Controller('auth')
export class AuthSettingsController {
	constructor(private readonly settings: AuthSettingsService) {}

	@Get('settings')
	@HttpCode(200)
	get() {
		return this.settings.get();
	}

	@Patch('admin/settings')
	@Auth(Role.ADMIN)
	@UseGuards(IdentityAuthGuard)
	@HttpCode(200)
	@UsePipes(
		new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
	)
	update(
		@CurrentUser('id') actorId: string,
		@Body() dto: UpdateAuthSettingsDto,
		@Req() request: Request
	) {
		return this.settings.update(actorId, dto, request);
	}
}
