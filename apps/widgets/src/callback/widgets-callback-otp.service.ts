import {
	BadRequestException,
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	CallbackOtpChannel,
	CallbackVerificationMode,
	Prisma
} from '@prisma/widgets-client';
import {
	createHmac,
	randomInt,
	randomUUID,
	timingSafeEqual
} from 'node:crypto';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import type { WidgetLeadRecord } from '../domain/widgets-domain.repository';
import {
	WIDGETS_CALLBACK_OTP_TRANSPORT,
	type WidgetsCallbackOtpTransport
} from './widgets-callback-otp.transport';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

interface VerificationIdentity {
	callbackId: string;
	ownerId: string;
	publishedVersion: number;
	channel: CallbackOtpChannel;
	challengeId: string;
	code: string;
	destination?: string;
	payload: {
		phone: string;
		timeSlot: string;
		timezone: string;
		url: string | null;
	};
}

interface StartChallengeInput {
	callbackId: string;
	ownerId: string;
	publishedVersion: number;
	channel: CallbackOtpChannel;
	destination: string;
	ip: string;
}

type VerificationOutcome =
	| { kind: 'ready' }
	| { kind: 'replay'; lead: WidgetLeadRecord }
	| { kind: 'invalid' };

type RateRule = {
	scope: string;
	subjectHash: string;
	limit: number;
	windowMs: number;
	message: string;
};

export class CallbackOtpRateLimitException extends HttpException {
	constructor(
		readonly retryAfterSeconds: number,
		message: string
	) {
		super(
			{
				statusCode: HttpStatus.TOO_MANY_REQUESTS,
				message,
				error: 'Too Many Requests'
			},
			HttpStatus.TOO_MANY_REQUESTS
		);
	}
}

@Injectable()
export class WidgetsCallbackOtpService {
	private readonly logger = new Logger(WidgetsCallbackOtpService.name);
	private readonly secret: string;

	constructor(
		private readonly prisma: WidgetsPrismaService,
		config: ConfigService,
		@Inject(WIDGETS_CALLBACK_OTP_TRANSPORT)
		private readonly transport: WidgetsCallbackOtpTransport
	) {
		this.secret =
			config.get<string>('WIDGETS_CALLBACK_OTP_SECRET')?.trim() || '';
		if (Buffer.byteLength(this.secret, 'utf8') < 32) {
			throw new Error(
				'WIDGETS_CALLBACK_OTP_SECRET must contain at least 32 bytes'
			);
		}
	}

	status() {
		return {
			emailConfigured: this.transport.isEmailConfigured(),
			smsConfigured: this.transport.isSmsConfigured()
		};
	}

	async start(input: StartChallengeInput) {
		this.assertTransportConfigured(input.channel);
		const id = randomUUID();
		const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
		const now = new Date();
		const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
		const resendAvailableAt = new Date(now.getTime() + RESEND_COOLDOWN_MS);
		const destinationHash = this.hmac(
			`destination:${input.channel}`,
			input.destination
		);
		const ipHash = this.hmac('ip', input.ip || 'unknown');
		const codeHash = this.hmac(`code:${id}`, code);

		await this.prisma.$transaction(async transaction => {
			for (const rule of this.rateRules(input, destinationHash, ipHash)) {
				await this.consumeRate(transaction, rule, now);
			}
			await transaction.callbackOtpChallenge.create({
				data: {
					id,
					callbackId: input.callbackId,
					ownerId: input.ownerId,
					publishedVersion: input.publishedVersion,
					channel: input.channel,
					destinationHash,
					ipHash,
					codeHash,
					expiresAt,
					resendAvailableAt
				}
			});
		}, TRANSACTION_OPTIONS);

		try {
			if (input.channel === CallbackOtpChannel.EMAIL) {
				await this.transport.sendEmail(input.destination, code);
			} else {
				await this.transport.sendSms(input.destination, code);
			}
			await this.prisma.$transaction(async transaction => {
				const sentAt = new Date();
				const sent = await transaction.callbackOtpChallenge.updateMany({
					where: {
						id,
						sentAt: null,
						failedAt: null,
						revokedAt: null,
						expiresAt: { gt: sentAt }
					},
					data: { sentAt }
				});
				if (sent.count !== 1) {
					throw new Error(
						'Callback OTP challenge could not be marked sent'
					);
				}
				await transaction.callbackOtpChallenge.updateMany({
					where: {
						id: { not: id },
						callbackId: input.callbackId,
						channel: input.channel,
						destinationHash,
						sentAt: { not: null },
						failedAt: null,
						consumedAt: null,
						revokedAt: null
					},
					data: { revokedAt: sentAt }
				});
			}, TRANSACTION_OPTIONS);
		} catch (error) {
			await this.prisma.callbackOtpChallenge
				.updateMany({
					where: { id, sentAt: null, failedAt: null },
					data: { failedAt: new Date() }
				})
				.catch(() => undefined);
			this.logger.warn(
				`Callback OTP delivery failed channel=${input.channel} challengeId=${id} error=${this.safeErrorName(error)}`
			);
			throw new ServiceUnavailableException(
				'Не удалось отправить код подтверждения'
			);
		}

		return {
			challengeId: id,
			expiresAt: expiresAt.toISOString(),
			resendAvailableAt: resendAvailableAt.toISOString(),
			destinationHint: this.destinationHint(
				input.channel,
				input.destination
			)
		};
	}

