import { Prisma } from '@prisma/widgets-client';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import { WidgetsDomainRepository } from './widgets-domain.repository';
import { WidgetType } from './widgets-domain.types';

describe('WidgetsDomainRepository lead stats aggregation', () => {
	const prisma = {
		lead: { groupBy: jest.fn() },
		quizLead: { groupBy: jest.fn() },
		calculatorLead: { aggregate: jest.fn() }
	};
	const repository = new WidgetsDomainRepository(
		prisma as unknown as WidgetsPrismaService
	);

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('groups wheel leads by bonus in PostgreSQL', async () => {
		prisma.lead.groupBy.mockResolvedValue([
			{ bonus: '10%', _count: { id: 3 } },
			{ bonus: null, _count: { id: 1 } }
		]);

		await expect(
			repository.aggregateLeadStats(WidgetType.WHEEL, 'wheel-1')
		).resolves.toEqual({
			kind: 'grouped',
			total: 4,
			groups: [
				{ value: '10%', count: 3 },
				{ value: null, count: 1 }
			]
		});
		expect(prisma.lead.groupBy).toHaveBeenCalledWith({
			by: ['bonus'],
			where: { widgetId: 'wheel-1' },
			_count: { id: true },
			orderBy: { _count: { id: 'desc' } }
		});
	});

	it('groups quiz leads by stored result in PostgreSQL', async () => {
		prisma.quizLead.groupBy.mockResolvedValue([
			{ result: 'r1', _count: { id: 2 } },
			{ result: null, _count: { id: 1 } }
		]);

		await expect(
			repository.aggregateLeadStats(WidgetType.QUIZ, 'quiz-1')
		).resolves.toEqual({
			kind: 'grouped',
			total: 3,
			groups: [
				{ value: 'r1', count: 2 },
				{ value: null, count: 1 }
			]
		});
		expect(prisma.quizLead.groupBy).toHaveBeenCalledWith({
			by: ['result'],
			where: { quizId: 'quiz-1' },
			_count: { id: true },
			orderBy: { _count: { id: 'desc' } }
		});
	});

	it('calculates calculator stats in PostgreSQL', async () => {
		prisma.calculatorLead.aggregate.mockResolvedValue({
			_count: { id: 2 },
			_min: { calculatedPrice: new Prisma.Decimal('10.00') },
			_max: { calculatedPrice: new Prisma.Decimal('20.00') },
			_avg: { calculatedPrice: new Prisma.Decimal('15.00') }
		});

		await expect(
			repository.aggregateLeadStats(WidgetType.CALCULATOR, 'calculator-1')
		).resolves.toEqual({
			kind: 'calculator',
			total: 2,
			min: new Prisma.Decimal('10.00'),
			max: new Prisma.Decimal('20.00'),
			average: new Prisma.Decimal('15.00')
		});
		expect(prisma.calculatorLead.aggregate).toHaveBeenCalledWith({
			where: { calculatorId: 'calculator-1' },
			_count: { id: true },
			_min: { calculatedPrice: true },
			_max: { calculatedPrice: true },
			_avg: { calculatedPrice: true }
		});
	});
});
