import {
	BadRequestException,
	HttpException,
	Injectable,
	UnauthorizedException
} from '@nestjs/common';
import {
	Prisma,
	VerificationChallengePurpose,
	VerificationChallengeType,
	type VerificationChallenge,
	type VerificationEmailAttempt
} from '@prisma/identity-client';
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import {
	PASSWORD_SALT_ROUNDS,
	verificationCode
} from '../common/identity.util';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { VerificationTransportService } from '../transports/verification-transport.service';

const TTL_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;
const LEASE_MS = 60_000;
const MAX_SENDS = 10;

type EmailScope = {
	purpose: 'REGISTER' | 'BIND_IDENTITY';
	value: string;
	userId?: string;
};

export type VerifiedEmailCode = {
	challenge: VerificationChallenge;
	attempt: VerificationEmailAttempt | null;
	passwordHash: string | null;
};

@Injectable()
export class EmailVerificationService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly transport: VerificationTransportService
	) {}

	async issue(scope: EmailScope, passwordHash?: string) {
		const code = verificationCode();
		const codeHash = await hash(code, PASSWORD_SALT_ROUNDS);
		const attemptId = randomUUID();
		const prepared = await this.prisma
			.$transaction(async transaction => {
				await this.lock(transaction, scope);
				const occupied = await transaction.authIdentity.findUnique({
					where: { type_value: { type: 'EMAIL', value: scope.value } }
				});
				if (
					occupied &&
					(scope.purpose === 'REGISTER' ||
						occupied.userId !== scope.userId)
				) {
					throw new BadRequestException(
						scope.purpose === 'REGISTER'
							? 'User already exists'
							: 'Email busy'
					);
				}
				const now = new Date();
				let challenge = await transaction.verificationChallenge.findUnique(
					{
						where: this.where(scope)
					}
				);
				if (
					challenge &&
					challenge.expiresAt > now &&
					challenge.attempts >= 5
				) {
					throw this.attemptLimit(challenge.expiresAt);
				}
				if (
					challenge?.deliveryLeaseExpiresAt &&
					challenge.deliveryLeaseExpiresAt > now
				) {
					throw this.cooldown(
						challenge.deliveryLeaseExpiresAt,
						challenge.expiresAt
					);
				}
				if (challenge && challenge.expiresAt <= now) {
					await transaction.verificationChallenge.delete({
						where: { id: challenge.id }
					});
					challenge = null;
				}
				if (!challenge && scope.purpose === 'REGISTER' && !passwordHash) {
					throw new UnauthorizedException(
						'Email verification code not found'
					);
				}
				if (challenge) {
					const availableAt =
						challenge.emailResendAvailableAt ||
						new Date(challenge.lastSentAt.getTime() + COOLDOWN_MS);
					if (availableAt > now)
						throw this.cooldown(availableAt, challenge.expiresAt);
					if (!challenge.emailDeliveryManaged) {
						await transaction.verificationEmailAttempt.create({
							data: {
								id: randomUUID(),
								challengeId: challenge.id,
								value: challenge.value,
								codeHash: challenge.codeHash,
								passwordHash: challenge.passwordHash,
								outcome: 'UNKNOWN',
								expiresAt: challenge.expiresAt,
								createdAt: challenge.lastSentAt
							}
						});
					}
					const count = await transaction.verificationEmailAttempt.count({
						where: {
							challengeId: challenge.id,
							createdAt: { gt: new Date(now.getTime() - TTL_MS) }
						}
					});
					if (count >= MAX_SENDS) {
						throw this.cooldown(challenge.expiresAt, challenge.expiresAt);
					}
				}
				const expiresAt = new Date(now.getTime() + TTL_MS);
				const resendAvailableAt = new Date(now.getTime() + COOLDOWN_MS);
				// Resends inherit the password of the latest registration attempt, while
				// every earlier code keeps its own immutable password snapshot.
				let issuedPasswordHash = passwordHash;
				if (
					scope.purpose === 'REGISTER' &&
					!issuedPasswordHash &&
					challenge
				) {
					const latest =
						await transaction.verificationEmailAttempt.findFirst({
							where: {
								challengeId: challenge.id,
								passwordHash: { not: null }
							},
							orderBy: { createdAt: 'desc' }
						});
					issuedPasswordHash =
						latest?.passwordHash || challenge.passwordHash || undefined;
				}
				if (scope.purpose === 'REGISTER' && !issuedPasswordHash) {
					throw new UnauthorizedException(
						'Email verification code not found'
					);
				}
				if (!challenge) {
					challenge = await transaction.verificationChallenge.create({
						data: {
							type: VerificationChallengeType.EMAIL,
							purpose: scope.purpose,
							value: scope.value,
							userId: scope.userId,
							codeHash,
							passwordHash: issuedPasswordHash,
							expiresAt,
							emailDeliveryManaged: true,
							emailResendAvailableAt: resendAvailableAt,
							deliveryLeaseToken: attemptId,
							deliveryLeaseExpiresAt: new Date(now.getTime() + LEASE_MS)
						}
					});
				} else {
					const claimed =
						await transaction.verificationChallenge.updateMany({
							where: {
								id: challenge.id,
								attempts: { lt: 5 },
								OR: [
									{ deliveryLeaseToken: null },
									{ deliveryLeaseExpiresAt: { lte: now } }
								]
							},
							data: {
								value: scope.value,
								expiresAt,
								emailDeliveryManaged: true,
								emailResendAvailableAt: resendAvailableAt,
								deliveryLeaseToken: attemptId,
								deliveryLeaseExpiresAt: new Date(now.getTime() + LEASE_MS)
							}
						});
					if (claimed.count !== 1) {
						const latest =
							await transaction.verificationChallenge.findUnique({
								where: { id: challenge.id }
							});
						if (latest && latest.attempts >= 5)
							throw this.attemptLimit(latest.expiresAt);
						throw this.cooldown(resendAvailableAt, expiresAt);
					}
				}
				await transaction.verificationEmailAttempt.create({
					data: {
						id: attemptId,
						challengeId: challenge.id,
						value: scope.value,
						codeHash,
						passwordHash: issuedPasswordHash,
						outcome: 'SENDING',
						expiresAt,
						createdAt: now
					}
				});
				return { challengeId: challenge.id, expiresAt, resendAvailableAt };
			})
			.catch(error => {
				if (
					error &&
					typeof error === 'object' &&
					'code' in error &&
					error.code === 'P2002'
				) {
					throw new BadRequestException(
						scope.purpose === 'REGISTER'
							? 'User already exists'
							: 'Email busy'
					);
				}
				throw error;
			});
		try {
			await this.transport.emailCode(scope.value, code, attemptId);
		} catch (error) {
			const outcome = deliveryOutcome(error);
			const resendAvailableAt = new Date(
				Date.now() + (outcome === 'FAILED' ? 10_000 : COOLDOWN_MS)
			);
			await this.finalize(
				prepared.challengeId,
				attemptId,
				outcome,
				resendAvailableAt
			).catch(() => undefined);
			throw deliveryHttpError(
				error,
				outcome,
				attemptId,
				prepared.expiresAt,
				resendAvailableAt
			);
		}
		// A crash or unavailable database after SMTP acceptance leaves SENDING
		// valid until expiry. A late finalizer cannot recreate a consumed challenge.
		await this.finalize(
			prepared.challengeId,
			attemptId,
			'ACCEPTED',
			prepared.resendAvailableAt
		).catch(() => undefined);
		return {
			value: scope.value,
			expiresAt: prepared.expiresAt,
			resendAvailableAt: prepared.resendAvailableAt
		};
	}

	async validate(
		scope: EmailScope,
		code: string
	): Promise<VerifiedEmailCode> {
		const challenge = await this.prisma.verificationChallenge.findUnique({
			where: this.where(scope)
		});
		if (!challenge || challenge.expiresAt <= new Date()) {
			throw new UnauthorizedException('Email verification code not found');
		}
		if (challenge.attempts >= 5)
			throw this.attemptLimit(challenge.expiresAt);
		if (!challenge.emailDeliveryManaged) {
			if (
				challenge.value === scope.value &&
				(await compare(code, challenge.codeHash))
			) {
				return {
					challenge,
					attempt: null,
					passwordHash: challenge.passwordHash
				};
			}
		} else {
			const attempts = await this.prisma.verificationEmailAttempt.findMany(
				{
					where: {
						challengeId: challenge.id,
						value: scope.value,
						outcome: { not: 'FAILED' },
						expiresAt: { gt: new Date() }
					},
					orderBy: { createdAt: 'desc' },
					take: MAX_SENDS
				}
			);
			for (const attempt of attempts) {
				if (await compare(code, attempt.codeHash)) {
					return {
						challenge,
						attempt,
						passwordHash: attempt.passwordHash
					};
				}
			}
		}
		const changed = await this.prisma.verificationChallenge.updateMany({
			where: {
				id: challenge.id,
				attempts: { lt: 5 },
				expiresAt: { gt: new Date() }
			},
			data: { attempts: { increment: 1 } }
		});
		const latest = await this.prisma.verificationChallenge.findUnique({
			where: { id: challenge.id }
		});
		if (latest && latest.expiresAt > new Date() && latest.attempts >= 5) {
			throw this.attemptLimit(latest.expiresAt);
		}
		if (!changed.count)
			throw new UnauthorizedException('Email verification code not found');
		throw new UnauthorizedException('Email verification code invalid');
	}

	async consume(
		transaction: Prisma.TransactionClient,
		verified: VerifiedEmailCode
	) {
		const { challenge, attempt } = verified;
		await this.lock(transaction, {
			purpose: challenge.purpose as EmailScope['purpose'],
			value: challenge.value,
			userId: challenge.userId || undefined
		});
		await transaction.$queryRaw(
			Prisma.sql`SELECT id FROM identity.verification_challenges WHERE id = ${challenge.id} FOR UPDATE`
		);
		const currentChallenge =
			await transaction.verificationChallenge.findUnique({
				where: { id: challenge.id }
			});
		if (
			currentChallenge &&
			currentChallenge.expiresAt > new Date() &&
			currentChallenge.attempts >= 5
		) {
			throw this.attemptLimit(currentChallenge.expiresAt);
		}
		if (attempt) {
			const current = await transaction.verificationEmailAttempt.findFirst(
				{
					where: {
						id: attempt.id,
						challengeId: challenge.id,
						codeHash: attempt.codeHash,
						outcome: { not: 'FAILED' },
						expiresAt: { gt: new Date() }
					}
				}
			);
			if (!current)
				throw new UnauthorizedException(
					'Email verification code not found'
				);
		} else {
			const current = currentChallenge;
			// The legacy code may have been imported into history while bcrypt ran.
			if (current?.emailDeliveryManaged) {
				const imported =
					await transaction.verificationEmailAttempt.findFirst({
						where: {
							challengeId: challenge.id,
							codeHash: challenge.codeHash,
							value: challenge.value,
							outcome: { not: 'FAILED' },
							expiresAt: { gt: new Date() }
						}
					});
				if (!imported)
					throw new UnauthorizedException(
						'Email verification code not found'
					);
			} else if (
				!current ||
				current.codeHash !== challenge.codeHash ||
				current.expiresAt <= new Date()
			) {
				throw new UnauthorizedException(
					'Email verification code not found'
				);
			}
		}
		const consumed = await transaction.verificationChallenge.deleteMany({
			where: {
				id: challenge.id,
				attempts: { lt: 5 },
				expiresAt: { gt: new Date() }
			}
		});
		if (consumed.count !== 1)
			throw new UnauthorizedException('Email verification code not found');
	}

	private where(
		scope: EmailScope
	): Prisma.VerificationChallengeWhereUniqueInput {
		return scope.purpose === VerificationChallengePurpose.REGISTER
			? {
					type_purpose_value: {
						type: VerificationChallengeType.EMAIL,
						purpose: scope.purpose,
						value: scope.value
					}
				}
			: {
					userId_type_purpose: {
						userId: scope.userId!,
						type: VerificationChallengeType.EMAIL,
						purpose: scope.purpose
					}
				};
	}

	private lock(transaction: Prisma.TransactionClient, scope: EmailScope) {
		const key = `email-verification:${scope.purpose}:${scope.userId || scope.value}`;
		return transaction.$queryRaw(
			Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`
		);
	}

	private cooldown(resendAvailableAt: Date, expiresAt: Date) {
		return new BadRequestException({
			code: 'email_code_resend_cooldown',
			message: 'Отправить код повторно можно немного позже.',
			expiresAt: expiresAt.toISOString(),
			resendAvailableAt: resendAvailableAt.toISOString()
		});
	}

	private attemptLimit(expiresAt: Date) {
		return new UnauthorizedException({
			code: 'email_code_attempts_exceeded',
			message:
				'Лимит попыток исчерпан. Запросите новый код после завершения текущей проверки.',
			expiresAt: expiresAt.toISOString(),
			resendAvailableAt: expiresAt.toISOString()
		});
	}

	private finalize(
		challengeId: string,
		attemptId: string,
		outcome: string,
		resendAvailableAt: Date
	) {
		return this.prisma.$transaction(async transaction => {
			const changed = await transaction.verificationChallenge.updateMany({
				where: { id: challengeId, deliveryLeaseToken: attemptId },
				data: {
					deliveryLeaseToken: null,
					deliveryLeaseExpiresAt: null,
					emailResendAvailableAt: resendAvailableAt,
					...(outcome === 'ACCEPTED' ? { lastSentAt: new Date() } : {})
				}
			});
			if (changed.count === 1) {
				await transaction.verificationEmailAttempt.updateMany({
					where: { id: attemptId, outcome: 'SENDING' },
					data: { outcome }
				});
			}
		});
	}
}

export function deliveryOutcome(error: unknown): 'FAILED' | 'UNKNOWN' {
	return error instanceof Error &&
		'outcome' in error &&
		error.outcome === 'FAILED'
		? 'FAILED'
		: 'UNKNOWN';
}

export function deliveryHttpError(
	error: unknown,
	outcome: 'FAILED' | 'UNKNOWN',
	attemptId: string,
	expiresAt: Date,
	resendAvailableAt: Date
) {
	const response =
		error instanceof HttpException ? error.getResponse() : null;
	return new HttpException(
		{
			...(response && typeof response === 'object' ? response : {}),
			code:
				outcome === 'FAILED'
					? 'email_delivery_failed'
					: 'email_delivery_unknown',
			message:
				outcome === 'FAILED'
					? 'Не удалось отправить письмо. Попробуйте ещё раз немного позже.'
					: 'Не удалось подтвердить отправку письма. Проверьте почту или повторите запрос позже.',
			deliveryStatus: outcome,
			deliveryAttemptId: attemptId,
			expiresAt: expiresAt.toISOString(),
			resendAvailableAt: resendAvailableAt.toISOString()
		},
		502
	);
}
