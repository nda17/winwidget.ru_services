import { parseStrictBoolean } from '../runtime/billing-runtime.service';

export const WINCRM_PROVIDER_EVENT =
	'billing.wincrm.provider-operation.requested.v1';
export const WINCRM_PROVIDER_QUEUE =
	'winwidget.billing.wincrm-provider.v1';
export const WINCRM_PROVIDER_DEAD_EXCHANGE =
	'winwidget.billing.wincrm-provider.dead-letter';
export const WINCRM_PROVIDER_DEAD_QUEUE = `${WINCRM_PROVIDER_QUEUE}.dead-letter`;
export const WINCRM_PROVIDER_REQUEUE_MS = 5_000;

export function wincrmPaymentsEnabled(): boolean {
	return parseStrictBoolean(
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED,
		false,
		'BILLING_WINCRM_PAYMENTS_ENABLED'
	);
}

// Keep reconciliation alive after new payments have been switched off. Once
// provisioned, the broker credential is retained until durable jobs are drained.
export function wincrmProviderMessagingEnabled(): boolean {
	return (
		wincrmPaymentsEnabled() ||
		Boolean(process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL?.trim())
	);
}

export function wincrmProviderBrokerConfiguration() {
	const raw =
		process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL?.trim() || '';
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error('WinCRM provider RabbitMQ URL is required');
	}
	if (
		!parsed.username ||
		!parsed.password ||
		parsed.hash ||
		parsed.search ||
		!(
			parsed.protocol === 'amqps:' ||
			(parsed.protocol === 'amqp:' &&
				['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
		)
	) {
		throw new Error(
			'WinCRM provider RabbitMQ requires scoped credentials and TLS except on loopback'
		);
	}
	return {
		url: raw,
		assertTopology: parseStrictBoolean(
			process.env.BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY,
			false,
			'BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY'
		)
	};
}
