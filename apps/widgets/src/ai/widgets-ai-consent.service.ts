import {
	ConflictException,
	ForbiddenException,
	HttpException,
	HttpStatus,
	Injectable,
	NotFoundException,
	UnauthorizedException
} from '@nestjs/common';
import {
	AiConsentReceipt,
	AiConsentReceiptStatus,
	Prisma
} from '@prisma/widgets-client';
import { createHash } from 'node:crypto';
import {
	isAllowedAiPrivacyUrl,
	normalizeWidgetConfig
} from '../domain/widgets-config-normalizer';
import { WidgetsDomainRepository } from '../domain/widgets-domain.repository';
import {
	asJsonObject,
	type WidgetEntity,
	WidgetType
} from '../domain/widgets-domain.types';
import {
	isExactHostnameAllowed,
	normalizeExactInstallDomain
} from '../domain/widgets-domain.util';
import {
	WidgetsAiConsentRepository,
	type CreateAiConsentReceiptInput,
	type VerifiedAiConsentLookup
} from './widgets-ai-consent.repository';
import {
	type WidgetsAiConsentClaims,
	type WidgetsAiSessionClaims,
	WidgetsAiSessionTokenService
} from './widgets-ai-session-token.service';

export const AI_CONSENT_DOCUMENT_VERSION = 'ai-consultant-consent-v2';
export const AI_CONSENT_STATEMENT_TEXT =
	'Я согласен(на), что Cloudflare Workers AI обработает мой вопрос и до 12 последних сообщений контекста для формирования и проверки ответа. Для защиты от автоматизированных запросов в Cloudflare Turnstile будут переданы и обработаны технические сигналы безопасности (IP-адрес, TLS-отпечаток, User-Agent, ключ сайта и связанный домен); Cloudflare также использует эти сигналы как самостоятельный оператор для улучшения обнаружения ботов. Я ознакомлен(а) с политикой обработки данных владельца сайта и обязуюсь не указывать специальные категории персональных данных, биометрические и иные избыточные персональные данные.';

const CONSENT_PROOF_TTL_MS = 15 * 60_000;
const CONSENT_RATE_WINDOW_MS = 60_000;
const CONSENT_RATE_MAX_ENTRIES = 25_000;
const CONSENT_RATE_LIMITS = {
	global: 600,
	widget: 180,
	ip: 60
} as const;

interface ConsentRateEntry {
	count: number;
	expiresAt: number;
}

export interface WidgetsAiConsentDocument {
	documentVersion: string;
	documentHash: string;
	statementText: string;
	privacyUrl: string;
}

export interface WidgetsAiConsentInput {
	acceptanceId: string;
	sessionId: string;
	accepted: true;
	documentVersion: string;
	documentHash: string;
}

export interface WidgetsAiConsentResult {
	acceptanceId: string;
	consentToken: string;
	acceptedAt: string;
	expiresAt: string;
}

export interface WidgetsAiPreparedConsent {
	widget: WidgetEntity;
	expectedHostname: string;
	claims: WidgetsAiConsentClaims;
}

interface ConsentContext {
	configuredSiteHostname: string;
	requestHostname: string;
	document: WidgetsAiConsentDocument;
}

@Injectable()
export class WidgetsAiConsentService {
	private readonly rates = new Map<string, ConsentRateEntry>();
	private rateOperations = 0;

	constructor(
		private readonly widgets: WidgetsDomainRepository,
		private readonly receipts: WidgetsAiConsentRepository,
		private readonly tokens: WidgetsAiSessionTokenService
	) {}

	publicDocument(
		widget: WidgetEntity,
		requestHostname: string | null
	): WidgetsAiConsentDocument {
		return this.context(widget, requestHostname).document;
	}

