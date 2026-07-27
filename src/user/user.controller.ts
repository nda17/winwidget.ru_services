import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { SendProfileEmailCodeDto } from '@/user/dto/send-profile-email-code.dto';
import { SendProfilePhoneCodeDto } from '@/user/dto/send-profile-phone-code.dto';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { UpdateProfileDto } from '@/user/dto/update-profile.dto';
import { UpdateUserDto } from '@/user/dto/update-user.dto';
import { VerifyProfileEmailCodeDto } from '@/user/dto/verify-profile-email-code.dto';
import { VerifyProfilePhoneCodeDto } from '@/user/dto/verify-profile-phone-code.dto';
import { UserIdentityBindingService } from '@/user/user-identity-binding.service';
import { UserService } from '@/user/user.service';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Query,
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Controller('users')
export class UserController {
	constructor(
		private readonly userService: UserService,
		private readonly userIdentityBindingService: UserIdentityBindingService,
		private readonly telegramBotService: TelegramBotService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@HttpCode(200)
	@Auth()
	@Get('profile')
	async getProfile(@CurrentUser('id') id: string) {
		return this.userService.getPublicUserById(id);
	}

	@HttpCode(200)
	@Auth()
	@Patch('profile')
	async updateProfile(
		@CurrentUser('id') id: string,
		@Body() dto: UpdateProfileDto
	) {
		return this.userService.updateProfile(id, dto);
	}

	@HttpCode(200)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('profile/bind/email/send-code')
	async sendProfileEmailCode(
		@CurrentUser('id') id: string,
		@Body() dto: SendProfileEmailCodeDto
	) {
		return this.userIdentityBindingService.sendEmailCode(id, dto.email);
	}

	@HttpCode(200)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('profile/bind/email/verify')
	async verifyProfileEmailCode(
		@CurrentUser('id') id: string,
		@Body() dto: VerifyProfileEmailCodeDto
	) {
		return this.userIdentityBindingService.verifyEmailCode(
			id,
			dto.email,
			dto.code
		);
	}

	@HttpCode(200)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('profile/bind/phone/send-code')
	async sendProfilePhoneCode(
		@CurrentUser('id') id: string,
		@Body() dto: SendProfilePhoneCodeDto
	) {
		return this.userIdentityBindingService.sendPhoneCode(id, dto.phone);
	}

	@HttpCode(200)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('profile/bind/phone/verify')
	async verifyProfilePhoneCode(
		@CurrentUser('id') id: string,
		@Body() dto: VerifyProfilePhoneCodeDto
	) {
		return this.userIdentityBindingService.verifyPhoneCode(
			id,
			dto.phone,
			dto.code
		);
	}

	@HttpCode(200)
	@Auth()
	@Post('profile/bind/telegram/start')
	async startProfileTelegramBinding(@CurrentUser('id') id: string) {
		return this.userIdentityBindingService.startTelegramBinding(id);
	}

	@HttpCode(200)
	@Auth()
	@Post('profile/bind/telegram/cancel')
	async cancelProfileTelegramBinding(@CurrentUser('id') id: string) {
		return this.userIdentityBindingService.cancelTelegramBinding(id);
	}

	@HttpCode(200)
	@Auth()
	@Delete('profile/bind/telegram')
	async unlinkProfileTelegramBinding(@CurrentUser('id') id: string) {
		return this.userIdentityBindingService.unlinkTelegramBinding(id);
	}

	@HttpCode(200)
	@Auth()
	@Get('profile/telegram-notifications')
	getProfileTelegramNotifications(@CurrentUser('id') id: string) {
		return this.telegramBotService.getNotificationStatus(id);
	}

	@HttpCode(200)
	@Auth()
	@Post('profile/telegram-notifications/start')
	startProfileTelegramNotifications(@CurrentUser('id') id: string) {
		return this.telegramBotService.startNotificationBinding(id);
	}

	@HttpCode(200)
	@Auth()
	@Post('profile/telegram-notifications/cancel')
	cancelProfileTelegramNotifications(@CurrentUser('id') id: string) {
		return this.telegramBotService.cancelNotificationBinding(id);
	}

	@HttpCode(200)
	@Auth()
	@Delete('profile/telegram-notifications')
	disconnectProfileTelegramNotifications(@CurrentUser('id') id: string) {
		return this.telegramBotService.disconnectNotificationChannel(id);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('user-list')
	async getUserList(
		@Query('searchTerm') searchTerm?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('role') role?: string,
		@Query('registeredFrom') registeredFrom?: string,
		@Query('registeredTo') registeredTo?: string,
		@Query('subscription') subscription?: string,
		@Query('includeDeleted') includeDeleted?: string,
		@Query('deletedOnly') deletedOnly?: string,
		@CurrentUser('rights') adminRights: Role[] = []
	) {
		return this.userService.getUserList(
			searchTerm,
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{
				role,
				registeredFrom,
				registeredTo,
				subscription,
				includeDeleted: includeDeleted === 'true',
				deletedOnly: deletedOnly === 'true'
			},
			adminRights
		);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('edit/:id/overview')
	async getUserOverview(@Param('id') id: string) {
		return this.userService.getAdminUserOverview(id);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('edit/:id')
	async getUserById(@Param('id') id: string) {
		return this.userService.getAdminEditableUserById(id);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch('user/:id')
	async updateUser(
		@Param('id') id: string,
		@Body() dto: UpdateUserDto,
		@CurrentUser('id') adminId: string,
		@CurrentUser('rights') adminRights: Role[],
		@Req() request: Request
	) {
		const user = await this.userService.updateUser(
			id,
			dto,
			adminId,
			adminRights
		);
		const updatedFields = Object.keys(dto).filter(
			field => field !== 'password'
		);

		await this.adminEventLogService.record({
			adminId,
			section: 'USERS',
			action: 'USER_UPDATE',
			description: 'Редактирование пользователя',
			entityType: 'user',
			entityId: id,
			entityLabel: user?.name || user?.email || user?.phone || id,
			targetUserId: id,
			metadata: {
				updatedFields,
				passwordChanged: Boolean(dto.password),
				isAdmin: dto.isAdmin ?? null,
				isDev: dto.isDev ?? null
			},
			request
		});

		return user;
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch('user/:id/toggle-activation')
	async toggleUserActivation(
		@Param('id') id: string,
		@CurrentUser('id') adminId: string,
		@CurrentUser('rights') adminRights: Role[],
		@Req() request: Request
	) {
		const user = await this.userService.toggleUserActivation(
			id,
			adminId,
			adminRights
		);

		await this.adminEventLogService.record({
			adminId,
			section: 'USERS',
			action: 'USER_TOGGLE_ACTIVATION',
			description:
				user.status === 'ACTIVE'
					? 'Пользователь активирован'
					: 'Пользователь деактивирован',
			entityType: 'user',
			entityId: id,
			entityLabel: user.name || user.email || user.phone || id,
			targetUserId: id,
			metadata: {
				status: user.status,
				personalDataConsentRevokedAt:
					user.personalDataConsentRevokedAt?.toISOString() ?? null
			},
			request
		});

		return user;
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Delete('user/:id')
	async deleteUser(
		@Param('id') id: string,
		@CurrentUser('id') adminId: string,
		@CurrentUser('rights') adminRights: Role[],
		@Req() request: Request
	) {
		const deletedUser = await this.userService.deleteUser(
			id,
			adminId,
			adminRights
		);

		await this.adminEventLogService.record({
			adminId,
			section: 'USERS',
			action: 'USER_SOFT_DELETE',
			description: 'Soft delete пользователя',
			entityType: 'user',
			entityId: id,
			entityLabel:
				deletedUser.name || deletedUser.email || deletedUser.phone || id,
			targetUserId: id,
			metadata: {
				targetUserId: id,
				targetUserName: deletedUser.name ?? null,
				targetUserEmail: deletedUser.email ?? null,
				deletedAt: deletedUser.deletedAt?.toISOString() ?? null
			},
			request
		});

		return deletedUser;
	}

	@HttpCode(200)
	@Auth(Role.DEV)
	@Patch('user/:id/restore')
	async restoreUser(
		@Param('id') id: string,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const restoredUser = await this.userService.restoreUser(id);

		await this.adminEventLogService.record({
			adminId,
			section: 'USERS',
			action: 'USER_RESTORE',
			description: 'Восстановление пользователя после soft delete',
			entityType: 'user',
			entityId: id,
			entityLabel:
				restoredUser.name ||
				restoredUser.email ||
				restoredUser.phone ||
				id,
			targetUserId: id,
			metadata: {
				status: restoredUser.status,
				deletedAt: null
			},
			request
		});

		return restoredUser;
	}
}
