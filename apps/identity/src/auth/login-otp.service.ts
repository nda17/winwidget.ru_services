import {
	BadRequestException,
	HttpException,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	AuthIdentityType,
	Prisma,
	UserStatus
} from '@prisma/identity-client';
import { compare, hash } from 'bcryptjs';
import { isEmail } from 'class-validator';
import type { Request } from 'express';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
	normalizeEmail,
	normalizePhone,
	PASSWORD_SALT_ROUNDS,
	randomToken,
	safeEqual,
	sha256,
	verificationCode
} from '../common/identity.util';
import { publicUser } from '../events/identity-events.service';
import { OwnerClientsService } from '../integrations/owner-clients.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { VerificationTransportService } from '../transports/verification-transport.service';
import { AccessJwtService } from './access-jwt.service';
import {
	LoginOtpChannel,
	RequestLoginOtpDto,
	VerifyLoginOtpDto
} from './login-otp.dto';
import { RefreshTokenService } from './refresh-token.service';

export const LOGIN_OTP_POLICY = Object.freeze({
	codeLength: 6,
	expiresInSeconds: 300,
	resendAfterSeconds: 60,
	maxAttempts: 5,
	responseFloorMs: 5_000
});

type Bucket = { key: string; limit: number; windowMs: number };

const USER_INCLUDE = {
	authIdentities: true,
	telegramNotificationChannel: true
} satisfies Prisma.UserInclude;

function unavailable() {
	return new ServiceUnavailableException({
		code: 'login_otp_unavailable',
		message:
			'Вход по коду временно недоступен. Попробуйте другой способ входа.'
	});
}

function invalid() {
	return new UnauthorizedException({
		code: 'login_otp_invalid',
		message:
			'Код недействителен или истёк. Проверьте код или запросите новый.'
	});
}

