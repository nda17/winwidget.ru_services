import { randomBytes } from 'node:crypto';
import { EmailService } from '@/email/email.service';
import { PrismaService } from '@/prisma.service';
import { SmsService } from '@/sms/sms.service';
import { UserService } from '@/user/user.service';
import { normalizeEmail } from '@/utils/email.util';
import {
	PASSWORD_SALT_ROUNDS,
	TELEGRAM_AUTH_NOT_CONFIGURED,
	TELEGRAM_LAST_LOGIN_METHOD
} from '@/utils/auth.constants';
import { normalizePhone } from '@/utils/phone.util';
import {
	BadRequestException,
	Injectable,
	NotFoundException,
	UnauthorizedException
} from '@nestjs/common';
import {
	type AuthIdentity,
	AuthIdentityType,
	type VerificationChallenge,
	VerificationChallengePurpose,
	VerificationChallengeType
} from '@prisma/client';
import { compare, hash } from 'bcryptjs';

type PendingBindingResponse = {
	value: string;
	expiresAt: Date;
	resendAvailableAt: Date;
};

@Injectable()
export class UserIdentityBindingService {
	private readonly EMAIL_CODE_EXPIRATION_MINUTES = 10;
	private readonly PHONE_CODE_EXPIRATION_MINUTES = 5;
	private readonly TELEGRAM_BINDING_EXPIRATION_MINUTES = 15;
	private readonly EMAIL_CODE_MAX_ATTEMPTS = 5;
	private readonly PHONE_CODE_MAX_ATTEMPTS = 5;
	private readonly CODE_RESEND_COOLDOWN_SECONDS = 60;

	constructor(
		private prisma: PrismaService,
		private userService: UserService,
		private emailService: EmailService,
		private smsService: SmsService
	) {}

	async sendEmailCode(userId: string, email: string) {
		const normalizedEmail = normalizeEmail(email);
		await this.ensureIdentityCanBeBound({
			userId,
			type: VerificationChallengeType.EMAIL,
			value: normalizedEmail
		});

		const pendingBinding =
			await this.prisma.verificationChallenge.findUnique({
				where: {
					userId_type_purpose: {
						userId,
						type: VerificationChallengeType.EMAIL,
						purpose: VerificationChallengePurpose.BIND_IDENTITY
					}
				}
			});

		if (pendingBinding?.value === normalizedEmail) {
			this.ensureResendAllowed(
				pendingBinding,
				VerificationChallengeType.EMAIL
			);
		}

		return this.upsertPendingBinding({
			userId,
			type: VerificationChallengeType.EMAIL,
			value: normalizedEmail
		});
	}

	async verifyEmailCode(userId: string, email: string, code: string) {
		const normalizedEmail = normalizeEmail(email);
		const pendingBinding = await this.validatePendingBinding({
			userId,
			type: VerificationChallengeType.EMAIL,
			value: normalizedEmail,
			code,
			maxAttempts: this.EMAIL_CODE_MAX_ATTEMPTS
		});

		await this.ensureIdentityCanBeBound({
			userId,
			type: VerificationChallengeType.EMAIL,
			value: normalizedEmail
		});

		await this.prisma.authIdentity.upsert({
			where: {
				userId_type: {
					userId,
					type: AuthIdentityType.EMAIL
				}
			},
			update: {
				value: normalizedEmail,
				verifiedAt: new Date()
			},
			create: {
				userId,
				type: AuthIdentityType.EMAIL,
				value: normalizedEmail,
				verifiedAt: new Date()
			}
		});

		await this.deletePendingBinding(
			userId,
			VerificationChallengeType.EMAIL
		);

		return this.userService.getPublicUserById(pendingBinding.userId!);
	}

