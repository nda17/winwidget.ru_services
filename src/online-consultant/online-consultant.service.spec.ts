import { SubmitOnlineConsultantLeadDto } from '@/online-consultant/dto/submit-online-consultant-lead.dto';
import { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';

describe('OnlineConsultantService public lead contract', () => {
	const publicKey = '0123456789ab';
	const createdAt = new Date('2026-07-27T12:00:00.000Z');

	const createFixture = (dataType = 'PHONE_AND_EMAIL') => {
		const transaction = {
			onlineConsultantLead: {
				findFirst: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({
					id: 'lead-id',
					createdAt
				})
			}
		};
		const prisma = {
			onlineConsultant: {
				findUnique: jest.fn().mockResolvedValue({
					id: 'online-consultant-id',
					userId: 'user-id',
					publicKey,
					name: 'Онлайн-консультант',
					isActive: true,
					installDomain: null,
					config: {
						dataType,
						filterDuplicates: true
					},
					user: {
						subscription: null,
						authIdentities: []
					}
				})
			}
		};
		const subscriptionService = {
			createLeadWithinLimit: jest.fn(
				async (
					_userId: string,
					createLead: (tx: typeof transaction) => Promise<unknown>
				) => ({
					lead: await createLead(transaction)
				})
			)
		};
		const service = new OnlineConsultantService(
			prisma as never,
			subscriptionService as never,
			{} as never,
			{} as never
		);

		return {
			service,
			prisma,
			subscriptionService,
			transaction
		};
	};

	it('normalizes contacts before duplicate lookup and persistence', async () => {
		const fixture = createFixture();

		await expect(
			fixture.service.submitLead(
				publicKey,
				{
					phone: '8 (999) 111-22-33',
					email: ' User@Example.COM ',
					actionLabel: 'Цена',
					actionValue: 'Ответ'
				},
				undefined,
				null,
				true
			)
		).resolves.toMatchObject({
			success: true,
			lead: { id: 'lead-id' }
		});

		expect(
			fixture.transaction.onlineConsultantLead.findFirst
		).toHaveBeenCalledWith({
			where: {
				onlineConsultantId: 'online-consultant-id',
				OR: [{ phone: '+79991112233' }, { email: 'user@example.com' }]
			}
		});
		expect(
			fixture.transaction.onlineConsultantLead.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				phone: '+79991112233',
				email: 'user@example.com'
			})
		});
	});

	it('compares normalized contacts when duplicate filtering is enabled', async () => {
		const fixture = createFixture('PHONE');
		fixture.transaction.onlineConsultantLead.findFirst.mockResolvedValue({
			id: 'existing-lead'
		});

		await expect(
			fixture.service.submitLead(
				publicKey,
				{ phone: '8 999 111 22 33' },
				undefined,
				null,
				true
			)
		).rejects.toThrow('Заявка с таким контактом уже существует');
		expect(
			fixture.transaction.onlineConsultantLead.create
		).not.toHaveBeenCalled();
	});

	it.each([
		{
			dataType: 'PHONE',
			dto: { phone: 'не телефон' },
			message: 'Укажите корректный телефон'
		},
		{
			dataType: 'EMAIL',
			dto: { email: 'не-email' },
			message: 'Укажите корректный email'
		}
	])(
		'rejects invalid $dataType contact before consuming the lead limit',
		async ({ dataType, dto, message }) => {
			const fixture = createFixture(dataType);

			await expect(
				fixture.service.submitLead(publicKey, dto, undefined, null, true)
			).rejects.toThrow(message);
			expect(
				fixture.subscriptionService.createLeadWithinLimit
			).not.toHaveBeenCalled();
		}
	);

	it.each([
		{
			dataType: 'PHONE',
			dto: { email: 'user@example.com' },
			message: 'Введите телефон'
		},
		{
			dataType: 'EMAIL',
			dto: { phone: '+79991112233' },
			message: 'Введите email'
		},
		{
			dataType: 'PHONE_AND_EMAIL',
			dto: { phone: '+79991112233' },
			message: 'Введите телефон и email'
		},
		{
			dataType: 'NONE',
			dto: {},
			message: 'Сбор контактов отключён'
		}
	])(
		'enforces the configured $dataType contact mode',
		async ({ dataType, dto, message }) => {
			const fixture = createFixture(dataType);

			await expect(
				fixture.service.submitLead(publicKey, dto, undefined, null, true)
			).rejects.toThrow(message);
			expect(
				fixture.subscriptionService.createLeadWithinLimit
			).not.toHaveBeenCalled();
		}
	);

	it('validates email in the request DTO without requiring the path key in body', async () => {
		const validDto = Object.assign(new SubmitOnlineConsultantLeadDto(), {
			phone: '+79991112233'
		});
		const invalidDto = Object.assign(new SubmitOnlineConsultantLeadDto(), {
			email: 'не-email'
		});

		await expect(validate(validDto)).resolves.toHaveLength(0);
		const errors = await validate(invalidDto);

		expect(errors).toHaveLength(1);
		expect(errors[0].constraints?.isEmail).toBe(
			'Укажите корректный email'
		);
	});

	it('throws NestJS 400 errors for malformed contacts', async () => {
		const fixture = createFixture('PHONE');

		await expect(
			fixture.service.submitLead(
				publicKey,
				{ phone: '123' },
				undefined,
				null,
				true
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