	async accept(
		publicKey: string,
		input: WidgetsAiConsentInput,
		ip: string,
		requestHostname: string | null,
		directPageAccessAllowed: boolean
	): Promise<WidgetsAiConsentResult> {
		this.consumeRate(publicKey, ip);
		const widget = await this.requirePublicWidget(
			publicKey,
			requestHostname,
			directPageAccessAllowed
		);
		const context = this.context(widget, requestHostname);
		if (
			input.accepted !== true ||
			input.documentVersion !== context.document.documentVersion ||
			input.documentHash !== context.document.documentHash
		) {
			throw new ConflictException(
				'Документ согласия AI-консультанта изменился. Обновите виджет.'
			);
		}

		const scopes = this.tokens.scopes({
			ownerId: widget.userId,
			widgetId: widget.id,
			ip,
			sessionId: input.sessionId
		});
		const evidence = {
			acceptanceId: input.acceptanceId,
			widgetId: widget.id,
			widgetPublicKey: widget.publicKey,
			ownerScope: scopes.ownerScope,
			configuredSiteHostname: context.configuredSiteHostname,
			requestHostname: context.requestHostname,
			publishedVersion: widget.publishedVersion,
			sessionScope: scopes.sessionScope,
			sourceScope: scopes.sourceScope,
			documentVersion: context.document.documentVersion,
			documentHash: context.document.documentHash,
			statementText: context.document.statementText,
			privacyUrl: context.document.privacyUrl
		};
		const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
		let receipt = await this.receipts.findByAcceptanceId(
			input.acceptanceId
		);
		if (!receipt) {
			try {
				receipt = await this.receipts.createPending({
					...evidence,
					acceptedAt: now,
					proofExpiresAt: new Date(now.getTime() + CONSENT_PROOF_TTL_MS)
				});
			} catch (error) {
				if (!this.isUniqueConflict(error)) throw error;
				receipt = await this.receipts.findByAcceptanceId(
					input.acceptanceId
				);
			}
		}
		if (!receipt || !this.matchesEvidence(receipt, evidence)) {
			throw new ConflictException(
				'Идентификатор согласия уже использован для другого документа'
			);
		}
		if (
			receipt.status !== AiConsentReceiptStatus.PENDING ||
			receipt.proofExpiresAt.getTime() <= Date.now()
		) {
			throw new ConflictException(
				'Согласие уже использовано или срок подтверждения истёк'
			);
		}

		const proof = this.tokens.issueConsent({
			publicKey: widget.publicKey,
			sessionId: input.sessionId,
			ownerId: widget.userId,
			widgetId: widget.id,
			ip,
			publishedVersion: widget.publishedVersion,
			consentReceiptId: receipt.id,
			acceptanceId: receipt.acceptanceId,
			documentVersion: receipt.documentVersion,
			documentHash: receipt.documentHash,
			requestHostname: receipt.requestHostname,
			acceptedAt: receipt.acceptedAt,
			proofExpiresAt: receipt.proofExpiresAt
		});
		return {
			acceptanceId: receipt.acceptanceId,
			consentToken: proof.consentToken,
			acceptedAt: receipt.acceptedAt.toISOString(),
			expiresAt: proof.expiresAt
		};
	}

	async prepareSession(
		publicKey: string,
		sessionId: string,
		consentToken: string,
		ip: string,
		requestHostname: string | null,
		directPageAccessAllowed: boolean
	): Promise<WidgetsAiPreparedConsent> {
		const claims = this.tokens.verifyConsent(consentToken, {
			publicKey,
			sessionId,
			ip
		});
		const widget = await this.requirePublicWidget(
			publicKey,
			requestHostname,
			directPageAccessAllowed
		);
		this.tokens.assertWidget(claims, widget);
		const context = this.context(widget, requestHostname);
		if (claims.requestHostname !== context.requestHostname) {
			throw new UnauthorizedException(
				'Согласие AI-консультанта не соответствует текущему сайту'
			);
		}
		const receipt = await this.receipts.findById(claims.consentReceiptId);
		if (
			!receipt ||
			receipt.status !== AiConsentReceiptStatus.PENDING ||
			receipt.acceptedAt.getTime() !== claims.acceptedAt ||
			receipt.proofExpiresAt.getTime() !== claims.expiresAt ||
			receipt.proofExpiresAt.getTime() <= Date.now() ||
			!this.matchesEvidence(
				receipt,
				this.evidence(context, claims, widget.id)
			)
		) {
			throw new UnauthorizedException(
				'Согласие AI-консультанта недействительно либо уже использовано'
			);
		}
		return {
			widget,
			expectedHostname: context.requestHostname,
			claims
		};
	}

	async verifyPrepared(prepared: WidgetsAiPreparedConsent): Promise<void> {
		const receipt = await this.receipts.verifyPending({
			id: prepared.claims.consentReceiptId,
			acceptanceId: prepared.claims.acceptanceId,
			now: new Date()
		});
		if (!receipt) {
			throw new UnauthorizedException(
				'Согласие AI-консультанта недействительно либо уже использовано'
			);
		}
	}

	async assertVerified(
		widget: WidgetEntity,
		claims: WidgetsAiSessionClaims
	): Promise<void> {
		this.tokens.assertWidget(claims, widget);
		const context = this.context(widget, claims.requestHostname);
		const receipt = await this.receipts.findVerifiedByIdAndEvidence(
			this.evidence(context, claims, widget.id)
		);
		if (!receipt) {
			throw new UnauthorizedException(
				'Подтверждённое согласие AI-консультанта не найдено'
			);
		}
	}