	async precheckOrReplay(
		input: VerificationIdentity
	): Promise<WidgetLeadRecord | null> {
		const outcome = await this.prisma.$transaction(
			transaction => this.verify(transaction, input, true),
			TRANSACTION_OPTIONS
		);
		if (outcome.kind === 'invalid') this.invalidCode();
		return outcome.kind === 'replay' ? outcome.lead : null;
	}

	async findReplayInTransaction(
		transaction: Prisma.TransactionClient,
		input: VerificationIdentity
	): Promise<WidgetLeadRecord | null> {
		const outcome = await this.verify(transaction, input, false);
		if (outcome.kind === 'invalid') this.invalidCode();
		return outcome.kind === 'replay' ? outcome.lead : null;
	}

	async assertConsumable(
		transaction: Prisma.TransactionClient,
		input: VerificationIdentity
	): Promise<void> {
		const outcome = await this.verify(transaction, input, false);
		if (outcome.kind !== 'ready') this.invalidCode();
	}

	async consume(
		transaction: Prisma.TransactionClient,
		input: VerificationIdentity
	): Promise<void> {
		const consumed = await transaction.callbackOtpChallenge.updateMany({
			where: {
				id: input.challengeId,
				callbackId: input.callbackId,
				ownerId: input.ownerId,
				publishedVersion: input.publishedVersion,
				channel: input.channel,
				sentAt: { not: null },
				failedAt: null,
				revokedAt: null,
				consumedAt: null,
				attempts: { lt: MAX_ATTEMPTS },
				expiresAt: { gt: new Date() }
			},
			data: { consumedAt: new Date() }
		});
		if (consumed.count !== 1) this.invalidCode();
	}

