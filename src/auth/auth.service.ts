import { randomInt } from 'node:crypto';
import { AffiliateService } from '@/affiliate/affiliate.service';
import { AuthDto } from '@/auth/dto/auth.dto';
import { EmailRegisterDto } from '@/auth/dto/email-register.dto';
import { PhoneLoginDto } from '@/auth/dto/phone-login.dto';
import { PhoneRegisterDto } from '@/auth/dto/phone-register.dto';
import { ResendEmailCodeDto } from '@/auth/dto/resend-email-code.dto';
import { RestorePasswordDto } from '@/auth/dto/restore-password.dto';
import { SendPhoneCodeDto } from '@/auth/dto/send-phone-code.dto';
import { EmailService } from '@/email/email.service';
import { PrismaService } from '@/prisma.service';
import { SmsService } from '@/sms/sms.service';
import {
	UserService,
	type UserWithAuthIdentities
} from '@/user/user.service';
import {
	PASSWORD_SALT_ROUNDS,
	USER_DEACTIVATED_MESSAGE
} from '@/utils/auth.constants';
import { normalizeEmail } from '@/utils/email.util';
import { normalizePhone } from '@/utils/phone.util';
import {
	BadRequestException,
	Injectable,
	NotFoundException,
	UnauthorizedException
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
	Plan,
	Role,
	SubscriptionStatus,
	UserStatus,
	type VerificationChallenge,
	VerificationChallengePurpose,
	VerificationChallengeType
} from '@prisma/client';
import { compare, hash } from 'bcryptjs';
import * as dayjs from 'dayjs';
import generator from 'generate-password-ts';

@Injectable()
export class AuthService {
	private readonly TOKEN_EXPIRATION_ACCESS = '1h';
	private readonly TOKEN_EXPIRATION_REFRESH = '7d';
	private readonly EMAIL_CODE_EXPIRATION_MINUTES = 10;
	private readonly EMAIL_CODE_MAX_ATTEMPTS = 5;
	private readonly EMAIL_CODE_RESEND_COOLDOWN_SECONDS = 60;
	private readonly PHONE_CODE_EXPIRATION_MINUTES = 5;
	private readonly PHONE_CODE_MAX_ATTEMPTS = 5;

	constructor(
		private jwt: JwtService,
		private userService: UserService,
		private emailService: EmailService,
		private prisma: PrismaService,
		private smsService: SmsService,
		private affiliateService: AffiliateService
	) {}

	async login(dto: AuthDto) {
		const user = await this.validateUser(dto);
		return this.buildResponseObject(user);
	}

	async register(dto: AuthDto) {
		const email = normalizeEmail(dto.email);
		const userExists = await this.userService.getUserByEmail(email);

		if (userExists) {
			throw new BadRequestException('User already exists');
		}

		const pendingRegistration =
			await this.prisma.verificationChallenge.findUnique({
				where: {
					type_purpose_value: {
						type: VerificationChallengeType.EMAIL,
						purpose: VerificationChallengePurpose.REGISTER,
						value: email
					}
				}
			});

		if (pendingRegistration) {
			this.ensureEmailCodeResendAllowed(pendingRegistration);
		}

		return this.upsertPendingEmailRegistration({
			email,
			passwordHash: await hash(dto.password, PASSWORD_SALT_ROUNDS)
		});
	}

	async registerByEmail(dto: EmailRegisterDto) {
		const email = normalizeEmail(dto.email);
		const existingUser = await this.userService.getUserByEmail(email);

		if (existingUser) {
			throw new BadRequestException('User already exists');
		}

		const pendingRegistration = await this.validateEmailCode(
			email,
			dto.code
		);
		if (!pendingRegistration.passwordHash) {
			throw new UnauthorizedException('Email verification code not found');
		}
		const user = await this.userService.createVerifiedEmailUser({
			email,
			passwordHash: pendingRegistration.passwordHash
		});

		await this.affiliateService.registerReferral(dto.referrerId, user.id);
		await this.deletePendingEmailRegistration(email);

		return this.buildResponseObject(user);
	}

