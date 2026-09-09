const assert = require('node:assert/strict');

const apiKeys = [
	'SUPPORT_CRM_ACCESS_BASE_URL', 'SUPPORT_CRM_ACCESS_TOKEN',
	'SUPPORT_S3_ENDPOINT', 'SUPPORT_S3_REGION', 'SUPPORT_S3_BUCKET',
	'SUPPORT_S3_FORCE_PATH_STYLE', 'SUPPORT_S3_ACCESS_KEY_ID',
	'SUPPORT_S3_SECRET_ACCESS_KEY'
];

function validateSupportChatCompose(services) {
	const supportNames = ['support-api', 'support-worker', 'support-outbox-publisher'];
	const env = name => {
		assert.ok(services[name]?.environment, 'Missing Support process environment');
		return services[name].environment;
	};
	for (const name of supportNames) {
		assert.ok(['false', 'true'].includes(env(name).SUPPORT_WEB_CHAT_ENABLED));
		assert.equal(env(name).SUPPORT_WEB_CHAT_ENABLED, env('support-api').SUPPORT_WEB_CHAT_ENABLED);
	}
	for (const [name, service] of Object.entries(services)) {
		const values = service.environment ?? {};
		if (name !== 'support-api') for (const key of apiKeys) assert.ok(!Object.hasOwn(values, key), 'Support API credentials escaped their process');
		if (!['support-api', 'notification-delivery-worker'].includes(name)) assert.ok(!Object.hasOwn(values, 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN'));
		if (!supportNames.includes(name)) assert.ok(!Object.hasOwn(values, 'SUPPORT_WEB_CHAT_ENABLED'));
	}
	assert.equal(env('support-api').SUPPORT_CRM_ACCESS_BASE_URL, 'http://127.0.0.1:5300');
	assert.equal(env('notification-delivery-worker').SUPPORT_INTERNAL_BASE_URL, 'http://127.0.0.1:5100');
	assert.equal(env('support-api').SUPPORT_NOTIFICATION_DELIVERY_TOKEN, env('notification-delivery-worker').SUPPORT_NOTIFICATION_DELIVERY_TOKEN);
	assert.equal(env('support-api').TELEGRAM_SUPPORT_BOT_TOKEN, env('notification-delivery-worker').TELEGRAM_SUPPORT_BOT_TOKEN);
	assert.ok(!Object.hasOwn(env('notification-delivery-worker'), 'TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET'));
	assert.ok(!Object.hasOwn(env('support-outbox-publisher'), 'TELEGRAM_SUPPORT_BOT_TOKEN'));
	if (env('support-api').SUPPORT_WEB_CHAT_ENABLED === 'true') {
		for (const key of [...apiKeys.filter(key => key !== 'SUPPORT_S3_FORCE_PATH_STYLE'), 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN']) assert.ok(env('support-api')[key]);
		const endpoint = new URL(env('support-api').SUPPORT_S3_ENDPOINT);
		assert.equal(endpoint.protocol, 'https:');
		assert.equal(endpoint.href, endpoint.origin + '/');
		assert.ok(!endpoint.username && !endpoint.password);
	}
	return true;
}

module.exports = { validateSupportChatCompose };
