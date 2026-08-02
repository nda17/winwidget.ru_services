import { PrismaService } from '@/prisma.service';
import { createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { ReportingProjectionSnapshotService } from './reporting-projection-snapshot.service';

const DATE = '2026-07-31T12:00:00.000Z';

describe('ReportingProjectionSnapshotService', () => {
	it('streams the strict header, versioned records and hashed footer', async () => {
		let queryIndex = 0;
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			$queryRaw: jest.fn().mockImplementation(async () => {
				queryIndex += 1;
				if (queryIndex === 1) {
					return [{ enabled: true, activatedAt: new Date(DATE) }];
				}
				if (queryIndex === 2) {
					return [
						{
							identityUser: '7',
							billingPayment: '0',
							billingSubscription: '0',
							widget: '9',
							lead: '0',
							reportingSettings: '0'
						}
					];
				}
				if (queryIndex === 3) {
					return [
						{
							cursorId: 'user-1',
							aggregateId: 'user-1',
							aggregateVersion: '2',
							sourceSequence: '7',
							state: {
								id: 'user-1',
								status: 'ACTIVE',
								deletedAt: null,
								roles: ['USER'],
								hasEmailIdentity: true,
								hasPhoneIdentity: false,
								hasTelegramIdentity: false,
								loginMethodCount: 1,
								createdAt: DATE,
								updatedAt: DATE
							}
						}
					];
				}
				if (queryIndex === 6) {
					return [
						{
							cursorId: 'widget-1',
							aggregateId: 'wheel:widget-1',
							aggregateVersion: '1',
							sourceSequence: '9',
							state: {
								id: 'widget-1',
								userId: 'user-1',
								widgetType: 'wheel',
								isActive: true,
								hasInstallDomain: false,
								createdAt: DATE
							}
						}
					];
				}
				return [];
			})
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const chunks: string[] = [];
		const response = {
			write: jest.fn((value: string) => {
				chunks.push(value);
				return true;
			}),
			destroyed: false,
			writableEnded: false
		} as unknown as Response;
		const request = { aborted: false } as Request;

		await new ReportingProjectionSnapshotService(prisma).stream(
			request,
			response
		);

		const lines = chunks.map(line => JSON.parse(line));
		expect(Object.keys(lines[0]).sort()).toEqual(
			['schemaVersion', 'kind', 'snapshotId', 'watermarks'].sort()
		);
		expect(lines[0]).toMatchObject({
			schemaVersion: 1,
			kind: 'header',
			watermarks: { identityUser: '7', widget: '9' }
		});
		expect(lines[1]).toMatchObject({
			schemaVersion: 1,
			kind: 'record',
			stream: 'identityUser',
			event: { aggregateId: 'user-1', aggregateVersion: '2' }
		});
		expect(lines[2]).toMatchObject({
			kind: 'record',
			stream: 'widget',
			event: {
				aggregateId: 'wheel:widget-1',
				state: { id: 'widget-1', widgetType: 'wheel' }
			}
		});
		const protectedSnapshotBytes = `${chunks[0]}${chunks[1]}${chunks[2]}`;
		expect(lines[3]).toMatchObject({
			schemaVersion: 1,
			kind: 'footer',
			snapshotId: lines[0].snapshotId,
			recordCount: 2,
			sha256: createHash('sha256')
				.update(protectedSnapshotBytes)
				.digest('hex')
		});
		expect(
			transaction.$queryRaw.mock.calls[0][0].strings.join(' ')
		).toContain('FOR SHARE');
	});

	it('fails closed before writing when producers are disabled', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			$queryRaw: jest
				.fn()
				.mockResolvedValue([{ enabled: false, activatedAt: null }])
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const response = {
			write: jest.fn().mockReturnValue(true),
			destroyed: false,
			writableEnded: false
		} as unknown as Response;
		const request = { aborted: false } as Request;

		await expect(
			new ReportingProjectionSnapshotService(prisma).stream(
				request,
				response
			)
		).rejects.toThrow(
			'Reporting projection snapshot requires enabled producers'
		);
		expect(response.write).not.toHaveBeenCalled();
		expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
	});
});
