import {
	CAMPAIGNS_PROCESS_ROLES,
	parseCampaignsProcessRole
} from './campaigns-runtime.service';

describe('parseCampaignsProcessRole', () => {
	it('defaults to all', () => {
		expect(parseCampaignsProcessRole(undefined)).toBe('all');
	});

	it.each(CAMPAIGNS_PROCESS_ROLES)('accepts %s', role => {
		expect(parseCampaignsProcessRole(role)).toBe(role);
	});

	it('rejects unsupported roles', () => {
		expect(() => parseCampaignsProcessRole('api,worker')).toThrow(
			'CAMPAIGNS_PROCESS_ROLE'
		);
	});
});