	async resendEmailCode(dto: ResendEmailCodeDto) {
		const email = normalizeEmail(dto.email);
		const userExists = await this.userService.getUserByEmail(email);

		if (userExists) {
			await this.deletePendingEmailRegistration(email);
			throw new BadRequestException('User already exists');
		}

		const pendingRegistration =
			await this.prisma.verificationChallenge.findUnique({
				where: {
					type_purpose_value: {
						type: VerificationChallengeType.EMAIL,
						purpose: VerificationChallengePurpose.REGISTER,
						value: email
					}
				}
			});

		if (!pendingRegistration) {
			throw new UnauthorizedException('Email verification code not found');
		}

		if (!pendingRegistration.passwordHash) {
			await this.deletePendingEmailRegistration(email);
			throw new UnauthorizedException('Email verification code not found');
		}

		this.ensureEmailCodeResendAllowed(pendingRegistration);

		return this.upsertPendingEmailRegistration({
			email,
			passwordHash: pendingRegistration.passwordHash
		});
	}

	async sendPhoneCode(dto: SendPhoneCodeDto) {
		const phone = normalizePhone(dto.phone);
		const userExists = await this.userService.getUserByPhone(phone);

		if (userExists) {
			throw new BadRequestException('Phone already exists');
		}

		const existing = await this.prisma.verificationChallenge.findUnique({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.PHONE,
					purpose: VerificationChallengePurpose.REGISTER,
					value: phone
				}
			}
		});

		if (existing) {
			const resendAllowedAt =
				existing.lastSentAt.getTime() +
				this.PHONE_CODE_EXPIRATION_MINUTES * 60 * 1000;
			if (resendAllowedAt > Date.now()) {
				throw new BadRequestException(
					'Phone verification resend cooldown'
				);
			}
		}

		const code = this.generateCode();
		const codeHash = await hash(code, PASSWORD_SALT_ROUNDS);
		const expiresAt = new Date(
			Date.now() + this.PHONE_CODE_EXPIRATION_MINUTES * 60 * 1000
		);

		await this.prisma.verificationChallenge.upsert({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.PHONE,
					purpose: VerificationChallengePurpose.REGISTER,
					value: phone
				}
			},
			update: {
				passwordHash: null,
				codeHash,
				attempts: 0,
				expiresAt,
				lastSentAt: new Date()
			},
			create: {
				type: VerificationChallengeType.PHONE,
				purpose: VerificationChallengePurpose.REGISTER,
				value: phone,
				codeHash,
				expiresAt,
				lastSentAt: new Date()
			}
		});

		await this.smsService.sendVerificationCode(phone, code);

		return true;
	}

	async registerByPhone(dto: PhoneRegisterDto) {
		const phone = normalizePhone(dto.phone);
		const existingUser = await this.userService.getUserByPhone(phone);

		if (existingUser) {
			throw new BadRequestException('Phone already exists');
		}

		await this.validatePhoneCode(phone, dto.code);

		const user = await this.userService.createPhoneUser({
			phone,
			password: dto.password
		});

		await this.affiliateService.registerReferral(dto.referrerId, user.id);
		await this.deletePhoneCode(phone);

		return this.buildResponseObject(user);
	}

	async loginByPhone(dto: PhoneLoginDto) {
		const phone = normalizePhone(dto.phone);
		const user = await this.userService.getUserByPhone(phone);

		if (!user) {
			throw new UnauthorizedException('Email or password invalid');
		}

		const phoneIdentity = user.authIdentities.find(
			identity => identity.type === 'PHONE'
		);

		if (!phoneIdentity?.verifiedAt) {
			throw new UnauthorizedException('Phone not verified');
		}

		if (!user.password) {
			throw new UnauthorizedException('Email or password invalid');
		}

		const isValid = await compare(dto.password, user.password);
		if (!isValid) {
			throw new UnauthorizedException('Email or password invalid');
		}

		return this.buildResponseObject(user);
	}

	async getNewTokens(refreshToken: string) {
		let result: { id: string } | null = null;

		try {
			result = await this.jwt.verifyAsync<{ id: string }>(refreshToken);
		} catch {
			throw new UnauthorizedException('Invalid refresh token');
		}

		if (!result?.id) {
			throw new UnauthorizedException('Invalid refresh token');
		}

		const user = await this.userService.getUserById(result.id);
		if (!user) {
			throw new UnauthorizedException('Invalid refresh token');
		}

		this.ensureUserActive(user);

		if (!user.hashedRefreshToken) {
			throw new UnauthorizedException('Invalid refresh token');
		}

		const isValidRefreshToken = await compare(
			refreshToken,
			user.hashedRefreshToken
		);
		if (!isValidRefreshToken) {
			throw new UnauthorizedException('Invalid refresh token');
		}

		return this.buildResponseObject(user);
	}

	async logout(refreshToken?: string) {
		if (!refreshToken) {
			return true;
		}

		try {
			const result = await this.jwt.verifyAsync<{ id: string }>(
				refreshToken
			);
			if (result?.id) {
				await this.prisma.user.update({
					where: { id: result.id },
					data: { hashedRefreshToken: null }
				});
			}
		} catch {
			return true;
		}

		return true;
	}

	async restorePassword(dto: RestorePasswordDto) {
		const { email, phone } = dto;
		const normalizedEmail = email ? normalizeEmail(email) : undefined;
		const normalizedPhone = phone ? normalizePhone(phone) : undefined;
		const user = normalizedEmail
			? await this.userService.getUserByEmail(normalizedEmail)
			: normalizedPhone
				? await this.userService.getUserByPhone(normalizedPhone)
				: null;

		if (!user) {
			if (normalizedEmail) {
				const pendingRegistration =
					await this.prisma.verificationChallenge.findUnique({
						where: {
							type_purpose_value: {
								type: VerificationChallengeType.EMAIL,
								purpose: VerificationChallengePurpose.REGISTER,
								value: normalizedEmail
							}
						}
					});

				if (pendingRegistration) {
					throw new BadRequestException(
						'Email registration not completed'
					);
				}
			}

			throw new NotFoundException('User not found');
		}

		this.ensureUserActive(user);

		const newPassword = generator.generate({
			length: 12,
			uppercase: true,
			lowercase: true,
			numbers: true,
			strict: true
		});

		await this.prisma.user.update({
			where: { id: user.id },
			data: {
				password: await hash(newPassword, PASSWORD_SALT_ROUNDS),
				hashedRefreshToken: null
			}
		});

		if (normalizedEmail) {
			await this.emailService.sendNewPassword(
				normalizedEmail,
				newPassword
			);
		} else if (normalizedPhone) {
			await this.smsService.sendRestorePassword(
				normalizedPhone,
				newPassword
			);
		}
	}

	async buildResponseObject(user: UserWithAuthIdentities) {
		this.ensureUserActive(user);
		await this.ensureTrialSubscription(user.id);
		const tokens = await this.issueTokens(user.id, user.rights);
		await this.saveRefreshToken(user.id, tokens.refreshToken);
		return { user: this.userService.toPublicUser(user), ...tokens };
	}

	private async ensureTrialSubscription(userId: string) {
		const existing = await this.prisma.subscription.findUnique({
			where: { userId }
		});
		if (!existing) {
			await this.prisma.subscription.create({
				data: {
					userId,
					plan: Plan.TRIAL,
					status: SubscriptionStatus.ACTIVE,
					expiresAt: dayjs().add(7, 'day').toDate()
				}
			});
		}
	}

	private async issueTokens(userId: string, rights: Role[]) {
		const payload = { id: userId, rights };
		const accessToken = this.jwt.sign(payload, {
			expiresIn: this.TOKEN_EXPIRATION_ACCESS
		});
		const refreshToken = this.jwt.sign(payload, {
			expiresIn: this.TOKEN_EXPIRATION_REFRESH
		});
		return { accessToken, refreshToken };
	}

	private generateCode() {
		return `${randomInt(100000, 1000000)}`;
	}

	private ensureUserActive(user: Pick<UserWithAuthIdentities, 'status'>) {
		if (user.status === UserStatus.DEACTIVATED) {
			throw new UnauthorizedException(USER_DEACTIVATED_MESSAGE);
		}
	}

	private async validatePhoneCode(phone: string, code: string) {
		const verificationCode =
			await this.prisma.verificationChallenge.findUnique({
				where: {
					type_purpose_value: {
						type: VerificationChallengeType.PHONE,
						purpose: VerificationChallengePurpose.REGISTER,
						value: phone
					}
				}
			});

		if (
			!verificationCode ||
			verificationCode.expiresAt.getTime() < Date.now()
		) {
			await this.deletePhoneCode(phone);
			throw new UnauthorizedException('Phone verification code not found');
		}

		const isValidCode = await compare(code, verificationCode.codeHash);
		if (!isValidCode) {
			const nextAttempts = verificationCode.attempts + 1;

			if (nextAttempts >= this.PHONE_CODE_MAX_ATTEMPTS) {
				await this.deletePhoneCode(phone);
			} else {
				await this.prisma.verificationChallenge.update({
					where: {
						type_purpose_value: {
							type: VerificationChallengeType.PHONE,
							purpose: VerificationChallengePurpose.REGISTER,
							value: phone
						}
					},
					data: {
						attempts: nextAttempts
					}
				});
			}

			throw new UnauthorizedException('Phone verification code invalid');
		}
	}

	private async validateEmailCode(email: string, code: string) {
		const pendingRegistration =
			await this.prisma.verificationChallenge.findUnique({
				where: {
					type_purpose_value: {
						type: VerificationChallengeType.EMAIL,
						purpose: VerificationChallengePurpose.REGISTER,
						value: email
					}
				}
			});

		if (!pendingRegistration) {
			throw new UnauthorizedException('Email verification code not found');
		}

		if (pendingRegistration.expiresAt.getTime() < Date.now()) {
			await this.deletePendingEmailRegistration(email);
			throw new UnauthorizedException('Email verification code not found');
		}

		if (pendingRegistration.attempts >= this.EMAIL_CODE_MAX_ATTEMPTS) {
			throw new UnauthorizedException(
				'Email verification code attempts exceeded'
			);
		}

		const isValidCode = await compare(code, pendingRegistration.codeHash);

		if (!isValidCode) {
			const updated = await this.prisma.verificationChallenge.update({
				where: {
					type_purpose_value: {
						type: VerificationChallengeType.EMAIL,
						purpose: VerificationChallengePurpose.REGISTER,
						value: email
					}
				},
				data: { attempts: { increment: 1 } }
			});

			if (updated.attempts >= this.EMAIL_CODE_MAX_ATTEMPTS) {
				throw new UnauthorizedException(
					'Email verification code attempts exceeded'
				);
			}

			throw new UnauthorizedException('Email verification code invalid');
		}

		return pendingRegistration;
	}

	private async deletePhoneCode(phone: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				type: VerificationChallengeType.PHONE,
				purpose: VerificationChallengePurpose.REGISTER,
				value: phone
			}
		});
	}

	private async deletePendingEmailRegistration(email: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				type: VerificationChallengeType.EMAIL,
				purpose: VerificationChallengePurpose.REGISTER,
				value: email
			}
		});
	}

	private async upsertPendingEmailRegistration({
		email,
		passwordHash
	}: {
		email: string;
		passwordHash: string;
	}) {
		const code = this.generateCode();
		const now = new Date();
		const expiresAt = new Date(
			now.getTime() + this.EMAIL_CODE_EXPIRATION_MINUTES * 60 * 1000
		);
		const resendAvailableAt = new Date(
			now.getTime() + this.EMAIL_CODE_RESEND_COOLDOWN_SECONDS * 1000
		);
		const codeHash = await hash(code, PASSWORD_SALT_ROUNDS);

		await this.prisma.verificationChallenge.upsert({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.EMAIL,
					purpose: VerificationChallengePurpose.REGISTER,
					value: email
				}
			},
			update: {
				value: email,
				passwordHash,
				codeHash,
				attempts: 0,
				expiresAt,
				lastSentAt: now
			},
			create: {
				type: VerificationChallengeType.EMAIL,
				purpose: VerificationChallengePurpose.REGISTER,
				value: email,
				passwordHash,
				codeHash,
				expiresAt,
				lastSentAt: now
			}
		});

		await this.emailService.sendVerificationCode(email, code);

		return {
			email,
			expiresAt,
			resendAvailableAt
		};
	}

	private ensureEmailCodeResendAllowed(
		pendingRegistration: VerificationChallenge
	) {
		const resendAllowedAt =
			pendingRegistration.lastSentAt.getTime() +
			this.EMAIL_CODE_RESEND_COOLDOWN_SECONDS * 1000;

		if (resendAllowedAt > Date.now()) {
			throw new BadRequestException('Email verification resend cooldown');
		}
	}

	private async saveRefreshToken(userId: string, refreshToken: string) {
		await this.prisma.user.update({
			where: { id: userId },
			data: {
				hashedRefreshToken: await hash(refreshToken, PASSWORD_SALT_ROUNDS)
			}
		});
	}

	private async validateUser(dto: AuthDto) {
		const user = await this.userService.getUserByEmail(
			normalizeEmail(dto.email)
		);
		if (!user || !user.password) {
			throw new UnauthorizedException('Email or password invalid');
		}
		const isValid = await compare(dto.password, user.password);
		if (!isValid) {
			throw new UnauthorizedException('Email or password invalid');
		}
		return user;
	}
}
