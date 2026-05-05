import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { SendProfileEmailCodeDto } from '@/user/dto/send-profile-email-code.dto';
import { SendProfilePhoneCodeDto } from '@/user/dto/send-profile-phone-code.dto';
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
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('users')
export class UserController {
	constructor(
		private readonly userService: UserService,
		private readonly userIdentityBindingService: UserIdentityBindingService
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
	@Auth(Role.ADMIN)
	@Get('user-list')
	async getUserList(
		@Query('searchTerm') searchTerm?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.userService.getUserList(
			searchTerm,
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20
		);
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
	async updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
		return this.userService.updateUser(id, dto);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch('user/:id/toggle-activation')
	async toggleUserActivation(@Param('id') id: string) {
		return this.userService.toggleUserActivation(id);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Delete('user/:id')
	async deleteUser(@Param('id') id: string) {
		return this.userService.deleteUser(id);
	}
}
