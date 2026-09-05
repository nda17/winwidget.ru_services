import { Body, Controller, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { configureCrmIntakeBodyParser } from './crm-intake-body-parser';

@Controller('api/v1/crm/intake')
class BodyLimitController {
	@Post('imports/csv') csv(@Body() body: { value: string }) {
		return { length: body.value.length };
	}
	@Post('inbox') manual() {
		return { ok: true };
	}
	@Post('ingest/:id') api() {
		return { ok: true };
	}
}

describe('Real HTTP CSV JSON limit isolation', () => {
	let app: NestExpressApplication;
	let origin: string;
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [BodyLimitController]
		}).compile();
		app = module.createNestApplication<NestExpressApplication>({
			logger: false
		});
		configureCrmIntakeBodyParser(app);
		await app.listen(0, '127.0.0.1');
		origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		await app.close();
	});
	const send = (path: string, length: number) =>
		fetch(`${origin}/api/v1/crm/intake/${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ value: 'я'.repeat(length) })
		});
	it('allows CSV JSON over 32 KiB and counts UTF-8 bytes up to 1 MiB', async () => {
		const response = await send('imports/csv', 100_000);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ length: 100_000 });
		const tooLarge = await send('imports/csv', 524_288);
		expect(tooLarge.status).toBe(413);
		expect(await tooLarge.text()).not.toContain('яяяя');
	});
	it.each(['inbox', 'ingest/source', 'imports/csv/other'])(
		'retains 32 KiB for %s',
		async path => {
			const response = await send(path, 20_000);
			expect(response.status).toBe(413);
			await response.body?.cancel();
		}
	);
	it('continues to accept small ordinary requests', async () => {
		const response = await send('inbox', 100);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ ok: true });
	});
});