/** This is a separate passwordless authenticator, never a CAPTCHA bypass. */
@Injectable()
export class LoginOtpService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly config: ConfigService,
		private readonly transport: VerificationTransportService,
		private readonly jwt: AccessJwtService,
		private readonly refresh: RefreshTokenService,
		private readonly owners: OwnerClientsService
	) {}

	async capabilities() {
		let channels = this.channels();
		if (channels.length) {
			try {
				await this.prisma
					.$queryRaw`SELECT c.browser_token_hash, c.identity_verified_at, r.count FROM identity.login_otp_challenges c FULL JOIN identity.login_otp_rate_limits r ON false LIMIT 0`;
			} catch {
				channels = [];
			}
		}
		return {
			available: channels.length > 0,
			channels,
			codeLength: LOGIN_OTP_POLICY.codeLength,
			expiresInSeconds: LOGIN_OTP_POLICY.expiresInSeconds,
			resendAfterSeconds: LOGIN_OTP_POLICY.resendAfterSeconds
		};
	}

	async request(dto: RequestLoginOtpDto, request: Request) {
		this.assertChannel(dto.channel);
		const destination = this.destination(dto);
		const deadline = performance.now() + LOGIN_OTP_POLICY.responseFloorMs;
		const destinationHash = sha256(`${dto.channel}:${destination}`);
		await this.takeQuotas(
			this.requestBuckets(dto.channel, destinationHash, request)
		);
		const challengeId = randomUUID();
		const browserToken = randomToken();
		const code = verificationCode();
		const codeHash = await hash(
			`${browserToken}:${code}`,
			PASSWORD_SALT_ROUNDS
		);
		const now = new Date();
		const expiresAt = new Date(
			now.getTime() + LOGIN_OTP_POLICY.expiresInSeconds * 1_000
		);
		const resendAvailableAt = new Date(
			now.getTime() + LOGIN_OTP_POLICY.resendAfterSeconds * 1_000
		);
		let deliver = false;
		try {
			const identity = await this.prisma.authIdentity.findFirst({
				where: {
					type:
						dto.channel === 'EMAIL'
							? AuthIdentityType.EMAIL
							: AuthIdentityType.PHONE,
					value: destination,
					verifiedAt: { not: null },
					user: { status: UserStatus.ACTIVE, deletedAt: null }
				},
				select: { id: true, userId: true, verifiedAt: true }
			});
			await this.prisma.loginOtpChallenge.create({
				data: {
					id: challengeId,
					channel: dto.channel,
					userId: identity?.userId,
					authIdentityId: identity?.id,
					identityVerifiedAt: identity?.verifiedAt,
					destinationHash,
					browserTokenHash: sha256(browserToken),
					codeHash,
					expiresAt,
					createdAt: now
				}
			});
			deliver = Boolean(identity);
		} catch {
			throw unavailable();
		}
		// The response does not expose provider success or the existence of a user.
		// Keep the same bounded response floor for real and decoy challenges. The
		// dedicated transport owns an abortable socket and does not retry a send.
		if (deliver && performance.now() < deadline - 100) {
			try {
				await this.transport.loginCode(
					dto.channel,
					destination,
					code,
					AbortSignal.timeout(
						Math.max(1, Math.floor(deadline - performance.now() - 100))
					)
				);
			} catch {
				// A failed/unknown send must neither enumerate contacts nor invalidate
				// another browser's challenge. No raw provider error is logged.
			}
		}
		await delay(Math.max(0, deadline - performance.now()));
		return { challengeId, browserToken, expiresAt, resendAvailableAt };
	}

	async verify(dto: VerifyLoginOtpDto, request: Request) {
		if (!this.channels().length) throw unavailable();
		await this.takeQuotas([
			{
				key: `verify:ip:${loginOtpIp(request)}`,
				limit: 50,
				windowMs: 600_000
			},
			{ key: 'verify:global', limit: 2_000, windowMs: 600_000 }
		]);
		const challenge = await this.prisma.loginOtpChallenge.findUnique({
			where: { id: dto.challengeId }
		});
		if (
			!challenge ||
			!this.usable(challenge) ||
			!safeEqual(challenge.browserTokenHash, sha256(dto.browserToken))
		)
			throw invalid();
		this.assertChannel(challenge.channel as LoginOtpChannel);
		const validCode = await compare(
			`${dto.browserToken}:${dto.code}`,
			challenge.codeHash
		);
		if (!validCode) {
			// Increment regardless of concurrent wrong attempts. An optimistic
			// snapshot must not let parallel incorrect guesses escape accounting.
			await this.prisma.loginOtpChallenge.updateMany({
				where: {
					id: challenge.id,
					browserTokenHash: challenge.browserTokenHash,
					consumedAt: null,
					attempts: { lt: LOGIN_OTP_POLICY.maxAttempts },
					expiresAt: { gt: new Date() }
				},
				data: { attempts: { increment: 1 } }
			});
			throw invalid();
		}
		if (!challenge.userId) throw invalid();
		const candidate = await this.prisma.user.findUnique({
			where: { id: challenge.userId },
			select: { createdAt: true }
		});
		if (!candidate) throw invalid();
		await this.owners.ensureTrial(challenge.userId, candidate.createdAt);
		const sessionId = randomUUID();
		const refreshToken = this.refresh.create(sessionId);
		const refreshTokenHash = await hash(
			this.refresh.hashInput(refreshToken),
			PASSWORD_SALT_ROUNDS
		);
		const session = await this.prisma.$transaction(async transaction => {
			// Match the user-first locking convention of password/profile changes.
			await transaction.$queryRaw(
				Prisma.sql`SELECT id FROM identity.users WHERE id = ${challenge.userId} FOR UPDATE`
			);
			// Binding changes update AuthIdentity without necessarily updating User.
			// Lock the exact verified contact too, so it cannot change between the
			// fresh read and the session commit. Never lock another login identity.
			await transaction.$queryRaw(
				Prisma.sql`SELECT id FROM identity.auth_identities WHERE id = ${challenge.authIdentityId} FOR UPDATE`
			);
			await transaction.$queryRaw(
				Prisma.sql`SELECT id FROM identity.login_otp_challenges WHERE id = ${challenge.id}::uuid FOR UPDATE`
			);
			const currentChallenge =
				await transaction.loginOtpChallenge.findUnique({
					where: { id: challenge.id }
				});
			if (
				!currentChallenge ||
				!this.usable(currentChallenge) ||
				currentChallenge.codeHash !== challenge.codeHash
			)
				throw invalid();
			const current = await transaction.user.findUnique({
				where: { id: challenge.userId! },
				include: USER_INCLUDE
			});
			const identity = current?.authIdentities.find(
				item => item.id === challenge.authIdentityId
			);
			if (
				!current ||
				current.status !== UserStatus.ACTIVE ||
				current.deletedAt ||
				!identity?.verifiedAt ||
				identity.verifiedAt.getTime() !==
					challenge.identityVerifiedAt?.getTime() ||
				identity.type !==
					(challenge.channel === 'EMAIL'
						? AuthIdentityType.EMAIL
						: AuthIdentityType.PHONE) ||
				sha256(`${challenge.channel}:${identity.value}`) !==
					challenge.destinationHash
			)
				throw invalid();
			await transaction.loginOtpChallenge.update({
				where: { id: challenge.id },
				data: { consumedAt: new Date() }
			});
			await transaction.userSession.create({
				data: {
					id: sessionId,
					userId: current.id,
					refreshTokenHash,
					userAgent: request.get('user-agent')?.slice(0, 500),
					ipAddress: loginOtpIp(request),
					expiresAt: new Date(Date.now() + 7 * 86_400_000)
				}
			});
			// Signing is local and bounded. A signing failure must roll back both
			// the consumed challenge and the newly created refresh session.
			return {
				user: publicUser(current),
				accessToken: this.jwt.issue(current.id, current.rights, sessionId)
			};
		});
		return {
			...session,
			refreshToken
		};
	}

	private usable(challenge: {
		purpose: string;
		consumedAt: Date | null;
		expiresAt: Date;
		attempts: number;
	}) {
		return (
			challenge.purpose === 'LOGIN_FALLBACK' &&
			!challenge.consumedAt &&
			challenge.expiresAt > new Date() &&
			challenge.attempts < LOGIN_OTP_POLICY.maxAttempts
		);
	}

	private channels(): LoginOtpChannel[] {
		if (this.config.get<string>('IDENTITY_LOGIN_OTP_ENABLED') !== 'true')
			return [];
		return [
			...(this.transport.isEmailConfigured() ? ['EMAIL' as const] : []),
			...(this.transport.isSmsConfigured() ? ['SMS' as const] : [])
		];
	}

	private assertChannel(channel: LoginOtpChannel) {
		if (!this.channels().includes(channel)) throw unavailable();
	}

	private destination(dto: RequestLoginOtpDto) {
		const value =
			dto.channel === 'EMAIL'
				? normalizeEmail(dto.destination)
				: normalizePhone(dto.destination);
		if (
			dto.channel === 'EMAIL'
				? !isEmail(value) || value.length > 254
				: !/^\+[1-9][0-9]{9,14}$/.test(value)
		) {
			throw new BadRequestException({
				code: 'validation_error',
				message: 'Укажите корректный email или номер телефона.'
			});
		}
		return value;
	}

	private requestBuckets(
		channel: LoginOtpChannel,
		destinationHash: string,
		request: Request
	): Bucket[] {
		return [
			{
				key: `request:ip:${loginOtpIp(request)}`,
				limit: 10,
				windowMs: 600_000
			},
			{
				key: `request:contact:cooldown:${destinationHash}`,
				limit: 1,
				windowMs: 60_000
			},
			{
				key: `request:contact:day:${destinationHash}`,
				limit: channel === 'SMS' ? 5 : 20,
				windowMs: 86_400_000
			},
			{
				key: `request:${channel}:hour`,
				limit: channel === 'SMS' ? 100 : 500,
				windowMs: 3_600_000
			},
			{
				key: `request:${channel}:day`,
				limit: channel === 'SMS' ? 300 : 2_000,
				windowMs: 86_400_000
			}
		];
	}

	private async takeQuotas(buckets: Bucket[]) {
		let allowed: boolean;
		try {
			allowed = await this.prisma.$transaction(async transaction => {
				// Every request locks one bucket at each rank in the same order:
				// IP -> contact cooldown -> contact day -> channel hour -> channel day.
				// Verify uses its disjoint IP -> global namespace. Stop at the first
				// denial, committing previous charges but never draining later global
				// delivery budgets through already rejected IP/contact requests.
				for (const value of buckets) {
					const bucket = {
						...value,
						key: sha256(`LOGIN_FALLBACK:${value.key}`)
					};
					const changed = await transaction.$queryRaw<
						Array<{ count: number }>
					>(Prisma.sql`
						INSERT INTO identity.login_otp_rate_limits AS bucket (key, count, expires_at)
						VALUES (${bucket.key}, 1, clock_timestamp() + ${bucket.windowMs} * INTERVAL '1 millisecond')
						ON CONFLICT (key) DO UPDATE SET
							count = CASE WHEN bucket.expires_at <= clock_timestamp() THEN 1 ELSE bucket.count + 1 END,
							expires_at = CASE WHEN bucket.expires_at <= clock_timestamp()
								THEN clock_timestamp() + ${bucket.windowMs} * INTERVAL '1 millisecond' ELSE bucket.expires_at END
						WHERE bucket.expires_at <= clock_timestamp() OR bucket.count < ${bucket.limit}
						RETURNING count
					`);
					if (changed.length !== 1) return false;
				}
				return true;
			});
		} catch {
			throw unavailable();
		}
		if (!allowed)
			throw new HttpException(
				{
					code: 'login_otp_rate_limited',
					message: 'Слишком много запросов кода. Попробуйте позже.'
				},
				429
			);
	}
}

export function loginOtpIp(request: Request): string {
	// Express applies explicit TRUST_PROXY before resolving request.ip. Never
	// read raw forwarded headers here: an untrusted caller can forge them.
	const ip = request.ip || request.socket?.remoteAddress || '';
	return isIP(ip) ? ip.replace(/^::ffff:(?=\d+\.)/, '') : 'unknown';
}
