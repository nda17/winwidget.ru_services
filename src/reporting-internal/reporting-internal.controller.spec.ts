import { GoneException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request, Response } from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { ReportingAuthIntrospectionService } from './reporting-auth-introspection.service';
import {
	REPORTING_AUTH_INTROSPECTION_PATH,
	REPORTING_PROJECTION_SNAPSHOT_PATH,
	REPORTING_SCHEDULE_POLICY_CONFIRM_PATH,
	REPORTING_SCHEDULE_POLICY_PATH
} from './reporting-internal.constants';
import { ReportingInternalController } from './reporting-internal.controller';
import { ReportingInternalTokenGuard } from './reporting-internal-token.guard';
import { ReportingProjectionSnapshotService } from './reporting-projection-snapshot.service';
import { ReportingSchedulePolicyService } from './reporting-schedule-authority.service';

const injectGet = async (app: INestApplication, path: string) => {
	const chunks: Buffer[] = [];
	const socket = new Duplex({
		read() {},
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			callback();
		}
	});
	const request = new IncomingMessage(socket as never);
	request.method = 'GET';
	request.url = path;
	const response = new ServerResponse(request);
	response.assignSocket(socket as never);
	const finished = new Promise<void>((resolve, reject) => {
		response.once('finish', resolve);
		response.once('error', reject);
	});
	const expressApp = app.getHttpAdapter().getInstance() as (
		request: IncomingMessage,
		response: ServerResponse
	) => void;
	expressApp(request, response);
	await finished;
	const raw = Buffer.concat(chunks).toString('utf8');
	const separator = raw.indexOf('\r\n\r\n');
	const body = separator >= 0 ? raw.slice(separator + 4) : '';

	return {
		statusCode: response.statusCode,
		headers: response.getHeaders(),
		body: JSON.parse(body) as Record<string, unknown>
	};
};

describe('ReportingInternalController', () => {
	it('uses the versioned global-prefix paths and propagates correlation', async () => {
		expect(REPORTING_AUTH_INTROSPECTION_PATH).toBe(
			'internal/reporting/auth/introspect'
		);
		expect(REPORTING_PROJECTION_SNAPSHOT_PATH).toBe(
			'internal/reporting/snapshot'
		);
		expect(REPORTING_SCHEDULE_POLICY_PATH).toBe(
			'internal/reporting/schedule-policy'
		);
		expect(REPORTING_SCHEDULE_POLICY_CONFIRM_PATH).toBe(
			'internal/reporting/schedule-policy/confirm'
		);

		const introspect = jest.fn().mockResolvedValue({ active: true });
		const retired = jest.fn(() => {
			throw new GoneException('retired');
		});
		const reserve = jest.fn().mockResolvedValue({ generation: '2' });
		const confirm = jest.fn().mockResolvedValue({ generation: '2' });
		const controller = new ReportingInternalController(
			{ introspect } as unknown as ReportingAuthIntrospectionService,
			{ retired } as unknown as ReportingProjectionSnapshotService,
			{
				reserve,
				confirm
			} as unknown as ReportingSchedulePolicyService
		);
		const correlationId = '22222222-2222-4222-8222-222222222222';
		const request = {
			headers: { 'x-correlation-id': correlationId }
		} as unknown as Request;
		const response = {
			status: jest.fn().mockReturnThis(),
			setHeader: jest.fn(),
			end: jest.fn(),
			destroy: jest.fn(),
			headersSent: false
		} as unknown as Response;

		await controller.introspect('Bearer token', request, response);
		expect(() => controller.snapshot(request, response)).toThrow(
			GoneException
		);
		await controller.reserveSchedule(
			{
				changeId: '33333333-3333-4333-8333-333333333333',
				scheduleTime: '02:10',
				expectedScheduleGeneration: '1',
				actorId: 'admin-id'
			},
			request,
			response
		);
		await controller.confirmSchedulePolicy(
			{
				changeId: '33333333-3333-4333-8333-333333333333',
				scheduleGeneration: '2'
			},
			request,
			response
		);

		expect(response.setHeader).toHaveBeenCalledWith(
			'X-Correlation-ID',
			correlationId
		);
		expect(retired).toHaveBeenCalledTimes(1);
		expect(reserve).toHaveBeenCalledWith(
			{
				changeId: '33333333-3333-4333-8333-333333333333',
				scheduleTime: '02:10',
				expectedScheduleGeneration: '1',
				actorId: 'admin-id'
			},
			correlationId
		);
		expect(confirm).toHaveBeenCalledWith(
			{
				changeId: '33333333-3333-4333-8333-333333333333',
				scheduleGeneration: '2'
			},
			correlationId
		);
	});

	it('returns an HTTP 410 before setting streaming response headers', async () => {
		const moduleRef = await Test.createTestingModule({
			controllers: [ReportingInternalController],
			providers: [
				{
					provide: ReportingAuthIntrospectionService,
					useValue: { introspect: jest.fn() }
				},
				ReportingProjectionSnapshotService,
				{
					provide: ReportingSchedulePolicyService,
					useValue: { reserve: jest.fn(), confirm: jest.fn() }
				}
			]
		})
			.overrideGuard(ReportingInternalTokenGuard)
			.useValue({ canActivate: () => true })
			.compile();
		const app = moduleRef.createNestApplication();
		await app.init();

		try {
			const result = await injectGet(app, '/internal/reporting/snapshot');

			expect(result.statusCode).toBe(410);
			expect(result.body).toMatchObject({
				statusCode: 410,
				message:
					'Core Reporting projection snapshot was retired after Widgets ownership handoff'
			});
			expect(result.headers['content-type']).toContain('application/json');
			expect(result.headers['x-accel-buffering']).toBeUndefined();
			expect(result.headers['x-correlation-id']).toBeDefined();
		} finally {
			await app.close();
		}
	});
});
