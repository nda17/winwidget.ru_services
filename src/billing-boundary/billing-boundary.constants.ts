import { createHash } from 'node:crypto';

export const BILLING_INTERNAL_TOKEN_HEADER = 'x-winwidget-internal-token';
export const BILLING_INTERNAL_TOKEN_ENV = 'BILLING_INTERNAL_TOKEN';
export const BILLING_INTERNAL_TOKEN_MIN_LENGTH = 32;

export const BILLING_AUTH_INTROSPECTION_PATH =
	'internal/billing/auth/introspect';
export const BILLING_IDENTITY_RESOLVE_PATH =
	'internal/billing/identities/resolve';
export const BILLING_SOURCE_REPAIR_PATH =
	'internal/billing/source-events/repair';
export const BILLING_LIFECYCLE_COMPLETE_PATH =
	'internal/billing/lifecycle/complete';

export const BILLING_SERVICE_BASE_URL_ENV = 'BILLING_INTERNAL_BASE_URL';
export const BILLING_SERVICE_TIMEOUT_ENV = 'BILLING_INTERNAL_TIMEOUT_MS';
export const BILLING_SERVICE_DEFAULT_BASE_URL = 'http://127.0.0.1:4800';

export const BILLING_REVOKE_ENTITLEMENTS_PATH =
	'/internal/v1/billing/users/revoke-entitlements';
export const BILLING_ENSURE_TRIAL_PATH =
	'/internal/v1/billing/trials/ensure';
export const BILLING_SETTINGS_PATH = '/internal/v1/billing/settings';

export const AUTO_RENEWAL_CONSENT_VERSION = 'auto-renewal-2026-07-28-v4';
export const AUTO_RENEWAL_CONSENT_TEXT =
	'Я соглашаюсь сохранить способ оплаты в ЮKassa, автоматически продлевать выбранную подписку и списывать указанную на странице оплаты сумму с выбранной периодичностью. При недостатке средств или временной недоступности банка Исполнитель вправе выполнить после первого отказа не более двух повторных попыток ориентировочно через 24 и 72 часа. Запрос на каждую повторную попытку может быть отправлен в течение не более одного часа после расчётного момента; если это окно пропущено, такая попытка не выполняется. Новый период начинается только после успешного списания. Автопродление можно отключить в личном кабинете или через info@winwidget.ru в любое время до отправки очередного запроса на списание; оплаченный период сохранится. Новая стоимость применяется только после отдельного подтверждения.';

const AUTO_RENEWAL_OFFER_SECTION_PATTERN =
	/<section data-winwidget-section="auto-renewal-v1">[\s\S]*?<\/section>/;
const AUTO_RENEWAL_OFFER_SECTION_SHA256 =
	'f85b13c427d8ca2c48504b64d317277aeda7ea355bcaa4a8d0a218fa6b871df4';

export const isAutoRenewalOfferCompatible = (
	content?: string | null
): boolean => {
	const section = content?.match(AUTO_RENEWAL_OFFER_SECTION_PATTERN)?.[0];
	if (!section) return false;
	const normalized = section.replace(/\s+/g, ' ').trim();
	return (
		createHash('sha256').update(normalized, 'utf8').digest('hex') ===
		AUTO_RENEWAL_OFFER_SECTION_SHA256
	);
};
