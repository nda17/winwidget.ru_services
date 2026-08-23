import { classifyIntegrationError } from './integration-error-classifier';

describe('notification delivery integration error classifier', () => {
	const unavailableTelegramDestination = Object.assign(
		new Error('Telegram destination failed'),
		{
			httpStatus: 400,
			description: 'Bad Request: chat not found'
		}
	);

	it.each([
		'telegram',
		'payment-telegram',
		'limit-telegram',
		'campaign-telegram',
		'daily-summary-delivery-telegram',
		'subscription-expiry-telegram'
	] as const)(
		'classifies %s failures through the Telegram taxonomy',
		kind => {
			expect(
				classifyIntegrationError(kind, unavailableTelegramDestination)
			).toEqual(
				expect.objectContaining({
					category: 'PERMANENT',
					normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
					retryable: false,
					mayDisableDestination: true
				})
			);
		}
	);

	it('classifies an explicit destination configuration error', () => {
		const error = Object.assign(new Error('Destination missing'), {
			code: 'DESTINATION_CONFIGURATION_MISSING'
		});

		expect(classifyIntegrationError('payment-telegram', error)).toEqual(
			expect.objectContaining({
				category: 'AUTH_CONFIGURATION',
				normalizedCode: 'DESTINATION_CONFIGURATION_MISSING',
				retryable: false,
				mayDisableDestination: false
			})
		);
	});

	it('classifies an invalid Telegram transport endpoint as configuration', () => {
		const error = Object.assign(
			new Error('Telegram configuration invalid'),
			{
				code: 'TELEGRAM_CONFIGURATION_INVALID',
				httpStatus: 0,
				description: 'Telegram API base URL is not allowed'
			}
		);

		expect(classifyIntegrationError('telegram', error)).toEqual(
			expect.objectContaining({
				category: 'AUTH_CONFIGURATION',
				normalizedCode: 'TELEGRAM_CONFIGURATION_INVALID',
				retryable: false,
				mayDisableDestination: false
			})
		);
	});
});
