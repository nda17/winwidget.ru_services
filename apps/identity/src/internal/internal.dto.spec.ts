import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
	AuditSnapshotsDto,
	CampaignContactsDto
} from './internal.controller';

describe('Identity internal DTO contracts', () => {
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
