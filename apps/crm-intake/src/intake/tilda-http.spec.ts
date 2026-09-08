import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { configureCrmIntakeBodyParser } from '../config/crm-intake-body-parser';
import { IntakeIngestionController } from './intake-ingestion.controller';
import {
	IntakeIngestionService,
	sourceTokenHash
} from './intake-ingestion.service';
import { normalizeTildaPayload } from './tilda-payload';

describe('Tilda HTTP adapter', () => {
	let app: NestExpressApplication;
	let url: string;
	const token = randomBytes(32).toString('base64url');
	const sourceId = randomUUID();
	const ingestion = {
		ingest: jest.fn().mockResolvedValue({ schemaVersion: 1 }),
		ingestTilda: jest.fn((id: string, key: string, body: unknown) => {
			sourceTokenHash(`Bearer ${key}`);
			const normalized = normalizeTildaPayload(id, body);
			return normalized.kind === 'probe'
				? { connected: true }
				: normalized.dto;
		})
	};
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [IntakeIngestionController],
			providers: [{ provide: IntakeIngestionService, useValue: ingestion }]
		}).compile();
		app = module.createNestApplication<NestExpressApplication>({
			logger: false
		});
		configureCrmIntakeBodyParser(app);
		app.useGlobalPipes(
			new ValidationPipe({
				transform: true,
				whitelist: true,
				forbidNonWhitelisted: true,
				validationError: { target: false, value: false }
			})
		);
		app.setGlobalPrefix('api/v1');
		await app.listen(0, '127.0.0.1');
		url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/crm/intake/ingest/${sourceId}`;
	});
	afterAll(async () => {
		await app.close();
	});
	const post = (
		body: string,
		contentType = 'application/x-www-form-urlencoded',
		headers: Record<string, string> = {},
		suffix = '/tilda'
	) =>
		fetch(`${url}${suffix}`, {
			method: 'POST',
			headers: {
				'content-type': contentType,
				'x-wincrm-source-token': token,
				...headers
			},
			body
		});
	it('accepts the form-encoded connection probe and decodes real form values exactly once', async () => {
		const probe = await post('test=test');
		expect(probe.status).toBe(200);
		expect(await probe.json()).toEqual({ connected: true });
		const response = await post(
			new URLSearchParams({
				tranid: '1:2',
				Name: 'Анна + Олег',
				Phone: '+79991234567',
				Comments: 'Скидка 10% %D0'
			}).toString()
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			name: 'Анна + Олег',
			phone: '+79991234567',
			message: expect.stringContaining('Скидка 10% %D0')
		});
	});
	it('accepts JSON and preserves the original generic DTO validation', async () => {
		const response = await post(
			JSON.stringify({ tranid: '1:3', Email: 'a@example.test' }),
			'application/json'
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			name: 'Заявка с Tilda',
			email: 'a@example.test'
		});
		const old = await post(
			JSON.stringify({ tranid: '1:3', Name: 'Анна' }),
			'application/json',
			{},
			''
		);
		expect(old.status).toBe(400);
		expect(ingestion.ingest).not.toHaveBeenCalled();
	});
	it.each([
		[
			'test=test&Name=unexpected',
			'application/x-www-form-urlencoded',
			400
		],
		['tranid=1:4&Name=a&Name=b', 'application/x-www-form-urlencoded', 400],
		['test=test', 'text/plain', 415],
		[
			JSON.stringify({ tranid: '1:5', Comments: 'x'.repeat(33000) }),
			'application/json',
			413
		],
		[
			`tranid=1:6&Comments=${'x'.repeat(33000)}`,
			'application/x-www-form-urlencoded',
			413
		],
		[
			Array.from({ length: 101 }, (_, i) => `f${i}=v`).join('&'),
			'application/x-www-form-urlencoded',
			413
		]
	])(
		'rejects malformed, unsupported or oversized bodies safely',
		async (body, media, status) => {
			const response = await post(body as string, media as string);
			expect(response.status).toBe(status);
			expect(await response.text()).not.toContain('unexpected');
		}
	);
	it('rejects query credentials and mixed Authorization before ingestion', async () => {
		const mixed = await post('test=test', undefined, {
			authorization: `Bearer ${token}`
		});
		expect(mixed.status).toBe(401);
		expect(await mixed.text()).not.toContain(token);
		const query = await post(
			'test=test',
			undefined,
			{},
			'/tilda?token=not-supported'
		);
		expect(query.status).toBe(400);
		await query.body?.cancel();
	});
});
