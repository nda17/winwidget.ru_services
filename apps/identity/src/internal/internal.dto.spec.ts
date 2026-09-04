import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
	AuditSnapshotsDto,
	CampaignContactsDto,
	CrmSourceContextDto
} from './internal.controller';

describe('Identity internal DTO contracts', () => {
	it('bounds source authority to an exact workspace and canonical subject', async () => {
		const dto = {
			schemaVersion: 1,
			workspaceId: '33333333-3333-4333-8333-333333333333',
			subject: 'user-1'
		};
		expect(
			await validate(plainToInstance(CrmSourceContextDto, dto))
		).toHaveLength(0);
		for (const change of [
			{ schemaVersion: 2 },
			{ subject: ' user-1' },
			{ subject: 'x'.repeat(257) },
			{ workspaceId: 'other' },
			{ userEmail: 'private@example.test' }
		]) {
			expect(
				await validate(
					plainToInstance(CrmSourceContextDto, { ...dto, ...change }),
					{ whitelist: true, forbidNonWhitelisted: true }
				)
			).not.toHaveLength(0);
		}
	});
	it('requires one to one hundred stable audit snapshot user IDs', async () => {
		await expect(
			validate(plainToInstance(AuditSnapshotsDto, { userIds: [] }))
		).resolves.not.toHaveLength(0);
		await expect(
			validate(
				plainToInstance(AuditSnapshotsDto, {
					userIds: Array.from(
						{ length: 101 },
						(_, index) => `user-${index}`
					)
				})
			)
		).resolves.not.toHaveLength(0);
		await expect(
			validate(plainToInstance(AuditSnapshotsDto, { userIds: ['user-1'] }))
		).resolves.toHaveLength(0);
	});

	it('accepts only the frozen campaign snapshot criteria', async () => {
		await expect(
			validate(
				plainToInstance(CampaignContactsDto, {
					schemaVersion: 1,
					channel: 'EMAIL'
				})
			)
		).resolves.toHaveLength(0);
		await expect(
			validate(
				plainToInstance(CampaignContactsDto, {
					schemaVersion: 1,
					channel: 'BILLING'
				})
			)
		).resolves.not.toHaveLength(0);
	});
});
