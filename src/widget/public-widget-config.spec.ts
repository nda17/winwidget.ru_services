import { CalculatorService } from '@/calculator/calculator.service';
import { CallbackService } from '@/callback/callback.service';
import { CountdownTimerService } from '@/countdown-timer/countdown-timer.service';
import { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
import { QuizService } from '@/quiz/quiz.service';
import { StopOfferService } from '@/stop-offer/stop-offer.service';
import { WidgetService } from '@/widget/widget.service';
import { Plan, SubscriptionStatus } from '@prisma/client';

const PUBLIC_KEY = 'public-key';
const SECRET_INTEGRATION_VALUES = {
	email: 'private-recipient@example.test',
	webhookUrl: 'https://hooks.example.test/private-webhook-token',
	telegramChatId: '-1001234567890',
	bitrix24WebhookUrl:
		'https://example.bitrix24.test/rest/1/private-bitrix-token',
	amoCrmDomain: 'private-account.amocrm.test',
	amoCrmToken: 'private-amo-token'
};
const SERVER_ONLY_INTEGRATION_KEYS = [
	'integrations',
	'webhookUrl',
	'telegramChatId',
	'bitrix24WebhookUrl',
	'amoCrmDomain',
	'amoCrmToken'
];

interface SqlFragment {
	strings: readonly string[];
	values: readonly unknown[];
}

const isSqlFragment = (value: unknown): value is SqlFragment =>
	Boolean(
		value &&
		typeof value === 'object' &&
		'strings' in value &&
		'values' in value
	);

const flattenSql = (fragment: SqlFragment): string =>
	fragment.strings.reduce((result, part, index) => {
		const nestedValue = fragment.values[index];
		return `${result}${part}${
			isSqlFragment(nestedValue) ? flattenSql(nestedValue) : ''
		}`;
	}, '');

function collectKeys(
	value: unknown,
	keys = new Set<string>()
): Set<string> {
	if (!value || typeof value !== 'object') return keys;
	if (Array.isArray(value)) {
		value.forEach(item => collectKeys(item, keys));
		return keys;
	}

	Object.entries(value).forEach(([key, nestedValue]) => {
		keys.add(key);
		collectKeys(nestedValue, keys);
	});
	return keys;
}

describe('public widget config projections', () => {
	const createCases = (recordOverrides: Record<string, unknown> = {}) => {
		const record = {
			id: 'widget-id',
			userId: 'user-id',
			publicKey: PUBLIC_KEY,
			name: 'Widget',
			isActive: true,
			installDomain: null,
			publishedAt: new Date('2026-07-27T12:00:00.000Z'),
			publishedVersion: 1,
			config: {
				integrations: {
					...SECRET_INTEGRATION_VALUES,
					yandexMetrikaId: '123456',
					vkPixelId: '654321',
					roistatEnabled: true
				}
			},
			...recordOverrides
		};
		const prisma = {
			widget: { findUnique: jest.fn().mockResolvedValue(record) },
			quiz: { findUnique: jest.fn().mockResolvedValue(record) },
			callback: { findUnique: jest.fn().mockResolvedValue(record) },
			countdownTimer: { findUnique: jest.fn().mockResolvedValue(record) },
			stopOffer: { findUnique: jest.fn().mockResolvedValue(record) },
			onlineConsultant: {
				findUnique: jest.fn().mockResolvedValue(record)
			},
			calculator: { findUnique: jest.fn().mockResolvedValue(record) }
		};
		const subscriptionService = {
			checkAndResetPeriod: jest.fn().mockResolvedValue({
				status: SubscriptionStatus.ACTIVE,
				plan: Plan.HARD,
				leadsThisPeriod: 0
			})
		};
		const fileService = {
			getWidgetButtonImageUrl: jest.fn().mockReturnValue(null)
		};
		const safeOutboundHttpService = {};

		const widgetService = new WidgetService(
			prisma as never,
			subscriptionService as never,
			fileService as never,
			safeOutboundHttpService as never
		);
		const quizService = new QuizService(
			prisma as never,
			subscriptionService as never,
			fileService as never,
			safeOutboundHttpService as never
		);
		const callbackService = new CallbackService(
			prisma as never,
			subscriptionService as never,
			fileService as never,
			safeOutboundHttpService as never
		);
		const timerService = new CountdownTimerService(
			prisma as never,
			subscriptionService as never,
			fileService as never,
			safeOutboundHttpService as never
		);
		const stopOfferService = new StopOfferService(
			prisma as never,
			subscriptionService as never,
			safeOutboundHttpService as never
		);
		const onlineConsultantService = new OnlineConsultantService(
			prisma as never,
			subscriptionService as never,
			fileService as never,
			safeOutboundHttpService as never
		);
		const calculatorService = new CalculatorService(
			prisma as never,
			subscriptionService as never,
			fileService as never,
			safeOutboundHttpService as never
		);

		return [
			{
				name: 'wheel',
				load: () =>
					widgetService.getPublicConfig(PUBLIC_KEY, undefined, null, true)
			},
			{
				name: 'quiz',
				load: () =>
					quizService.getPublicConfig(PUBLIC_KEY, undefined, null, true)
			},
			{
				name: 'callback',
				load: () =>
					callbackService.getPublicConfig(
						PUBLIC_KEY,
						undefined,
						null,
						true
					)
			},
			{
				name: 'countdown timer',
				load: () =>
					timerService.getPublicConfig(PUBLIC_KEY, undefined, null, true)
			},
			{
				name: 'stop offer',
				load: () =>
					stopOfferService.getPublicConfig(
						PUBLIC_KEY,
						undefined,
						null,
						true
					)
			},
			{
				name: 'online consultant',
				load: () =>
					onlineConsultantService.getPublicConfig(
						PUBLIC_KEY,
						undefined,
						null,
						true
					)
			},
			{
				name: 'calculator',
				load: () =>
					calculatorService.getPublicConfig(PUBLIC_KEY, null, true)
			}
		];
	};

	it.each(createCases())(
		'$name excludes server-only integration credentials',
		async ({ load }) => {
			const config = await load();
			const serializedConfig = JSON.stringify(config);
			const publicKeys = collectKeys(config);

			expect(config).toMatchObject({
				isActive: true,
				publishedVersion: 1,
				yandexMetrikaId: '123456',
				vkPixelId: '654321',
				roistatEnabled: true
			});
			SERVER_ONLY_INTEGRATION_KEYS.forEach(key => {
				expect(publicKeys).not.toContain(key);
			});
			Object.values(SECRET_INTEGRATION_VALUES).forEach(secret => {
				expect(serializedConfig).not.toContain(secret);
			});
		}
	);

	it.each(createCases({ publishedAt: null, publishedVersion: 0 }))(
		'$name stays inactive before its first publication',
		async ({ load }) => {
			await expect(load()).resolves.toEqual({ isActive: false });
		}
	);

	it('excludes deleted owners from admin widget monitoring SQL', () => {
		const widgetService = new WidgetService(
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const monitoringSql = (
			widgetService as unknown as {
				getAdminWidgetMonitoringBaseSql(): SqlFragment;
			}
		).getAdminWidgetMonitoringBaseSql();

		expect(flattenSql(monitoringSql)).toContain(
			'JOIN "User" u ON u.id = entity.user_id AND u.deleted_at IS NULL'
		);
	});
});
