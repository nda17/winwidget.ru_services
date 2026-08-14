import { Request, Response } from 'express';
import {
	REPORTING_SCHEDULE_POLICY_CONFIRM_PATH,
	REPORTING_SCHEDULE_POLICY_PATH
} from './reporting-internal.constants';
import { ReportingInternalController } from './reporting-internal.controller';
import { ReportingSchedulePolicyService } from './reporting-schedule-authority.service';

describe('ReportingInternalController', () => {
	it('exposes only the retained schedule-policy boundary and propagates correlation', async () => {
		expect(REPORTING_SCHEDULE_POLICY_PATH).toBe(
			'internal/reporting/schedule-policy'
		);
		expect(REPORTING_SCHEDULE_POLICY_CONFIRM_PATH).toBe(
			'internal/reporting/schedule-policy/confirm'
		);

		const reserve = jest.fn().mockResolvedValue({ generation: '2' });
		const confirm = jest.fn().mockResolvedValue({ generation: '2' });
		const controller = new ReportingInternalController({
			reserve,
			confirm
		} as unknown as ReportingSchedulePolicyService);
		const correlationId = '22222222-2222-4222-8222-222222222222';
		const request = {
			headers: { 'x-correlation-id': correlationId }
		} as unknown as Request;
		const response = {
			setHeader: jest.fn()
		} as unknown as Response;

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
		expect(reserve).toHaveBeenCalledWith(
			expect.objectContaining({ scheduleTime: '02:10' }),
			correlationId
		);
		expect(confirm).toHaveBeenCalledWith(
			expect.objectContaining({ scheduleGeneration: '2' }),
			correlationId
		);
	});
});