	async sendPhoneCode(userId: string, phone: string) {
		const normalizedPhone = normalizePhone(phone);
		await this.ensureIdentityCanBeBound({
			userId,
			type: VerificationChallengeType.PHONE,
			value: normalizedPhone
		});

		const pendingBinding =
			await this.prisma.verificationChallenge.findUnique({
				where: {
					userId_type_purpose: {
						userId,
						type: VerificationChallengeType.PHONE,
						purpose: VerificationChallengePurpose.BIND_IDENTITY
					}
				}
			});

		if (pendingBinding?.value === normalizedPhone) {
			this.ensureResendAllowed(
				pendingBinding,
				VerificationChallengeType.PHONE
			);
		}

		return this.upsertPendingBinding({
			userId,
			type: VerificationChallengeType.PHONE,
			value: normalizedPhone
		});
	}

	async verifyPhoneCode(userId: string, phone: string, code: string) {
		const normalizedPhone = normalizePhone(phone);
		const pendingBinding = await this.validatePendingBinding({
			userId,
			type: VerificationChallengeType.PHONE,
			value: normalizedPhone,
			code,
			maxAttempts: this.PHONE_CODE_MAX_ATTEMPTS
		});

		await this.ensureIdentityCanBeBound({
			userId,
			type: VerificationChallengeType.PHONE,
			value: normalizedPhone
		});

		await this.prisma.authIdentity.upsert({
			where: {
				userId_type: {
					userId,
					type: AuthIdentityType.PHONE
				}
			},
			update: {
				value: normalizedPhone,
				verifiedAt: new Date()
			},
			create: {
				userId,
				type: AuthIdentityType.PHONE,
				value: normalizedPhone,
				verifiedAt: new Date()
			}
		});

		await this.deletePendingBinding(
			userId,
			VerificationChallengeType.PHONE
		);

		return this.userService.getPublicUserById(pendingBinding.userId!);
	}

	async startTelegramBinding(userId: string) {
		this.ensureTelegramBotConfigured();

		const user = await this.userService.getUserById(userId);

		if (!user) {
			throw new NotFoundException('User not found');
		}

		const currentIdentity = user.authIdentities.find(
			identity => identity.type === AuthIdentityType.TELEGRAM
		);

		if (currentIdentity) {
			throw new BadRequestException('Telegram already linked');
		}

		await this.deleteExpiredTelegramBindings();

		const requestId = randomBytes(16).toString('hex');
		const codeHash = await hash(requestId, PASSWORD_SALT_ROUNDS);
		const now = new Date();
		const expiresAt = new Date(
			now.getTime() + this.TELEGRAM_BINDING_EXPIRATION_MINUTES * 60 * 1000
		);

		await this.prisma.verificationChallenge.upsert({
			where: {
				userId_type_purpose: {
					userId,
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.BIND_IDENTITY
				}
			},
			update: {
				value: requestId,
				passwordHash: null,
				codeHash,
				attempts: 0,
				telegramUserId: null,
				telegramChatId: null,
				telegramUsername: null,
				telegramFirstName: null,
				telegramLastName: null,
				expiresAt,
				lastSentAt: now
			},
			create: {
				userId,
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_IDENTITY,
				value: requestId,
				codeHash,
				expiresAt,
				lastSentAt: now
			}
		});

		return {
			requestId,
			botUrl: `https://t.me/${this.getTelegramBotUsername()}?start=${requestId}`,
			expiresAt
		};
	}

	async unlinkTelegramBinding(userId: string) {
		const user = await this.userService.getUserById(userId);

		if (!user) {
			throw new NotFoundException('User not found');
		}

		const telegramIdentity = user.authIdentities.find(
			identity => identity.type === AuthIdentityType.TELEGRAM
		);

		if (!telegramIdentity) {
			return this.userService.getPublicUserById(userId);
		}

		if (!this.hasAnotherLoginMethod(user.authIdentities)) {
			throw new BadRequestException(TELEGRAM_LAST_LOGIN_METHOD);
		}

		await this.prisma.$transaction([
			this.prisma.authIdentity.deleteMany({
				where: {
					userId,
					type: AuthIdentityType.TELEGRAM
				}
			}),
			this.prisma.verificationChallenge.deleteMany({
				where: {
					userId,
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.BIND_IDENTITY
				}
			})
		]);

		return this.userService.getPublicUserById(userId);
	}

