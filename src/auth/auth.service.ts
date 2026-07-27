import { randomInt, randomUUID } from 'node:crypto';
import { AffiliateService } from '@/affiliate/affiliate.service';
import { AccessJwtService } from '@/auth/access-jwt.service';
import { AuthDto } from '@/auth/dto/auth.dto';
import { EmailRegisterDto } from '@/auth/dto/email-register.dto';
import {
	createOpaqueRefreshToken,
	getOpaqueRefreshTokenHashInput,
	parseOpaqueRefreshToken
} from '@/auth/opaque-refresh-token';
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
import { getClientIp } from '@/utils/ip.util';
import { normalizePhone } from '@/utils/phone.util';
import {
	BadRequestException,
	Injectable,
	NotFoundException,
	UnauthorizedException
} from '@nestjs/common';
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
import type { Request } from 'express';

@Injectable()
export class AuthService {
	private readonly SESSION_EXPIRATION_DAYS = 7;
	private readonly EMAIL_CODE_EXPIRATION_MINUTES = 10;
	private readonly EMAIL_CODE_MAX_ATTEMPTS = 5;
	private readonly EMAIL_CODE_RESEND_COOLDOWN_SECONDS = 60;
	private readonly PHONE_CODE_EXPIRATION_MINUTES = 5;
	private readonly PHONE_CODE_MAX_ATTEMPTS = 5;

	constructor(
		private readonly accessJwtService: AccessJwtService,
		private userService: UserService,
		private emailService: EmailService,
		private prisma: PrismaService,
		private smsService: SmsService,
		private affiliateService: AffiliateService
	) {}

