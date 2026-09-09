import { ConfigService } from '@nestjs/config';
import {
	SupportWorkspaceContextController,
	SupportWorkspaceContextGuard
} from './support-workspace-context.controller';

const workspaceId = '11111111-1111-4111-8111-111111111111';
function setup(role = 'MEMBER') {
	const identity = {
		authContext: jest.fn().mockResolvedValue({
			subject: 'client',
			memberships: [{ workspaceId, membershipId: 'binding', role }]
		})
	};
	const database = {
		crmWorkspaceAccess: {
			findUnique: jest.fn().mockResolvedValue({ lifecycle: 'READ_ONLY' })
		},
		crmWorkspaceMember: {
			findUnique: jest
				.fn()
				.mockResolvedValue({ membershipId: 'binding', disabledAt: null })
		},
		crmWorkspaceBranding: {
			findUnique: jest.fn().mockResolvedValue({ displayName: 'Company' })
		}
	};
	const prisma = { $transaction: jest.fn(fn => fn(database)) };
	return {
		controller: new SupportWorkspaceContextController(
			identity as any,
			prisma as any
		),
		identity,
		database
	};
}

describe('Support company context', () => {
	it('permits READ_ONLY company context without a Billing dependency', async () => {
		const current = setup();
		await expect(
			current.controller.context('Bearer session', {
				schemaVersion: 1,
				workspaceId
			})
		).resolves.toEqual({
			schemaVersion: 1,
			subject: 'client',
			workspaceId,
			companyName: 'Company'
		});
	});
	it('rejects foreign, disabled and replaced membership bindings', async () => {
		const current = setup();
		current.identity.authContext.mockResolvedValueOnce({
			subject: 'client',
			memberships: []
		});
		await expect(
			current.controller.context('Bearer session', {
				schemaVersion: 1,
				workspaceId
			})
		).rejects.toThrow('Workspace is not available');
		current.database.crmWorkspaceMember.findUnique.mockResolvedValueOnce({
			membershipId: 'old-binding',
			disabledAt: null
		});
		await expect(
			current.controller.context('Bearer session', {
				schemaVersion: 1,
				workspaceId
			})
		).rejects.toThrow('Workspace is not available');
		current.database.crmWorkspaceMember.findUnique.mockResolvedValueOnce({
			membershipId: 'binding',
			disabledAt: new Date()
		});
		await expect(
			current.controller.context('Bearer session', {
				schemaVersion: 1,
				workspaceId
			})
		).rejects.toThrow('Workspace is not available');
	});
	it('does not grant the context to a public caller or an unconfigured service', () => {
		const token = '6'.repeat(64);
		const request = (
			address: string,
			caller = 'support',
			supplied = token
		) =>
			({
				switchToHttp: () => ({
					getRequest: () => ({
						socket: { remoteAddress: address },
						header: (name: string) =>
							name === 'x-winwidget-service' ? caller : supplied
					})
				})
			}) as any;
		const guard = new SupportWorkspaceContextGuard(
			new ConfigService({ CRM_ACCESS_SUPPORT_TOKEN: token })
		);
		expect(guard.canActivate(request('127.0.0.1'))).toBe(true);
		for (const context of [
			request('203.0.113.1'),
			request('127.0.0.1', 'crm-sales'),
			request('127.0.0.1', 'support', 'invalid')
		]) {
			expect(() => guard.canActivate(context)).toThrow(
				'Invalid internal credentials'
			);
		}
		expect(() =>
			new SupportWorkspaceContextGuard(new ConfigService()).canActivate(
				request('127.0.0.1')
			)
		).toThrow('Invalid internal credentials');
	});
});
