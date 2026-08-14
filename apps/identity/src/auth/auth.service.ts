import {
	BadRequestException,
	Injectable,
	NotFoundException,
	UnauthorizedException
} from '@nestjs/common';
import {
	AuthIdentityType,
	Prisma,
	UserStatus,
	VerificationChallengePurpose,
	VerificationChallengeType,
	type VerificationChallenge
} from '@prisma/identity-client';
import { compare, hash } from 'bcryptjs';
import { randomInt, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import {
	clientIp,
	normalizeEmail,
	normalizePhone,
	PASSWORD_SALT_ROUNDS,
	USER_DEACTIVATED_MESSAGE,
	verificationCode
} from '../common/identity.util';
import {
	IdentityEventsService,
	publicUser
} from '../events/identity-events.service';
import { OwnerClientsService } from '../integrations/owner-clients.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { VerificationTransportService } from '../transports/verification-transport.service';
import { UsersService } from '../users/users.service';
import { AccessJwtService } from './access-jwt.service';
import {
	AuthDto,
	EmailRegisterDto,
	PhoneDto,
	PhoneLoginDto,
	PhoneRegisterDto,
	ResendEmailCodeDto,
	RestorePasswordDto
} from './auth.dto';
import { RefreshTokenService } from './refresh-token.service';

const USER_INCLUDE = {
	authIdentities: true,
	telegramNotificationChannel: true
} satisfies Prisma.UserInclude;

@Injectable()
export class AuthService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly users: UsersService,
		private readonly jwt: AccessJwtService,
		private readonly refreshTokens: RefreshTokenService,
		private readonly events: IdentityEventsService,
		private readonly transport: VerificationTransportService,
		private readonly owners: OwnerClientsService
	) {}

	async login(dto: AuthDto, request?: Request) {
		const email = normalizeEmail(dto.email);
		const user = await this.users.findByIdentity(
			AuthIdentityType.EMAIL,
			email
		);
		if (
			!user ||
			!user.password ||
			!(await compare(dto.password, user.password))
		) {
			throw new UnauthorizedException('Email or password invalid');
		}
		this.ensureActive(user);
		return this.startSession(user, request);
	}

	async register(dto: AuthDto) {
		const email = normalizeEmail(dto.email);
		if (await this.users.findByIdentity(AuthIdentityType.EMAIL, email)) {
			throw new BadRequestException('User already exists');
		}
		const existing = await this.prisma.verificationChallenge.findUnique({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.EMAIL,
					purpose: VerificationChallengePurpose.REGISTER,
					value: email
				}
			}
		});
		if (existing) this.ensureResend(existing, 60);
		const code = verificationCode();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 10 * 60_000);
		const resendAvailableAt = new Date(now.getTime() + 60_000);
		await this.prisma.verificationChallenge.upsert({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.EMAIL,
					purpose: VerificationChallengePurpose.REGISTER,
					value: email
				}
			},
			create: {
				type: VerificationChallengeType.EMAIL,
				purpose: VerificationChallengePurpose.REGISTER,
				value: email,
				passwordHash: await hash(dto.password, PASSWORD_SALT_ROUNDS),
				codeHash: await hash(code, PASSWORD_SALT_ROUNDS),
				expiresAt,
				lastSentAt: now
			},
			update: {
				passwordHash: await hash(dto.password, PASSWORD_SALT_ROUNDS),
				codeHash: await hash(code, PASSWORD_SALT_ROUNDS),
				attempts: 0,
				expiresAt,
				lastSentAt: now
			}
		});
		await this.transport.emailCode(email, code);
		return { email, expiresAt, resendAvailableAt };
	}

	async resendEmailCode(dto: ResendEmailCodeDto) {
		const email = normalizeEmail(dto.email);
		if (await this.users.findByIdentity(AuthIdentityType.EMAIL, email)) {
			await this.deleteRegistrationChallenge(
				VerificationChallengeType.EMAIL,
				email
			);
			throw new BadRequestException('User already exists');
		}
		const challenge = await this.registrationChallenge(
			VerificationChallengeType.EMAIL,
			email
		);
		if (!challenge?.passwordHash) {
			throw new UnauthorizedException('Email verification code not found');
		}
		this.ensureResend(challenge, 60);
		const code = verificationCode();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 10 * 60_000);
		const resendAvailableAt = new Date(now.getTime() + 60_000);
		await this.prisma.verificationChallenge.update({
			where: { id: challenge.id },
			data: {
				codeHash: await hash(code, PASSWORD_SALT_ROUNDS),
				attempts: 0,
				expiresAt,
				lastSentAt: now
			}
		});
		await this.transport.emailCode(email, code);
		return { email, expiresAt, resendAvailableAt };
	}

	async registerByEmail(dto: EmailRegisterDto, request?: Request) {
		const email = normalizeEmail(dto.email);
		if (await this.users.findByIdentity(AuthIdentityType.EMAIL, email)) {
			throw new BadRequestException('User already exists');
		}
		const challenge = await this.validateRegistrationChallenge(
			VerificationChallengeType.EMAIL,
			email,
			dto.code,
			true
		);
		const user = await this.prisma.$transaction(async transaction => {
			if (
				await transaction.authIdentity.findUnique({
					where: {
						type_value: { type: AuthIdentityType.EMAIL, value: email }
					}
				})
			) {
				throw new BadRequestException('User already exists');
			}
			const consumed = await transaction.verificationChallenge.deleteMany({
				where: {
					id: challenge.id,
					codeHash: challenge.codeHash,
					attempts: challenge.attempts,
					expiresAt: { gt: new Date() }
				}
			});
			if (consumed.count !== 1) {
				throw new UnauthorizedException(
					'Email verification code not found'
				);
			}
			const created = await transaction.user.create({
				data: {
					password: challenge.passwordHash!,
					authIdentities: {
						create: {
							type: AuthIdentityType.EMAIL,
							value: email,
							verifiedAt: new Date()
						}
					}
				},
				include: USER_INCLUDE
			});
			await this.captureReferral(transaction, dto.referrerId, created.id);
			await this.events.emitUserChanged(transaction, created.id);
			return created;
		});
		return this.startSession(user, request);
	}

	async sendPhoneCode(dto: PhoneDto) {
		const phone = normalizePhone(dto.phone);
		if (await this.users.findByIdentity(AuthIdentityType.PHONE, phone)) {
			throw new BadRequestException('Phone already exists');
		}
		const existing = await this.registrationChallenge(
			VerificationChallengeType.PHONE,
			phone
		);
		if (existing) this.ensureResend(existing, 5 * 60);
		const code = verificationCode();
		await this.prisma.verificationChallenge.upsert({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.PHONE,
					purpose: VerificationChallengePurpose.REGISTER,
					value: phone
				}
			},
			create: {
				type: VerificationChallengeType.PHONE,
				purpose: VerificationChallengePurpose.REGISTER,
				value: phone,
				codeHash: await hash(code, PASSWORD_SALT_ROUNDS),
				expiresAt: new Date(Date.now() + 5 * 60_000)
			},
			update: {
				codeHash: await hash(code, PASSWORD_SALT_ROUNDS),
				attempts: 0,
				expiresAt: new Date(Date.now() + 5 * 60_000),
				lastSentAt: new Date()
			}
		});
		await this.transport.smsCode(phone, code);
		return true;
	}

	async registerByPhone(dto: PhoneRegisterDto, request?: Request) {
		const phone = normalizePhone(dto.phone);
		if (await this.users.findByIdentity(AuthIdentityType.PHONE, phone)) {
			throw new BadRequestException('Phone already exists');
		}
		const passwordHash = await hash(dto.password, PASSWORD_SALT_ROUNDS);
		const challenge = await this.validateRegistrationChallenge(
			VerificationChallengeType.PHONE,
			phone,
			dto.code
		);
		const user = await this.prisma.$transaction(async transaction => {
			if (
				await transaction.authIdentity.findUnique({
					where: {
						type_value: { type: AuthIdentityType.PHONE, value: phone }
					}
				})
			) {
				throw new BadRequestException('Phone already exists');
			}
			const consumed = await transaction.verificationChallenge.deleteMany({
				where: {
					id: challenge.id,
					codeHash: challenge.codeHash,
					attempts: challenge.attempts,
					expiresAt: { gt: new Date() }
				}
			});
			if (consumed.count !== 1) {
				throw new UnauthorizedException(
					'Phone verification code not found'
				);
			}
			const created = await transaction.user.create({
				data: {
					password: passwordHash,
					authIdentities: {
						create: {
							type: AuthIdentityType.PHONE,
							value: phone,
							verifiedAt: new Date()
						}
					}
				},
				include: USER_INCLUDE
			});
			await this.captureReferral(transaction, dto.referrerId, created.id);
			await this.events.emitUserChanged(transaction, created.id);
			return created;
		});
		return this.startSession(user, request);
	}

	async loginByPhone(dto: PhoneLoginDto, request?: Request) {
		const user = await this.users.findByIdentity(
			AuthIdentityType.PHONE,
			normalizePhone(dto.phone)
		);
		const phoneIdentity = user?.authIdentities.find(
			item => item.type === 'PHONE'
		);
		if (!user) {
			throw new UnauthorizedException('Email or password invalid');
		}
		if (!phoneIdentity?.verifiedAt) {
			throw new UnauthorizedException('Phone not verified');
		}
		if (!user.password || !(await compare(dto.password, user.password))) {
			throw new UnauthorizedException('Email or password invalid');
		}
		this.ensureActive(user);
		return this.startSession(user, request);
	}

	async refresh(token: string) {
		const parsed = this.refreshTokens.parse(token);
		if (!parsed) throw new UnauthorizedException('Invalid refresh token');
		const session = await this.prisma.userSession.findUnique({
			where: { id: parsed.sessionId },
			include: { user: { include: USER_INCLUDE } }
		});
		if (
			!session ||
			session.revokedAt ||
			session.expiresAt <= new Date() ||
			!(await compare(
				this.refreshTokens.hashInput(token),
				session.refreshTokenHash
			))
		) {
			throw new UnauthorizedException('Invalid refresh token');
		}
		this.ensureActive(session.user);
		const rotated = this.refreshTokens.create(session.id);
		const changed = await this.prisma.userSession.updateMany({
			where: {
				id: session.id,
				refreshTokenHash: session.refreshTokenHash,
				revokedAt: null,
				expiresAt: { gt: new Date() }
			},
			data: {
				refreshTokenHash: await hash(
					this.refreshTokens.hashInput(rotated),
					PASSWORD_SALT_ROUNDS
				),
				lastUsedAt: new Date()
			}
		});
		if (changed.count !== 1) {
			await this.revokeSessionUnsafe(session.id);
			throw new UnauthorizedException('Invalid refresh token');
		}
		return {
			user: publicUser(session.user),
			accessToken: this.jwt.issue(
				session.user.id,
				session.user.rights,
				session.id
			),
			refreshToken: rotated
		};
	}

	async logout(token?: string) {
		const parsed = token ? this.refreshTokens.parse(token) : null;
		if (!parsed || !token) return true;
		const session = await this.prisma.userSession.findUnique({
			where: { id: parsed.sessionId }
		});
		if (
			session &&
			!session.revokedAt &&
			(await compare(
				this.refreshTokens.hashInput(token),
				session.refreshTokenHash
			))
		) {
			await this.revokeSessionUnsafe(session.id);
		}
		return true;
	}

	async restorePassword(dto: RestorePasswordDto) {
		const email = dto.email ? normalizeEmail(dto.email) : undefined;
		const phone = dto.phone ? normalizePhone(dto.phone) : undefined;
		if (!email && !phone) {
			throw new NotFoundException('Email or phone not passed');
		}
		const user = email
			? await this.users.findByIdentity(AuthIdentityType.EMAIL, email)
			: phone
				? await this.users.findByIdentity(AuthIdentityType.PHONE, phone)
				: null;
		if (!user) {
			if (email) {
				const pending = await this.registrationChallenge(
					VerificationChallengeType.EMAIL,
					email
				);
				if (pending) {
					throw new BadRequestException(
						'Email registration not completed'
					);
				}
			}
			throw new NotFoundException('User not found');
		}
		this.ensureActive(user);
		if (
			phone &&
			!user.authIdentities.find(
				identity =>
					identity.type === AuthIdentityType.PHONE && identity.verifiedAt
			)
		) {
			throw new UnauthorizedException('Phone not verified');
		}
		const password = this.strongPassword();
		await this.prisma.$transaction(async transaction => {
			await transaction.user.update({
				where: { id: user.id },
				data: { password: await hash(password, PASSWORD_SALT_ROUNDS) }
			});
			await transaction.userSession.updateMany({
				where: { userId: user.id, revokedAt: null },
				data: { revokedAt: new Date() }
			});
			await this.events.emitUserChanged(transaction, user.id);
		});
		if (email) await this.transport.newPassword(email, password);
		else await this.transport.smsPassword(phone!, password);
	}

	async sessions(userId: string, currentSessionId: string) {
		const sessions = await this.prisma.userSession.findMany({
			where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
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

	async revokeSession(
		userId: string,
		sessionId: string,
		currentSessionId: string
	) {
		const changed = await this.prisma.userSession.updateMany({
			where: { id: sessionId, userId, revokedAt: null },
			data: { revokedAt: new Date() }
		});
		if (!changed.count) throw new NotFoundException('Session not found');
		return { currentSessionRevoked: sessionId === currentSessionId };
	}

	async revokeAll(userId: string) {
		await this.prisma.userSession.updateMany({
			where: { userId, revokedAt: null },
			data: { revokedAt: new Date() }
		});
		return true;
	}

	async startSession(
		user: Awaited<ReturnType<UsersService['findById']>> & object,
		request?: Request
	) {
		this.ensureActive(user);
		await this.owners.ensureTrial(user.id, user.createdAt);
		const sessionId = randomUUID();
		const refreshToken = this.refreshTokens.create(sessionId);
		await this.prisma.userSession.create({
			data: {
				id: sessionId,
				userId: user.id,
				refreshTokenHash: await hash(
					this.refreshTokens.hashInput(refreshToken),
					PASSWORD_SALT_ROUNDS
				),
				userAgent: request?.get('user-agent')?.slice(0, 500),
				ipAddress: request ? clientIp(request) : undefined,
				expiresAt: new Date(Date.now() + 7 * 86_400_000)
			}
		});
		return {
			user: publicUser(user),
			accessToken: this.jwt.issue(user.id, user.rights, sessionId),
			refreshToken
		};
	}

	private ensureActive(user: {
		status: UserStatus;
		deletedAt: Date | null;
	}) {
		if (user.status !== UserStatus.ACTIVE || user.deletedAt) {
			throw new UnauthorizedException(USER_DEACTIVATED_MESSAGE);
		}
	}

	private registrationChallenge(
		type: VerificationChallengeType,
		value: string
	) {
		return this.prisma.verificationChallenge.findUnique({
			where: {
				type_purpose_value: {
					type,
					purpose: VerificationChallengePurpose.REGISTER,
					value
				}
			}
		});
	}

	private async deleteRegistrationChallenge(
		type: VerificationChallengeType,
		value: string
	) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				type,
				purpose: VerificationChallengePurpose.REGISTER,
				value
			}
		});
	}

	private ensureResend(challenge: VerificationChallenge, seconds: number) {
		if (challenge.lastSentAt.getTime() + seconds * 1_000 > Date.now()) {
			throw new BadRequestException(
				challenge.type === VerificationChallengeType.PHONE
					? 'Phone verification resend cooldown'
					: 'Email verification resend cooldown'
			);
		}
	}

	private async validateRegistrationChallenge(
		type: VerificationChallengeType,
		value: string,
		code: string,
		requirePassword = false
	): Promise<VerificationChallenge> {
		const label =
			type === VerificationChallengeType.EMAIL ? 'Email' : 'Phone';
		const challenge = await this.registrationChallenge(type, value);
		if (
			!challenge ||
			challenge.expiresAt <= new Date() ||
			(requirePassword && !challenge.passwordHash)
		) {
			if (challenge) {
				await this.deleteRegistrationChallenge(type, value);
			}
			throw new UnauthorizedException(
				`${label} verification code not found`
			);
		}
		if (challenge.attempts >= 5) {
			throw new UnauthorizedException(
				`${label} verification code attempts exceeded`
			);
		}
		if (!(await compare(code, challenge.codeHash))) {
			const changed = await this.prisma.verificationChallenge.updateMany({
				where: {
					id: challenge.id,
					codeHash: challenge.codeHash,
					attempts: challenge.attempts,
					expiresAt: { gt: new Date() }
				},
				data: { attempts: { increment: 1 } }
			});
			if (changed.count !== 1) {
				throw new UnauthorizedException(
					`${label} verification code not found`
				);
			}
			if (challenge.attempts + 1 >= 5) {
				throw new UnauthorizedException(
					`${label} verification code attempts exceeded`
				);
			}
			throw new UnauthorizedException(
				`${label} verification code invalid`
			);
		}
		return challenge;
	}

	private async captureReferral(
		transaction: Prisma.TransactionClient,
		referrerId: string | undefined,
		referredUserId: string
	) {
		const value = referrerId?.trim();
		if (!value || value === referredUserId || value.length > 128) return;
		const referrer = await transaction.user.findFirst({
			where: { id: value, status: UserStatus.ACTIVE, deletedAt: null },
			select: { id: true }
		});
		if (!referrer) return;
		await this.events.emitBillingRequest(transaction, {
			eventType: 'billing.referral.requested.v1',
			aggregateType: 'billing.referral-request',
			aggregateId: referredUserId,
			state: {
				referrerId: value,
				referredUserId,
				requestedAt: new Date().toISOString()
			}
		});
	}

	private revokeSessionUnsafe(sessionId: string) {
		return this.prisma.userSession.updateMany({
			where: { id: sessionId, revokedAt: null },
			data: { revokedAt: new Date() }
		});
	}

	private strongPassword(): string {
		const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
		const lower = 'abcdefghijkmnopqrstuvwxyz';
		const numbers = '23456789';
		const all = upper + lower + numbers;
		const chars = [
			upper[randomInt(upper.length)],
			lower[randomInt(lower.length)],
			numbers[randomInt(numbers.length)]
		];
		while (chars.length < 12) chars.push(all[randomInt(all.length)]);
		for (let index = chars.length - 1; index > 0; index -= 1) {
			const other = randomInt(index + 1);
			[chars[index], chars[other]] = [chars[other], chars[index]];
		}
		return chars.join('');
	}
}
