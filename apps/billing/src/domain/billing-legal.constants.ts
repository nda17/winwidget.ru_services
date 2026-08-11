import { createHash } from 'node:crypto';

export const AUTO_RENEWAL_CONSENT_VERSION = 'auto-renewal-2026-07-28-v4';

export const AUTO_RENEWAL_CONSENT_TEXT =
	'Я соглашаюсь сохранить способ оплаты в ЮKassa, автоматически продлевать выбранную подписку и списывать указанную на странице оплаты сумму с выбранной периодичностью. При недостатке средств или временной недоступности банка Исполнитель вправе выполнить после первого отказа не более двух повторных попыток ориентировочно через 24 и 72 часа. Запрос на каждую повторную попытку может быть отправлен в течение не более одного часа после расчётного момента; если это окно пропущено, такая попытка не выполняется. Новый период начинается только после успешного списания. Автопродление можно отключить в личном кабинете или через info@winwidget.ru в любое время до отправки очередного запроса на списание; оплаченный период сохранится. Новая стоимость применяется только после отдельного подтверждения.';

export const AUTO_RENEWAL_DUE_GRACE_MS = 24 * 60 * 60 * 1000;
export const AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS = 60 * 60 * 1000;
export const PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const AUTO_RENEWAL_RETRY_DELAYS_MS = [
	24 * 60 * 60 * 1000,
	72 * 60 * 60 * 1000
] as const;

const AUTO_RENEWAL_RETRYABLE_CANCELLATION_REASONS = new Set([
	'insufficient_funds',
	'issuer_unavailable'
]);

export const isAutoRenewalRetryableCancellation = (
	reason: string
): boolean => AUTO_RENEWAL_RETRYABLE_CANCELLATION_REASONS.has(reason);

export const buildRecurringCycleKey = (
	autoRenewalId: string,
	chargeAt: Date,
	attempt: number
): string =>
	`${autoRenewalId}:${chargeAt.toISOString()}:attempt:${attempt}`;

const AUTO_RENEWAL_OFFER_SECTION_PATTERN =
	/<section data-winwidget-section="auto-renewal-v1">[\s\S]*?<\/section>/;
const AUTO_RENEWAL_OFFER_SECTION_SHA256 =
	'f85b13c427d8ca2c48504b64d317277aeda7ea355bcaa4a8d0a218fa6b871df4';

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
