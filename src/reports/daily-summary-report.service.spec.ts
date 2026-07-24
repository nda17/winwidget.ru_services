import { PrismaService } from '@/prisma.service';
import { DailySummaryReportService } from '@/reports/daily-summary-report.service';

describe('DailySummaryReportService', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('preserves the existing daily metrics and Telegram HTML format', async () => {
		const periodStart = new Date('2026-07-22T21:00:00.000Z');
		const periodEnd = new Date('2026-07-23T21:00:00.000Z');
		const createLeadDelegate = (
			current: number,
			previous: number,
			last7Days: number
		) => ({
			count: jest
				.fn()
				.mockResolvedValueOnce(current)
				.mockResolvedValueOnce(previous)
				.mockResolvedValueOnce(last7Days)
		});
		const paymentFindMany = jest
			.fn()
			.mockResolvedValueOnce([
				{
					amount: '100,50',
					userId: 'user-1',
					updatedAt: new Date('2026-07-23T10:00:00.000Z')
				},
				{
					amount: '200',
					userId: 'user-1',
					updatedAt: new Date('2026-07-23T11:00:00.000Z')
				},
				{
					amount: 'invalid',
					userId: 'user-2',
					updatedAt: new Date('2026-07-23T12:00:00.000Z')
				}
			])
			.mockResolvedValueOnce([{ amount: '50' }])
			.mockResolvedValueOnce([{ amount: '350.50' }])
			.mockResolvedValueOnce([{ userId: 'user-1' }]);
		const prisma = {
			user: {
				count: jest
					.fn()
					.mockResolvedValueOnce(100)
					.mockResolvedValueOnce(90)
					.mockResolvedValueOnce(5)
					.mockResolvedValueOnce(2)
					.mockResolvedValueOnce(3)
					.mockResolvedValueOnce(2)
					.mockResolvedValueOnce(14)
					.mockResolvedValueOnce(4)
			},
			payment: {
				findMany: paymentFindMany,
				count: jest
					.fn()
					.mockResolvedValueOnce(4)
					.mockResolvedValueOnce(8)
					.mockResolvedValueOnce(2)
					.mockResolvedValueOnce(1)
			},
			lead: createLeadDelegate(1, 2, 7),
			quizLead: createLeadDelegate(2, 3, 14),
			callbackLead: createLeadDelegate(3, 4, 21),
			countdownTimerLead: createLeadDelegate(4, 5, 28),
			stopOfferLead: createLeadDelegate(5, 6, 35),
			onlineConsultantLead: createLeadDelegate(6, 7, 42),
			calculatorLead: createLeadDelegate(7, 8, 49),
			subscription: {
				count: jest
					.fn()
					.mockResolvedValueOnce(1)
					.mockResolvedValueOnce(2)
					.mockResolvedValueOnce(3)
					.mockResolvedValueOnce(4)
			}
		} as unknown as PrismaService;
		const service = new DailySummaryReportService(prisma);
		const money = (value: number) =>
			new Intl.NumberFormat('ru-RU', {
				style: 'currency',
				currency: 'RUB',
				maximumFractionDigits: 2
			}).format(value);

		const message = await service.render(periodStart, periodEnd);

		expect(message).toBe(
			[
				'<b>Ежедневная сводка WinWidget</b>',
				'23.07.2026 · МСК',
				'',
				'<b>Итоги дня</b>',
				'👤 Регистрации: 3 (вчера: 2 · среднее за 7 дней: 2,0)',
				`💳 Выручка: ${money(300.5)} (вчера: ${money(50)} · за месяц: ${money(350.5)})`,
				'🎯 Лиды: 28 (вчера: 35 · среднее за 7 дней: 28,0)',
				'',
				'<b>Пользователи</b>',
				'- Всего: 100',
				'- С ролью USER: 90',
				'- С ролью ADMIN: 5',
				'- С ролью DEV: 2',
				'',
				'<b>Платежи</b>',
				'- Успешные: 3',
				'- Первые оплаты: 1',
				'- Повторные оплаты: 2',
				`- Средний чек: ${money(300.5 / 3)}`,
				'- Создано pending: 4',
				'- Pending сейчас: 8',
				'- Отменённые: 1',
				'',
				'<b>Лиды</b>',
				'- Всего: 28',
				'- Колесо: 1',
				'- Квизы: 2',
				'- Обратный звонок: 3',
				'- Таймеры: 4',
				'- Стоп-офферы: 5',
				'- Онлайн-консультанты: 6',
				'- Калькуляторы стоимости: 7',
				'',
				'<b>Подписки</b>',
				'- Истекают в ближайшие 24 часа: 1',
				'- Истекают в ближайшие 3 дня: 2',
				'- Истекают в ближайшие 7 дней: 3',
				'- Истекли, но ещё ACTIVE: 4',
				'',
				'<b>Требует внимания</b>',
				'- Pending более 24 часов: 2 ⚠️',
				'- Всего пользователей без email и телефона: 4 ⚠️',
				'- Просроченные ACTIVE-подписки: 4 ⚠️',
				'',
				'Сформировано: 24.07.2026, 03:00 МСК'
			].join('\n')
		);
		expect(paymentFindMany).toHaveBeenLastCalledWith({
			where: {
				status: 'SUCCEEDED',
				updatedAt: { lt: periodStart },
				userId: { in: ['user-1', 'user-2'] }
			},
			select: { userId: true },
			distinct: ['userId']
		});
	});
});