	private async verify(
		transaction: Prisma.TransactionClient,
		input: VerificationIdentity,
		commitWrongAttempt: boolean
	): Promise<VerificationOutcome> {
		const locked = await transaction.$queryRaw<Array<{ id: string }>>(
			Prisma.sql`
				SELECT "id"
				FROM "widgets"."callback_otp_challenges"
				WHERE "id" = ${input.challengeId}::uuid
				FOR UPDATE
			`
		);
		if (!locked.length) return { kind: 'invalid' };
		const challenge = await transaction.callbackOtpChallenge.findUnique({
			where: { id: input.challengeId }
		});
		if (!challenge) return { kind: 'invalid' };
		const bindingMatches =
			challenge.callbackId === input.callbackId &&
			challenge.ownerId === input.ownerId &&
			challenge.publishedVersion === input.publishedVersion &&
			challenge.channel === input.channel &&
			typeof input.destination === 'string' &&
			challenge.destinationHash ===
				this.hmac(`destination:${input.channel}`, input.destination);
		const codeMatches = this.equalHash(
			challenge.codeHash,
			this.hmac(`code:${challenge.id}`, input.code)
		);
		if (challenge.consumedAt) {
			if (
				!bindingMatches ||
				!codeMatches ||
				challenge.expiresAt.getTime() <= Date.now()
			) {
				return { kind: 'invalid' };
			}
			const lead = await transaction.callbackLead.findUnique({
				where: { verificationChallengeId: challenge.id }
			});
			return lead && this.replayPayloadMatches(lead, input.payload)
				? { kind: 'replay', lead }
				: { kind: 'invalid' };
		}
		const active =
			bindingMatches &&
			challenge.sentAt !== null &&
			challenge.failedAt === null &&
			challenge.revokedAt === null &&
			challenge.attempts < MAX_ATTEMPTS &&
			challenge.expiresAt.getTime() > Date.now();
		if (!active) return { kind: 'invalid' };
		if (codeMatches) return { kind: 'ready' };
		if (commitWrongAttempt) {
			const attempts = challenge.attempts + 1;
			await transaction.callbackOtpChallenge.update({
				where: { id: challenge.id },
				data: {
					attempts,
					...(attempts >= MAX_ATTEMPTS && { revokedAt: new Date() })
				}
			});
		}
		return { kind: 'invalid' };
	}

	private replayPayloadMatches(
		lead: WidgetLeadRecord,
		payload: VerificationIdentity['payload']
	): boolean {
		return (
			lead.phone === payload.phone &&
			(lead.timeSlot || '') === payload.timeSlot &&
			(lead.timezone || '') === payload.timezone &&
			(lead.url ?? null) === payload.url
		);
	}

	private rateRules(
		input: StartChallengeInput,
		destinationHash: string,
		ipHash: string
	): RateRule[] {
		const day = 24 * 60 * 60 * 1000;
		return [
			{
				scope: 'DESTINATION_RESEND',
				subjectHash: destinationHash,
				limit: 1,
				windowMs: RESEND_COOLDOWN_MS,
				message: 'Повторная отправка кода пока недоступна'
			},
			{
				scope: 'DESTINATION_HOUR',
				subjectHash: destinationHash,
				limit: 3,
				windowMs: 60 * 60 * 1000,
				message: 'Слишком много запросов кода подтверждения'
			},
			{
				scope: 'DESTINATION_DAY',
				subjectHash: destinationHash,
				limit: 5,
				windowMs: day,
				message: 'Слишком много запросов кода подтверждения'
			},
			{
				scope: 'IP_TEN_MINUTES',
				subjectHash: ipHash,
				limit: 5,
				windowMs: 10 * 60 * 1000,
				message: 'Слишком много запросов кода подтверждения'
			},
			{
				scope: 'IP_DAY',
				subjectHash: ipHash,
				limit: 20,
				windowMs: day,
				message: 'Слишком много запросов кода подтверждения'
			},
			{
				scope: 'WIDGET_DAY',
				subjectHash: this.hmac('widget', input.callbackId),
				limit: 100,
				windowMs: day,
				message: 'Лимит кодов для виджета временно исчерпан'
			},
			{
				scope: 'OWNER_DAY',
				subjectHash: this.hmac('owner', input.ownerId),
				limit: 250,
				windowMs: day,
				message: 'Лимит кодов владельца временно исчерпан'
			},
			{
				scope:
					input.channel === CallbackOtpChannel.SMS
						? 'GLOBAL_SMS_DAY'
						: 'GLOBAL_EMAIL_DAY',
				subjectHash: this.hmac('global', input.channel),
				limit: input.channel === CallbackOtpChannel.SMS ? 100 : 1_000,
				windowMs: day,
				message: 'Сервис кодов временно достиг лимита'
			}
		];
	}

