import { GoneException } from '@nestjs/common';
import { Request, Response } from 'express';
import { ReportingProjectionSnapshotService } from './reporting-projection-snapshot.service';

describe('ReportingProjectionSnapshotService', () => {
	it('fails closed before reading Core after the multi-database ownership handoff', async () => {
		const response = {
			write: jest.fn(),
			destroyed: false,
			writableEnded: false
		} as unknown as Response;
		const request = { aborted: false } as Request;

		await expect(
			new ReportingProjectionSnapshotService().stream(request, response)
		).rejects.toEqual(
			expect.objectContaining({
				constructor: GoneException,
				message:
					'Core Reporting projection snapshot was retired after Widgets ownership handoff'
			})
		);
		expect(response.write).not.toHaveBeenCalled();
	});
});