	async login(dto: AuthDto, request?: Request) {
		const user = await this.validateUser(dto);
		return this.buildResponseObject(user, request);
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

	async registerByEmail(dto: EmailRegisterDto, request?: Request) {
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

		return this.buildResponseObject(user, request);
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

	async registerByPhone(dto: PhoneRegisterDto, request?: Request) {
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

		return this.buildResponseObject(user, request);
	}

	async loginByPhone(dto: PhoneLoginDto, request?: Request) {
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

		return this.buildResponseObject(user, request);
	}

	async refreshSession(refreshToken: string) {
		const parsedToken = parseOpaqueRefreshToken(refreshToken);

		if (!parsedToken) {
			throw new UnauthorizedException('Invalid refresh token');
		}

		const session = await this.prisma.userSession.findUnique({
			where: { id: parsedToken.sessionId }
		});

		if (
			!session ||
			session.revokedAt ||
			session.expiresAt.getTime() <= Date.now()
		) {
			throw new UnauthorizedException('Invalid refresh token');
		}

		const isValidRefreshToken = await compare(
			getOpaqueRefreshTokenHashInput(refreshToken),
			session.refreshTokenHash
		);
		if (!isValidRefreshToken) {
			throw new UnauthorizedException('Invalid refresh token');
		}

		const user = await this.userService.getUserById(session.userId);
		if (!user) {
			await this.revokeCompromisedSession(session.id);
			throw new UnauthorizedException('Invalid refresh token');
		}

		if (user.status === UserStatus.DEACTIVATED) {
			await this.revokeCompromisedSession(session.id);
		}

		this.ensureUserActive(user);

		const rotatedRefreshToken = createOpaqueRefreshToken(session.id);
		const rotatedRefreshTokenHash = await hash(
			getOpaqueRefreshTokenHashInput(rotatedRefreshToken),
			PASSWORD_SALT_ROUNDS
		);
		const rotatedAt = new Date();
		const rotationResult = await this.prisma.userSession.updateMany({
			where: {
				id: session.id,
				userId: user.id,
				refreshTokenHash: session.refreshTokenHash,
				revokedAt: null,
				expiresAt: { gt: rotatedAt }
			},
			data: {
				refreshTokenHash: rotatedRefreshTokenHash,
				lastUsedAt: rotatedAt
			}
		});

		if (rotationResult.count !== 1) {
			await this.revokeCompromisedSession(session.id);
			throw new UnauthorizedException('Invalid refresh token');
		}

		const accessToken = this.accessJwtService.issueAccessToken(
			user.id,
			user.rights,
			session.id
		);

		return {
			user: this.userService.toPublicUser(user),
			accessToken,
			refreshToken: rotatedRefreshToken
		};
	}

	async logout(refreshToken?: string) {
		const parsedToken = refreshToken
			? parseOpaqueRefreshToken(refreshToken)
			: null;

		if (!refreshToken || !parsedToken) {
			return true;
		}

		const session = await this.prisma.userSession.findUnique({
			where: { id: parsedToken.sessionId }
		});

		if (
			!session ||
			session.revokedAt ||
			!(await compare(
				getOpaqueRefreshTokenHashInput(refreshToken),
				session.refreshTokenHash
			))
		) {
			return true;
		}

		const revokeResult = await this.prisma.userSession.updateMany({
			where: {
				id: session.id,
				refreshTokenHash: session.refreshTokenHash,
				revokedAt: null
			},
			data: { revokedAt: new Date() }
		});

		if (revokeResult.count !== 1) {
			await this.revokeCompromisedSession(session.id);
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

		await this.prisma.$transaction([
			this.prisma.user.update({
				where: { id: user.id },
				data: {
					password: await hash(newPassword, PASSWORD_SALT_ROUNDS)
				}
			}),
			this.prisma.userSession.updateMany({
				where: { userId: user.id, revokedAt: null },
				data: { revokedAt: new Date() }
			})
		]);

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

	async buildResponseObject(
		user: UserWithAuthIdentities,
		request?: Request
	) {
		this.ensureUserActive(user);
		await this.ensureTrialSubscription(user.id);
		const sessionId = randomUUID();
		const tokens = this.issueTokens(user.id, user.rights, sessionId);
		const expiresAt = dayjs()
			.add(this.SESSION_EXPIRATION_DAYS, 'day')
			.toDate();

		await this.prisma.userSession.create({
			data: {
				id: sessionId,
				userId: user.id,
				refreshTokenHash: await hash(
					getOpaqueRefreshTokenHashInput(tokens.refreshToken),
					PASSWORD_SALT_ROUNDS
				),
				userAgent: request?.get('user-agent')?.slice(0, 500),
				ipAddress: request ? getClientIp(request) : undefined,
				expiresAt
			}
		});
		return { user: this.userService.toPublicUser(user), ...tokens };
	}

	async getSessions(userId: string, currentSessionId: string) {
		const sessions = await this.prisma.userSession.findMany({
			where: {
				userId,
				revokedAt: null,
				expiresAt: { gt: new Date() }
			},
			orderBy: { lastUsedAt: 'desc' }
		});

		return sessions.map(session => ({
			id: session.id,
			userAgent: session.userAgent,
			ipAddress: session.ipAddress,
			createdAt: session.createdAt,
			lastUsedAt: session.lastUsedAt,
			expiresAt: session.expiresAt,
			isCurrent: session.id === currentSessionId
		}));
	}

	async revokeSession(userId: string, sessionId: string) {
		const result = await this.prisma.userSession.updateMany({
			where: { id: sessionId, userId, revokedAt: null },
			data: { revokedAt: new Date() }
		});

		if (result.count === 0) {
			throw new NotFoundException('Session not found');
		}

		return true;
	}

	async revokeAllSessions(userId: string) {
		await this.prisma.userSession.updateMany({
			where: { userId, revokedAt: null },
			data: { revokedAt: new Date() }
		});

		return true;
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

	private issueTokens(userId: string, rights: Role[], sessionId: string) {
		return {
			accessToken: this.accessJwtService.issueAccessToken(
				userId,
				rights,
				sessionId
			),
			refreshToken: createOpaqueRefreshToken(sessionId)
		};
	}

	private async revokeCompromisedSession(sessionId: string) {
		await this.prisma.userSession.updateMany({
			where: { id: sessionId, revokedAt: null },
			data: { revokedAt: new Date() }
		});
	}

	private generateCode() {
		return `${randomInt(100000, 1000000)}`;
	}

	private ensureUserActive(
		user: Pick<UserWithAuthIdentities, 'status' | 'deletedAt'>
	) {
		if (user.status === UserStatus.DEACTIVATED || user.deletedAt) {
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