	private async consumeRate(
		transaction: Prisma.TransactionClient,
		rule: RateRule,
		now: Date
	): Promise<void> {
		const windowEndsAt = new Date(now.getTime() + rule.windowMs);
		const rows = await transaction.$queryRaw<
			Array<{ windowEndsAt: Date }>
		>(
			Prisma.sql`
				INSERT INTO "widgets"."callback_otp_rate_buckets" (
					"id", "scope", "subject_hash", "count",
					"window_started_at", "window_ends_at", "created_at", "updated_at"
				)
				VALUES (
					${randomUUID()}::uuid, ${rule.scope}, ${rule.subjectHash}, 1,
					${now}, ${windowEndsAt}, ${now}, ${now}
				)
				ON CONFLICT ("scope", "subject_hash") DO UPDATE
				SET
					"count" = CASE
						WHEN "callback_otp_rate_buckets"."window_ends_at" <= EXCLUDED."window_started_at" THEN 1
						ELSE "callback_otp_rate_buckets"."count" + 1
					END,
					"window_started_at" = CASE
						WHEN "callback_otp_rate_buckets"."window_ends_at" <= EXCLUDED."window_started_at" THEN EXCLUDED."window_started_at"
						ELSE "callback_otp_rate_buckets"."window_started_at"
					END,
					"window_ends_at" = CASE
						WHEN "callback_otp_rate_buckets"."window_ends_at" <= EXCLUDED."window_started_at" THEN EXCLUDED."window_ends_at"
						ELSE "callback_otp_rate_buckets"."window_ends_at"
					END,
					"updated_at" = EXCLUDED."updated_at"
				WHERE
					"callback_otp_rate_buckets"."window_ends_at" <= EXCLUDED."window_started_at"
					OR "callback_otp_rate_buckets"."count" < ${rule.limit}
				RETURNING "window_ends_at" AS "windowEndsAt"
			`
		);
		if (rows.length) return;
		const current = await transaction.callbackOtpRateBucket.findUnique({
			where: {
				scope_subjectHash: {
					scope: rule.scope,
					subjectHash: rule.subjectHash
				}
			},
			select: { windowEndsAt: true }
		});
		const retryAfterSeconds = Math.max(
			1,
			Math.ceil(
				((current?.windowEndsAt.getTime() || now.getTime() + 1_000) -
					now.getTime()) /
					1_000
			)
		);
		throw new CallbackOtpRateLimitException(
			retryAfterSeconds,
			rule.message
		);
	}

	private assertTransportConfigured(channel: CallbackOtpChannel): void {
		const configured =
			channel === CallbackOtpChannel.EMAIL
				? this.transport.isEmailConfigured()
				: this.transport.isSmsConfigured();
		if (!configured) {
			throw new ServiceUnavailableException(
				'Отправка кодов подтверждения временно недоступна'
			);
		}
	}

	private hmac(purpose: string, value: string): string {
		return createHmac('sha256', this.secret)
			.update(`${purpose}\u0000${value}`)
			.digest('hex');
	}

	private equalHash(left: string, right: string): boolean {
		const leftBuffer = Buffer.from(left, 'hex');
		const rightBuffer = Buffer.from(right, 'hex');
		return (
			leftBuffer.length === rightBuffer.length &&
			timingSafeEqual(leftBuffer, rightBuffer)
		);
	}

	private destinationHint(
		channel: CallbackOtpChannel,
		destination: string
	): string {
		if (channel === CallbackOtpChannel.SMS) {
			return `${destination.slice(0, 2)}••••••${destination.slice(-4)}`;
		}
		const [local, domain] = destination.split('@');
		return `${local.slice(0, 1)}•••@${domain}`;
	}

	private invalidCode(): never {
		throw new BadRequestException(
			'Код подтверждения недействителен или истёк'
		);
	}

	private safeErrorName(error: unknown): string {
		return error instanceof Error &&
			/^[A-Za-z0-9_.-]{1,80}$/.test(error.name)
			? error.name
			: 'UnknownError';
	}
}

export const callbackOtpChannel = (
	mode: CallbackVerificationMode
): CallbackOtpChannel | null => {
	if (mode === CallbackVerificationMode.OFF) return null;
	return mode === CallbackVerificationMode.SMS
		? CallbackOtpChannel.SMS
		: CallbackOtpChannel.EMAIL;
};
