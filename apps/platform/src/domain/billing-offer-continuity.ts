import { createHash, randomUUID } from 'node:crypto';

export const BILLING_OFFER_CHANGED_EVENT_TYPE = 'billing.offer.changed.v2';
export const BILLING_OFFER_PRODUCER_CONTRACT_VERSION = 2 as const;
export const BILLING_OFFER_SOURCE_SEQUENCE_SCOPE =
	'billing.offer:offer' as const;
export const AUTO_RENEWAL_CONSENT_VERSION = 'auto-renewal-2026-07-28-v4';
export const AUTO_RENEWAL_CONSENT_TEXT =
	'Я соглашаюсь сохранить способ оплаты в ЮKassa, автоматически продлевать выбранную подписку и списывать указанную на странице оплаты сумму с выбранной периодичностью. При недостатке средств или временной недоступности банка Исполнитель вправе выполнить после первого отказа не более двух повторных попыток ориентировочно через 24 и 72 часа. Запрос на каждую повторную попытку может быть отправлен в течение не более одного часа после расчётного момента; если это окно пропущено, такая попытка не выполняется. Новый период начинается только после успешного списания. Автопродление можно отключить в личном кабинете или через info@winwidget.ru в любое время до отправки очередного запроса на списание; оплаченный период сохранится. Новая стоимость применяется только после отдельного подтверждения.';

const AUTO_RENEWAL_OFFER_SECTION_PATTERN =
	/<section data-winwidget-section="auto-renewal-v1">[\s\S]*?<\/section>/;
const AUTO_RENEWAL_OFFER_SECTION_SHA256 =
	'f85b13c427d8ca2c48504b64d317277aeda7ea355bcaa4a8d0a218fa6b871df4';

export interface BillingOfferContinuityState {
	phase: 'BLOCKED' | 'IMPORTED' | 'ACTIVE';
	producerContractVersion: number | null;
	sourceSequenceScope: string | null;
	importedAggregateVersion: bigint | null;
	importedSourceSequence: bigint | null;
	currentAggregateVersion: bigint | null;
	currentSourceSequence: bigint | null;
	sourceFenceFingerprint: string | null;
	importedAt: Date | null;
	activatedAt: Date | null;
}

export interface BillingOfferCursor {
	aggregateVersion: bigint;
	sourceSequence: bigint;
}

export function isAutoRenewalOfferCompatible(
	content?: string | null
): boolean {
	const section = content?.match(AUTO_RENEWAL_OFFER_SECTION_PATTERN)?.[0];
	if (!section) return false;
	return (
		createHash('sha256')
			.update(section.replace(/\s+/g, ' ').trim(), 'utf8')
			.digest('hex') === AUTO_RENEWAL_OFFER_SECTION_SHA256
	);
}

export function nextBillingOfferCursor(
	state: BillingOfferContinuityState
): BillingOfferCursor {
	if (state.phase !== 'ACTIVE') {
		throw new Error('BILLING_OFFER_PRODUCER_NOT_ACTIVE');
	}
	const importedAggregateVersion = state.importedAggregateVersion;
	const importedSourceSequence = state.importedSourceSequence;
	const currentAggregateVersion = state.currentAggregateVersion;
	const currentSourceSequence = state.currentSourceSequence;
	if (
		state.producerContractVersion !==
			BILLING_OFFER_PRODUCER_CONTRACT_VERSION ||
		state.sourceSequenceScope !== BILLING_OFFER_SOURCE_SEQUENCE_SCOPE ||
		!state.sourceFenceFingerprint ||
		!/^[0-9a-f]{64}$/.test(state.sourceFenceFingerprint) ||
		!(state.importedAt instanceof Date) ||
		!Number.isFinite(state.importedAt.getTime()) ||
		!(state.activatedAt instanceof Date) ||
		!Number.isFinite(state.activatedAt.getTime()) ||
		state.activatedAt < state.importedAt ||
		importedAggregateVersion === null ||
		importedSourceSequence === null ||
		currentAggregateVersion === null ||
		currentSourceSequence === null ||
		importedAggregateVersion < 1n ||
		importedSourceSequence < 1n ||
		currentAggregateVersion < importedAggregateVersion ||
		currentSourceSequence < importedSourceSequence ||
		currentAggregateVersion - importedAggregateVersion !==
			currentSourceSequence - importedSourceSequence
	) {
		throw new Error('BILLING_OFFER_SCOPED_CURSOR_INVALID');
	}
	return {
		aggregateVersion: currentAggregateVersion + 1n,
		sourceSequence: currentSourceSequence + 1n
	};
}

export function buildBillingOfferChangedEvent(input: {
	content: string;
	updatedAt: Date;
	cursor: BillingOfferCursor;
	eventId?: string;
}) {
	if (!isAutoRenewalOfferCompatible(input.content)) {
		throw new Error('BILLING_OFFER_CONSENT_SECTION_INCOMPATIBLE');
	}
	const eventId = input.eventId || randomUUID();
	return {
		schemaVersion: 2 as const,
		eventType: BILLING_OFFER_CHANGED_EVENT_TYPE,
		eventId,
		aggregateId: 'offer' as const,
		aggregateVersion: input.cursor.aggregateVersion.toString(),
		sourceSequenceContractVersion: BILLING_OFFER_PRODUCER_CONTRACT_VERSION,
		sourceSequenceScope: BILLING_OFFER_SOURCE_SEQUENCE_SCOPE,
		sourceSequence: input.cursor.sourceSequence.toString(),
		occurredAt: input.updatedAt.toISOString(),
		tombstone: false as const,
		state: {
			id: 'offer' as const,
			content: input.content,
			sha256: createHash('sha256')
				.update(input.content, 'utf8')
				.digest('hex'),
			updatedAt: input.updatedAt.toISOString(),
			consentVersion: AUTO_RENEWAL_CONSENT_VERSION,
			consentText: AUTO_RENEWAL_CONSENT_TEXT
		}
	};
}
