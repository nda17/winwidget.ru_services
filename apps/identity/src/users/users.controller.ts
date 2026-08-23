import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Put,
	Query,
	Req,
	UploadedFile,
	UseGuards,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/identity-client';
import type { Request } from 'express';
import {
	AVATAR_MAX_UPLOAD_BYTES,
	AVATAR_MIME_TYPES
} from '../avatar/avatar-storage.service';
import { AvatarService } from '../avatar/avatar.service';
import { Auth, CurrentUser, IdentityAuthGuard } from '../auth/auth.guard';
import {
	BindEmailStartDto,
	BindEmailVerifyDto,
	BindPhoneVerifyDto,
	PhoneDto,
	UpdateProfileDto,
	UpdateUserDto
} from '../auth/auth.dto';
import { UsersService } from './users.service';

export const AVATAR_UPLOAD_OPTIONS = {
	limits: {
		fileSize: AVATAR_MAX_UPLOAD_BYTES,
		files: 1,
		fields: 0,
		parts: 2
	},
	fileFilter: (
		_request: Express.Request,
		file: Express.Multer.File,
		callback: (error: Error | null, acceptFile: boolean) => void
	) => {
		if (!AVATAR_MIME_TYPES.some(mime => mime === file.mimetype)) {
			callback(
				new BadRequestException(
					'Avatar must be a JPEG, PNG or WebP image'
				),
				false
			);
			return;
		}
		callback(null, true);
	}
};

