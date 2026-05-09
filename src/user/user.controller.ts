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
	@Auth(Role.ADMIN)
	@Get('user-list')
	async getUserList(
		@Query('searchTerm') searchTerm?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('role') role?: string,
		@Query('registeredFrom') registeredFrom?: string,
		@Query('registeredTo') registeredTo?: string,
		@Query('subscription') subscription?: string
	) {
		return this.userService.getUserList(
			searchTerm,
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{
				role,
				registeredFrom,
				registeredTo,
				subscription
			}
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
		return this.userService.getPublicUserById(id);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch('user/:id')
	async updateUser(
		@Param('id') id: string,
		@Body() dto: UpdateUserDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const user = await this.userService.updateUser(id, dto);
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
				isAdmin: dto.isAdmin ?? null
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
		@Req() request: Request
	) {
		const user = await this.userService.toggleUserActivation(id);

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
		@Req() request: Request
	) {
		const target = await this.userService.getPublicUserById(id);
		const deletedUser = await this.userService.deleteUser(id);

		await this.adminEventLogService.record({
			adminId: adminId === id ? null : adminId,
			section: 'USERS',
			action: 'USER_DELETE',
			description: 'Удаление пользователя',
			entityType: 'user',
			entityId: id,
			entityLabel: target?.name || target?.email || target?.phone || id,
			metadata: {
				targetUserId: id,
				targetUserName: target?.name ?? null,
				targetUserEmail: target?.email ?? null
			},
			request
		});

		return deletedUser;
	}
}