	private context(
		widget: WidgetEntity,
		requestHostname: string | null
	): ConsentContext {
		const configuredSiteHostname = widget.installDomain
			? normalizeExactInstallDomain(widget.installDomain)
			: requestHostname;
		if (!configuredSiteHostname || !requestHostname) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}
		const config = asJsonObject(
			normalizeWidgetConfig(WidgetType.AI_CONSULTANT, widget.config)
		);
		const privacyUrl = String(config.privacyUrl || '').trim();
		if (!isAllowedAiPrivacyUrl(privacyUrl)) {
			throw new ForbiddenException(
				'Владелец сайта не настроил политику обработки данных AI-консультанта'
			);
		}
		const canonical = JSON.stringify({
			documentVersion: AI_CONSENT_DOCUMENT_VERSION,
			statementText: AI_CONSENT_STATEMENT_TEXT,
			privacyUrl,
			configuredSiteHostname,
			requestHostname,
			publishedVersion: widget.publishedVersion
		});
		return {
			configuredSiteHostname,
			requestHostname,
			document: {
				documentVersion: AI_CONSENT_DOCUMENT_VERSION,
				documentHash: createHash('sha256').update(canonical).digest('hex'),
				statementText: AI_CONSENT_STATEMENT_TEXT,
				privacyUrl
			}
		};
	}

	private evidence(
		context: ConsentContext,
		claims: WidgetsAiConsentClaims | WidgetsAiSessionClaims,
		widgetId: string
	): VerifiedAiConsentLookup {
		return {
			id: claims.consentReceiptId,
			acceptanceId: claims.acceptanceId,
			widgetId,
			widgetPublicKey: claims.publicKey,
			ownerScope: claims.ownerScope,
			configuredSiteHostname: context.configuredSiteHostname,
			requestHostname: context.requestHostname,
			publishedVersion: claims.publishedVersion,
			sessionScope: claims.sessionScope,
			sourceScope: claims.sourceScope,
			documentVersion: context.document.documentVersion,
			documentHash: context.document.documentHash,
			statementText: context.document.statementText,
			privacyUrl: context.document.privacyUrl
		};
	}

	private async requirePublicWidget(
		publicKey: string,
		requestHostname: string | null,
		directPageAccessAllowed: boolean
	): Promise<WidgetEntity> {
		const widget = await this.widgets.findByPublicKey(
			WidgetType.AI_CONSULTANT,
			publicKey
		);
		if (!widget) throw new NotFoundException('Виджет не найден');
		if (!widget.publishedAt || widget.publishedVersion < 1) {
			throw new ForbiddenException('Виджет ещё не опубликован');
		}
		if (!widget.isActive) {
			throw new ForbiddenException('AI-консультант временно недоступен');
		}
		if (
			!directPageAccessAllowed &&
			!isExactHostnameAllowed(widget.installDomain, requestHostname)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}
		return widget;
	}

	private matchesEvidence(
		receipt: AiConsentReceipt,
		evidence: Omit<
			CreateAiConsentReceiptInput,
			'acceptedAt' | 'proofExpiresAt'
		>
	): boolean {
		return Object.entries(evidence).every(
			([key, value]) => receipt[key as keyof AiConsentReceipt] === value
		);
	}

	private isUniqueConflict(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}

	private consumeRate(publicKey: string, ip: string): void {
		const now = Date.now();
		this.rateOperations += 1;
		if (
			this.rateOperations % 128 === 0 ||
			this.rates.size >= CONSENT_RATE_MAX_ENTRIES
		) {
			for (const [key, entry] of this.rates) {
				if (entry.expiresAt <= now) this.rates.delete(key);
			}
		}
		const scopes: Array<[string, number]> = [
			['ai-consent:global', CONSENT_RATE_LIMITS.global],
			[
				`ai-consent:widget:${this.rateScope(publicKey)}`,
				CONSENT_RATE_LIMITS.widget
			],
			[
				`ai-consent:ip:${this.rateScope(ip || 'unknown')}`,
				CONSENT_RATE_LIMITS.ip
			]
		];
		for (const [key, limit] of scopes) {
			const entry = this.rates.get(key);
			if (entry && entry.expiresAt > now && entry.count >= limit) {
				throw new HttpException(
					'Слишком много запросов согласия',
					HttpStatus.TOO_MANY_REQUESTS
				);
			}
		}
		for (const [key] of scopes) {
			const entry = this.rates.get(key);
			if (!entry || entry.expiresAt <= now) {
				while (this.rates.size >= CONSENT_RATE_MAX_ENTRIES) {
					const evictionKey = [...this.rates.keys()].find(
						candidate =>
							candidate !== 'ai-consent:global' &&
							!scopes.some(([protectedKey]) => protectedKey === candidate)
					);
					if (!evictionKey) break;
					this.rates.delete(evictionKey);
				}
				if (this.rates.size >= CONSENT_RATE_MAX_ENTRIES) {
					throw new HttpException(
						'Слишком много запросов согласия',
						HttpStatus.TOO_MANY_REQUESTS
					);
				}
				this.rates.set(key, {
					count: 1,
					expiresAt: now + CONSENT_RATE_WINDOW_MS
				});
			} else {
				entry.count += 1;
			}
		}
	}

	private rateScope(value: string): string {
		return createHash('sha256').update(value).digest('base64url');
	}
}
