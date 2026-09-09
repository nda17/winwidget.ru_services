const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateSupportChatCompose } = require('./validate-support-chat-compose.cjs');

const fixture = () => ({
	'support-api': { environment: { SUPPORT_WEB_CHAT_ENABLED: 'false', SUPPORT_CRM_ACCESS_BASE_URL: 'http://127.0.0.1:5300', SUPPORT_NOTIFICATION_DELIVERY_TOKEN: '', TELEGRAM_SUPPORT_BOT_TOKEN: 'support' } },
	'support-worker': { environment: { SUPPORT_WEB_CHAT_ENABLED: 'false', TELEGRAM_SUPPORT_BOT_TOKEN: 'support' } },
	'support-outbox-publisher': { environment: { SUPPORT_WEB_CHAT_ENABLED: 'false' } },
	'notification-delivery-worker': { environment: { SUPPORT_INTERNAL_BASE_URL: 'http://127.0.0.1:5100', SUPPORT_NOTIFICATION_DELIVERY_TOKEN: '', TELEGRAM_SUPPORT_BOT_TOKEN: 'support' } }
});

test('closed Support feature retains the isolated outbound bot and private context pair', () => {
	assert.equal(validateSupportChatCompose(fixture()), true);
});
test('secrets cannot escape into publishers or unrelated workers', () => {
	for (const [name, key] of [['support-worker', 'SUPPORT_S3_SECRET_ACCESS_KEY'], ['support-outbox-publisher', 'TELEGRAM_SUPPORT_BOT_TOKEN'], ['notification-delivery-worker', 'TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET'], ['support-worker', 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN']]) {
		const services = fixture(); services[name].environment[key] = 'synthetic';
		assert.throws(() => validateSupportChatCompose(services));
	}
});
test('split feature flags and wrong internal service destinations fail closed', () => {
	for (const [name, key, value] of [['support-worker', 'SUPPORT_WEB_CHAT_ENABLED', 'true'], ['support-api', 'SUPPORT_CRM_ACCESS_BASE_URL', 'http://127.0.0.1:4700'], ['notification-delivery-worker', 'SUPPORT_INTERNAL_BASE_URL', 'https://example.invalid']]) {
		const services = fixture(); services[name].environment[key] = value;
		assert.throws(() => validateSupportChatCompose(services));
	}
});
test('activation requires configured API storage and scoped credentials', () => {
	const services = fixture();
	for (const name of ['support-api', 'support-worker', 'support-outbox-publisher']) services[name].environment.SUPPORT_WEB_CHAT_ENABLED = 'true';
	assert.throws(() => validateSupportChatCompose(services));
});