	async cancelTelegramBinding(userId: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				userId,
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_IDENTITY
			}
		});

		return { cancelled: true };
	}

	private async upsertPendingBinding({
		userId,
		type,
		value
	}: {
		userId: string;
		type: VerificationChallengeType;
		value: string;
	}): Promise<PendingBindingResponse> {
		const code = this.generateCode();
		const now = new Date();
		const expiresAt = new Date(
			now.getTime() +
				(type === VerificationChallengeType.EMAIL
					? this.EMAIL_CODE_EXPIRATION_MINUTES
					: this.PHONE_CODE_EXPIRATION_MINUTES) *
					60 *
					1000
		);
		const resendAvailableAt = new Date(
			now.getTime() + this.CODE_RESEND_COOLDOWN_SECONDS * 1000
		);

		await this.prisma.verificationChallenge.upsert({
			where: {
				userId_type_purpose: {
					userId,
					type,
					purpose: VerificationChallengePurpose.BIND_IDENTITY
				}
			},
			update: {
				value,
				passwordHash: null,
				codeHash: await hash(code, PASSWORD_SALT_ROUNDS),
				attempts: 0,
				expiresAt,
				lastSentAt: now
			},
			create: {
				userId,
				type,
				purpose: VerificationChallengePurpose.BIND_IDENTITY,
				value,
				codeHash: await hash(code, PASSWORD_SALT_ROUNDS),
				expiresAt,
				lastSentAt: now
			}
		});

		if (type === VerificationChallengeType.EMAIL) {
			await this.emailService.sendVerificationCode(value, code);
		} else {
			await this.smsService.sendVerificationCode(value, code);
		}

		return {
			value,
			expiresAt,
			resendAvailableAt
		};
	}

	private async validatePendingBinding({
		userId,
		type,
		value,
		code,
		maxAttempts
	}: {
		userId: string;
		type: VerificationChallengeType;
		value: string;
		code: string;
		maxAttempts: number;
	}) {
		const pendingBinding =
			await this.prisma.verificationChallenge.findUnique({
				where: {
					userId_type_purpose: {
						userId,
						type,
						purpose: VerificationChallengePurpose.BIND_IDENTITY
					}
				}
			});

		if (
			!pendingBinding ||
			pendingBinding.value !== value ||
			pendingBinding.expiresAt.getTime() < Date.now()
		) {
			await this.deletePendingBinding(userId, type);
			throw new UnauthorizedException(this.getCodeNotFoundError(type));
		}

		const isValidCode = await compare(code, pendingBinding.codeHash);

		if (!isValidCode) {
			const nextAttempts = pendingBinding.attempts + 1;

			if (nextAttempts >= maxAttempts) {
				await this.deletePendingBinding(userId, type);
				throw new UnauthorizedException(
					this.getAttemptsExceededError(type)
				);
			}

			await this.prisma.verificationChallenge.update({
				where: {
					userId_type_purpose: {
						userId,
						type,
						purpose: VerificationChallengePurpose.BIND_IDENTITY
					}
				},
				data: {
					attempts: nextAttempts
				}
			});

			throw new UnauthorizedException(this.getCodeInvalidError(type));
		}

		return pendingBinding;
	}

	private async ensureIdentityCanBeBound({
		userId,
		type,
		value
	}: {
		userId: string;
		type: VerificationChallengeType;
		value: string;
	}) {
		const user = await this.userService.getUserById(userId);

		if (!user) {
			throw new NotFoundException('User not found');
		}

		const authType = this.toAuthIdentityType(type);
		const currentIdentity = user.authIdentities.find(
			identity => identity.type === authType
		);

		if (currentIdentity?.value === value) {
			if (
				type === VerificationChallengeType.PHONE &&
				!currentIdentity.verifiedAt
			) {
				return;
			}

			throw new BadRequestException(
				type === VerificationChallengeType.EMAIL
					? 'Email already linked'
					: 'Phone already linked'
			);
		}

		const existingIdentity =
			type === VerificationChallengeType.EMAIL
				? await this.prisma.authIdentity.findFirst({
						where: {
							type: authType,
							value: {
								equals: value,
								mode: 'insensitive'
							}
						}
					})
				: await this.prisma.authIdentity.findUnique({
						where: {
							type_value: {
								type: authType,
								value
							}
						}
					});

		if (existingIdentity && existingIdentity.userId !== userId) {
			throw new NotFoundException(
				type === VerificationChallengeType.EMAIL
					? 'Email busy'
					: 'Phone busy'
			);
		}

		const pendingBinding =
			type === VerificationChallengeType.EMAIL
				? await this.prisma.verificationChallenge.findFirst({
						where: {
							type,
							purpose: VerificationChallengePurpose.BIND_IDENTITY,
							value: {
								equals: value,
								mode: 'insensitive'
							}
						}
					})
				: await this.prisma.verificationChallenge.findUnique({
						where: {
							type_purpose_value: {
								type,
								purpose: VerificationChallengePurpose.BIND_IDENTITY,
								value
							}
						}
					});

		if (
			pendingBinding &&
			pendingBinding.expiresAt.getTime() < Date.now()
		) {
			await this.prisma.verificationChallenge.deleteMany({
				where: {
					id: pendingBinding.id
				}
			});
			return;
		}

		if (pendingBinding && pendingBinding.userId !== userId) {
			throw new NotFoundException(
				type === VerificationChallengeType.EMAIL
					? 'Email busy'
					: 'Phone busy'
			);
		}
	}

	private ensureResendAllowed(
		pendingBinding: VerificationChallenge,
		type: VerificationChallengeType
	) {
		const resendAllowedAt =
			pendingBinding.lastSentAt.getTime() +
			this.CODE_RESEND_COOLDOWN_SECONDS * 1000;

		if (resendAllowedAt > Date.now()) {
			throw new BadRequestException(
				type === VerificationChallengeType.EMAIL
					? 'Email verification resend cooldown'
					: 'Phone verification resend cooldown'
			);
		}
	}

	private async deletePendingBinding(
		userId: string,
		type: VerificationChallengeType
	) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				userId,
				type,
				purpose: VerificationChallengePurpose.BIND_IDENTITY
			}
		});
	}

	private getCodeNotFoundError(type: VerificationChallengeType) {
		return type === VerificationChallengeType.EMAIL
			? 'Email verification code not found'
			: 'Phone verification code not found';
	}

	private getCodeInvalidError(type: VerificationChallengeType) {
		return type === VerificationChallengeType.EMAIL
			? 'Email verification code invalid'
			: 'Phone verification code invalid';
	}

	private getAttemptsExceededError(type: VerificationChallengeType) {
		return type === VerificationChallengeType.EMAIL
			? 'Email verification code attempts exceeded'
			: 'Phone verification code attempts exceeded';
	}

	private toAuthIdentityType(type: VerificationChallengeType) {
		return type === VerificationChallengeType.EMAIL
			? AuthIdentityType.EMAIL
			: AuthIdentityType.PHONE;
	}

	private async deleteExpiredTelegramBindings() {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_IDENTITY,
				expiresAt: {
					lt: new Date()
				}
			}
		});
	}

	private ensureTelegramBotConfigured() {
		if (!process.env.TELEGRAM_AUTH_BOT_TOKEN?.trim()) {
			throw new BadRequestException(TELEGRAM_AUTH_NOT_CONFIGURED);
		}

		if (!this.getTelegramBotUsername()) {
			throw new BadRequestException(TELEGRAM_AUTH_NOT_CONFIGURED);
		}
	}

	private getTelegramBotUsername() {
		return (
			process.env.TELEGRAM_AUTH_BOT_USERNAME?.trim().replace(/^@/, '') ??
			''
		);
	}

	private hasAnotherLoginMethod(identities: AuthIdentity[]) {
		return identities.some(identity => {
			if (!identity.value.trim()) return false;
			if (identity.type === AuthIdentityType.TELEGRAM) return false;
			if (identity.type === AuthIdentityType.PHONE) {
				return Boolean(identity.verifiedAt);
			}

			return true;
		});
	}

	private generateCode() {
		return `${Math.floor(100000 + Math.random() * 900000)}`;
	}
}
