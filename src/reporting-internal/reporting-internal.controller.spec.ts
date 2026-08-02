import { Request, Response } from 'express';
import { ReportingAuthIntrospectionService } from './reporting-auth-introspection.service';
import {
	REPORTING_AUTH_INTROSPECTION_PATH,
	REPORTING_PROJECTION_SNAPSHOT_PATH,
	REPORTING_SCHEDULE_POLICY_CONFIRM_PATH,
	REPORTING_SCHEDULE_POLICY_PATH
} from './reporting-internal.constants';
import { ReportingInternalController } from './reporting-internal.controller';
import { ReportingProjectionSnapshotService } from './reporting-projection-snapshot.service';
import { ReportingSchedulePolicyService } from './reporting-schedule-authority.service';

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
		const stream = jest.fn().mockResolvedValue(undefined);
		const reserve = jest.fn().mockResolvedValue({ generation: '2' });
		const confirm = jest.fn().mockResolvedValue({ generation: '2' });
		const controller = new ReportingInternalController(
			{ introspect } as unknown as ReportingAuthIntrospectionService,
			{ stream } as unknown as ReportingProjectionSnapshotService,
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
		await controller.snapshot(request, response);
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
		expect(response.setHeader).toHaveBeenCalledWith(
			'Content-Type',
			'application/x-ndjson; charset=utf-8'
		);
		expect(response.setHeader).toHaveBeenCalledWith(
			'Cache-Control',
			'no-store'
		);
		expect(response.setHeader).toHaveBeenCalledWith(
			'X-Accel-Buffering',
			'no'
		);
		expect(stream).toHaveBeenCalledWith(request, response);
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
});
