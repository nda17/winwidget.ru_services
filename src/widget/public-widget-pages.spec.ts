import { CalculatorPublicController } from '@/calculator/calculator-public.controller';
import { CallbackPublicController } from '@/callback/callback-public.controller';
import { CountdownTimerPublicController } from '@/countdown-timer/countdown-timer-public.controller';
import { OnlineConsultantPublicController } from '@/online-consultant/online-consultant-public.controller';
import { QuizPublicController } from '@/quiz/quiz-public.controller';
import { StopOfferPublicController } from '@/stop-offer/stop-offer-public.controller';
import { WidgetPublicController } from '@/widget/widget-public.controller';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

const VALID_KEY = 'abcdef123456';
const UNTRUSTED_HOST = 'attacker.example';

const PUBLIC_ROUTES = [
	{
		name: 'wheel loader',
		path: '/widget',
		expectedAsset: '/widgets/wheel.js'
	},
	{
		name: 'wheel page',
		path: '/page-wheel',
		expectedAsset: '/widgets/wheel.js'
	},
	{
		name: 'quiz page',
		path: '/page-quiz',
		expectedAsset: '/widgets/quiz.js'
	},
	{
		name: 'callback page',
		path: '/page-callback',
		expectedAsset: '/widgets/callback.js'
	},
	{
		name: 'timer page',
		path: '/page-timer',
		expectedAsset: '/widgets/timer.js'
	},
	{
		name: 'stop offer page',
		path: '/page-stop-offer',
		expectedAsset: '/widgets/stop-offer.js'
	},
	{
		name: 'online consultant page',
		path: '/page-online-consultant',
		expectedAsset: '/widgets/online-consultant.js'
	},
	{
		name: 'calculator page',
		path: '/page-calculator',
		expectedAsset: '/widgets/calculator.js'
	}
];

describe('public widget pages', () => {
	let app: INestApplication;

	beforeAll(async () => {
		const testingModule = await Test.createTestingModule({
			controllers: [
				WidgetPublicController,
				QuizPublicController,
				CallbackPublicController,
				CountdownTimerPublicController,
				StopOfferPublicController,
				OnlineConsultantPublicController,
				CalculatorPublicController
			]
		}).compile();

		app = testingModule.createNestApplication();
		await app.init();
	});

	afterAll(async () => {
		await app.close();
	});

	it.each(PUBLIC_ROUTES)(
		'$name rejects an injection-shaped key',
		async ({ path }) => {
			const maliciousKey = encodeURIComponent(
				'abc";window.__widgetProbe=1;'
			);
			const response = await request(app.getHttpServer()).get(
				`${path}/${maliciousKey}`
			);

			expect(response.status).toBe(404);
			expect(response.text).not.toContain('__widgetProbe');
		}
	);

	it.each(PUBLIC_ROUTES)(
		'$name renders a valid key without reflecting the Host header',
		async ({ path, expectedAsset }) => {
			const response = await request(app.getHttpServer())
				.get(`${path}/${VALID_KEY}`)
				.set('Host', UNTRUSTED_HOST);

			expect(response.status).toBe(200);
			expect(response.text).toContain(VALID_KEY);
			expect(response.text).toContain(expectedAsset);
			expect(response.text).not.toContain(UNTRUSTED_HOST);
		}
	);
});