@Controller('users')
@UseGuards(IdentityAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class UsersController {
	constructor(
		private readonly users: UsersService,
		private readonly avatars: AvatarService
	) {}

	@Get('profile')
	@Auth(Role.USER)
	profile(@CurrentUser('id') userId: string) {
		return this.users.profile(userId);
	}

	@Patch('profile')
	@HttpCode(200)
	@Auth(Role.USER)
	updateProfile(
		@CurrentUser('id') userId: string,
		@CurrentUser('sessionId') sessionId: string,
		@Body() dto: UpdateProfileDto,
		@Req() request: Request
	) {
		return this.users.updateProfile(userId, sessionId, dto, request);
	}

	@Put('profile/avatar')
	@HttpCode(200)
	@Auth(Role.USER)
	@UseInterceptors(FileInterceptor('file', AVATAR_UPLOAD_OPTIONS))
	uploadProfileAvatar(
		@CurrentUser('id') userId: string,
		@UploadedFile() file: Express.Multer.File | undefined,
		@Req() request: Request
	) {
		return this.avatars.uploadSelf(userId, file, request);
	}

	@Delete('profile/avatar')
	@HttpCode(200)
	@Auth(Role.USER)
	deleteProfileAvatar(
		@CurrentUser('id') userId: string,
		@Req() request: Request
	) {
		return this.avatars.deleteSelf(userId, request);
	}

	@Post('profile/bind/email/send-code')
	@HttpCode(200)
	@Auth(Role.USER)
	bindEmailStart(
		@CurrentUser('id') userId: string,
		@Body() dto: BindEmailStartDto
	) {
		return this.users.startEmailBinding(userId, dto);
	}

	@Post('profile/bind/email/verify')
	@HttpCode(200)
	@Auth(Role.USER)
	bindEmailVerify(
		@CurrentUser('id') userId: string,
		@Body() dto: BindEmailVerifyDto
	) {
		return this.users.verifyEmailBinding(userId, dto);
	}

	@Post('profile/bind/phone/send-code')
	@HttpCode(200)
	@Auth(Role.USER)
	bindPhoneStart(
		@CurrentUser('id') userId: string,
		@Body() dto: PhoneDto
	) {
		return this.users.startPhoneBinding(userId, dto);
	}

	@Post('profile/bind/phone/verify')
	@HttpCode(200)
	@Auth(Role.USER)
	bindPhoneVerify(
		@CurrentUser('id') userId: string,
		@Body() dto: BindPhoneVerifyDto
	) {
		return this.users.verifyPhoneBinding(userId, dto);
	}

	@Post('profile/bind/telegram/start')
	@HttpCode(200)
	@Auth(Role.USER)
	telegramIdentityStart(@CurrentUser('id') userId: string) {
		return this.users.startTelegramIdentityBinding(userId);
	}

	@Post('profile/bind/telegram/cancel')
	@HttpCode(200)
	@Auth(Role.USER)
	telegramIdentityCancel(@CurrentUser('id') userId: string) {
		return this.users.cancelTelegramIdentityBinding(userId);
	}

	@Delete('profile/bind/telegram')
	@HttpCode(200)
	@Auth(Role.USER)
	telegramIdentityDelete(@CurrentUser('id') userId: string) {
		return this.users.deleteTelegramIdentity(userId);
	}

	@Get('profile/telegram-notifications')
	@Auth(Role.USER)
	telegramNotificationStatus(@CurrentUser('id') userId: string) {
		return this.users.telegramNotificationStatus(userId);
	}

	@Post('profile/telegram-notifications/start')
	@HttpCode(200)
	@Auth(Role.USER)
	telegramNotificationStart(@CurrentUser('id') userId: string) {
		return this.users.startTelegramNotifications(userId);
	}

	@Post('profile/telegram-notifications/cancel')
	@HttpCode(200)
	@Auth(Role.USER)
	telegramNotificationCancel(@CurrentUser('id') userId: string) {
		return this.users.cancelTelegramNotifications(userId);
	}

	@Delete('profile/telegram-notifications')
	@HttpCode(200)
	@Auth(Role.USER)
	telegramNotificationDelete(@CurrentUser('id') userId: string) {
		return this.users.deleteTelegramNotifications(userId);
	}

	@Get('user-list')
	@Auth(Role.ADMIN)
	list(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('searchTerm') searchTerm?: string,
		@Query('role') role?: string,
		@Query('registeredFrom') registeredFrom?: string,
		@Query('registeredTo') registeredTo?: string,
		@Query('subscription') subscription?: string,
		@Query('includeDeleted') includeDeleted?: string,
		@Query('deletedOnly') deletedOnly?: string,
		@CurrentUser('rights') adminRights: Role[] = []
	) {
		return this.users.list({
			page: page ? parseInt(page, 10) : 1,
			limit: limit ? parseInt(limit, 10) : 20,
			searchTerm,
			role,
			registeredFrom,
			registeredTo,
			subscription,
			includeDeleted: includeDeleted === 'true',
			deletedOnly: deletedOnly === 'true',
			adminRights
		});
	}

	@Get('edit/:id/overview')
	@Auth(Role.ADMIN)
	overview(@Param('id') id: string) {
		return this.users.adminOverview(id);
	}

	@Get('edit/:id')
	@Auth(Role.ADMIN)
	get(@Param('id') id: string) {
		return this.users.adminGet(id);
	}

	@Patch('user/:id')
	@HttpCode(200)
	@Auth(Role.ADMIN)
	update(
		@CurrentUser('id') actorId: string,
		@CurrentUser('rights') actorRights: Role[],
		@Param('id') id: string,
		@Body() dto: UpdateUserDto,
		@Req() request: Request
	) {
		return this.users.adminUpdate(actorId, actorRights, id, dto, request);
	}

	@Put('user/:id/avatar')
	@HttpCode(200)
	@Auth(Role.ADMIN)
	@UseInterceptors(FileInterceptor('file', AVATAR_UPLOAD_OPTIONS))
	uploadUserAvatar(
		@CurrentUser('id') actorId: string,
		@CurrentUser('rights') actorRights: Role[],
		@Param('id') id: string,
		@UploadedFile() file: Express.Multer.File | undefined,
		@Req() request: Request
	) {
		return this.avatars.uploadAdmin(
			actorId,
			actorRights,
			id,
			file,
			request
		);
	}

	@Delete('user/:id/avatar')
	@HttpCode(200)
	@Auth(Role.ADMIN)
	deleteUserAvatar(
		@CurrentUser('id') actorId: string,
		@CurrentUser('rights') actorRights: Role[],
		@Param('id') id: string,
		@Req() request: Request
	) {
		return this.avatars.deleteAdmin(actorId, actorRights, id, request);
	}

	@Patch('user/:id/toggle-activation')
	@HttpCode(200)
	@Auth(Role.ADMIN)
	toggle(
		@CurrentUser('id') actorId: string,
		@CurrentUser('rights') rights: Role[],
		@Param('id') id: string,
		@Req() request: Request
	) {
		return this.users.toggleActivation(actorId, rights, id, request);
	}

	@Delete('user/:id')
	@HttpCode(200)
	@Auth(Role.ADMIN)
	delete(
		@CurrentUser('id') actorId: string,
		@CurrentUser('rights') rights: Role[],
		@Param('id') id: string,
		@Req() request: Request
	) {
		return this.users.softDelete(actorId, rights, id, request);
	}

	@Patch('user/:id/restore')
	@HttpCode(200)
	@Auth(Role.DEV)
	restore(
		@CurrentUser('id') actorId: string,
		@Param('id') id: string,
		@Req() request: Request
	) {
		return this.users.restore(actorId, id, request);
	}
}
