import {
	BadRequestException,
	Injectable,
	UnauthorizedException
} from '@nestjs/common';
import {
	AuthIdentityType,
	Prisma,
	UserStatus,
	type EmailPasswordRecovery
} from '@prisma/identity-client';
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import {
	PASSWORD_SALT_ROUNDS,
	USER_DEACTIVATED_MESSAGE
} from '../common/identity.util';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { VerificationTransportService } from '../transports/verification-transport.service';
import {
	deliveryHttpError,
	deliveryOutcome
} from './email-verification.service';

type RecoveryUser = {
	id: string;
	password: string;
	authIdentities: {
		id: string;
		type: AuthIdentityType;
		value: string;
		verifiedAt: Date | null;
	}[];
};
const TTL_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;

@Injectable()
export class EmailPasswordRecoveryService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly transport: VerificationTransportService
	) {}

	async issue(userId: string, email: string, password: string) {
		const passwordHash = await hash(password, PASSWORD_SALT_ROUNDS);
		const id = randomUUID();
		const prepared = await this.prisma.$transaction(async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`SELECT id FROM identity.users WHERE id = ${userId} FOR UPDATE`
			);
			const user = await transaction.user.findUnique({
				where: { id: userId },
				include: { authIdentities: true }
			});
			if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt)
				throw new UnauthorizedException(USER_DEACTIVATED_MESSAGE);
			const identity = user.authIdentities.find(
				item =>
					item.type === AuthIdentityType.EMAIL && item.value === email
			);
			if (!identity)
				throw new UnauthorizedException('Email or password invalid');
			const now = new Date();
			const recent = await transaction.emailPasswordRecovery.findMany({
				where: {
					userId,
					createdAt: { gt: new Date(now.getTime() - TTL_MS) }
				},
				orderBy: { createdAt: 'desc' },
				take: 10
			});
			const latest = recent[0];
			const availableAt = latest
				? new Date(
						latest.createdAt.getTime() +
							(latest.outcome === 'FAILED' ? 10_000 : COOLDOWN_MS)
					)
				: now;
			if (availableAt > now || recent.length >= 10) {
				throw new BadRequestException({
					code: 'email_code_resend_cooldown',
					message: 'Повторить запрос можно немного позже.',
					expiresAt: (latest?.expiresAt || now).toISOString(),
					resendAvailableAt: (recent.length >= 10
						? recent[recent.length - 1].expiresAt
						: availableAt
					).toISOString()
				});
			}
			const expiresAt = new Date(now.getTime() + TTL_MS);
			await transaction.emailPasswordRecovery.create({
				data: {
					id,
					userId,
					authIdentityId: identity.id,
					identityValue: email,
					identityVerifiedAt: identity.verifiedAt,
					passwordHash,
					basePasswordHash: user.password,
					outcome: 'SENDING',
					expiresAt,
					createdAt: now
				}
			});
			return {
				expiresAt,
				resendAvailableAt: new Date(now.getTime() + COOLDOWN_MS)
			};
		});
		try {
			await this.transport.newPassword(email, password, id);
		} catch (error) {
			const outcome = deliveryOutcome(error);
			await this.prisma.emailPasswordRecovery
				.updateMany({
					where: { id, outcome: 'SENDING' },
					data: { outcome }
				})
				.catch(() => undefined);
			throw deliveryHttpError(
				error,
				outcome,
				id,
				prepared.expiresAt,
				outcome === 'FAILED'
					? new Date(Date.now() + 10_000)
					: prepared.resendAvailableAt
			);
		}
		await this.prisma.emailPasswordRecovery
			.updateMany({
				where: { id, outcome: 'SENDING' },
				data: { outcome: 'ACCEPTED' }
			})
			.catch(() => undefined);
	}

	async match(
		user: RecoveryUser,
		password: string,
		transaction: Prisma.TransactionClient = this.prisma,
		recoveryId?: string
	): Promise<EmailPasswordRecovery | null> {
		const candidates = await transaction.emailPasswordRecovery.findMany({
			where: {
				...(recoveryId ? { id: recoveryId } : {}),
				userId: user.id,
				basePasswordHash: user.password,
				consumedAt: null,
				outcome: { not: 'FAILED' },
				expiresAt: { gt: new Date() }
			},
			orderBy: { createdAt: 'desc' },
			take: 10
		});
		for (const candidate of candidates) {
			if (
				this.identityMatches(user, candidate) &&
				(await compare(password, candidate.passwordHash))
			)
				return candidate;
		}
		return null;
	}

	/** Caller holds the User row lock used by all password-login session creation. */
	async activate(
		transaction: Prisma.TransactionClient,
		user: RecoveryUser,
		recovery: EmailPasswordRecovery
	) {
		const now = new Date();
		const consumed = await transaction.emailPasswordRecovery.updateMany({
			where: {
				id: recovery.id,
				userId: user.id,
				basePasswordHash: user.password,
				consumedAt: null,
				outcome: { not: 'FAILED' },
				expiresAt: { gt: now }
			},
			data: { consumedAt: now }
		});
		if (consumed.count !== 1 || !this.identityMatches(user, recovery))
			throw new UnauthorizedException('Email or password invalid');
		const changed = await transaction.user.updateMany({
			where: {
				id: user.id,
				password: recovery.basePasswordHash,
				status: UserStatus.ACTIVE,
				deletedAt: null
			},
			data: { password: recovery.passwordHash }
		});
		if (changed.count !== 1)
			throw new UnauthorizedException('Email or password invalid');
		await transaction.userSession.updateMany({
			where: { userId: user.id, revokedAt: null },
			data: { revokedAt: now }
		});
		await transaction.emailPasswordRecovery.updateMany({
			where: { userId: user.id, consumedAt: null },
			data: { consumedAt: now }
		});
	}

	private identityMatches(
		user: RecoveryUser,
		candidate: EmailPasswordRecovery
	) {
		return user.authIdentities.some(
			identity =>
				identity.id === candidate.authIdentityId &&
				identity.type === AuthIdentityType.EMAIL &&
				identity.value === candidate.identityValue &&
				identity.verifiedAt?.getTime() ===
					candidate.identityVerifiedAt?.getTime()
		);
	}
}
