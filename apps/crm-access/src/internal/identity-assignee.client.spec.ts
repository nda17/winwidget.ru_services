import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { IdentityInvitationClient } from './identity-invitation.client';

const workspaceId = randomUUID();
const membershipId = randomUUID();
const member = { membershipId, subject: 'member' };
const entry = {
	...member,
	workspaceRole: 'MEMBER',
	displayName: 'Имя',
	verifiedEmail: null
};
const config = new ConfigService({
	IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
	IDENTITY_CRM_ACCESS_TOKEN: 't'.repeat(48)
});
describe('Identity assignee directory reader', () => {
	const original = global.fetch;
	const fetchMock = jest.fn();
	beforeEach(() => {
		global.fetch = fetchMock;
		fetchMock.mockReset();
	});
	afterAll(() => {
		global.fetch = original;
	});
	const response = (items: unknown[], patch = {}) =>
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ schemaVersion: 1, workspaceId, items, ...patch }),
				{ status: 200 }
			)
		);
	it('accepts an active subset and sends only exact requested IDs with no redirects/cache', async () => {
		response([entry]);
		expect(
			await new IdentityInvitationClient(config).assignees(
				workspaceId,
				[member, { membershipId: randomUUID(), subject: 'revoked' }],
				false
			)
		).toEqual([entry]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			`http://127.0.0.1:4900/internal/v1/crm-access/workspaces/${workspaceId}/assignee-directory`
		);
		expect(init).toMatchObject({
			method: 'POST',
			redirect: 'error',
			cache: 'no-store'
		});
		expect(JSON.parse(init.body)).toMatchObject({
			schemaVersion: 1,
			includeOwner: false,
			membershipIds: expect.arrayContaining([membershipId])
		});
	});
	it('includes only an explicitly requested current owner outside the ID batch', async () => {
		const owner = {
			...entry,
			membershipId: randomUUID(),
			subject: 'owner',
			workspaceRole: 'OWNER'
		};
		response([owner]);
		expect(
			await new IdentityInvitationClient(config).assignees(
				workspaceId,
				[],
				true
			)
		).toEqual([owner]);
		response([owner]);
		await expect(
			new IdentityInvitationClient(config).assignees(
				workspaceId,
				[member],
				false
			)
		).rejects.toMatchObject({ status: 503 });
	});
	it.each(
		[
			[{ ...entry, subject: 'different' }],
			[{ ...entry, membershipId: randomUUID() }],
			[{ ...entry, extra: 'private' }],
			[{ ...entry, workspaceRole: 'ADMIN' }],
			[{ ...entry, verifiedEmail: 'Unnormalized@EXAMPLE.test' }],
			[{ ...entry, verifiedEmail: 'invalid' }],
			[entry, entry]
		].map(items => ({ items }))
	)(
		'rejects malformed or unbound returned identities %j',
		async ({ items }) => {
			response(items);
			await expect(
				new IdentityInvitationClient(config).assignees(
					workspaceId,
					[member],
					true
				)
			).rejects.toMatchObject({ status: 503 });
		}
	);
	it('rejects cross-workspace data and transport failure rather than returning empty', async () => {
		for (const patch of [
			{ workspaceId: randomUUID() },
			{ schemaVersion: 2 },
			{ extra: true }
		]) {
			response([], patch);
			await expect(
				new IdentityInvitationClient(config).assignees(
					workspaceId,
					[member],
					false
				)
			).rejects.toMatchObject({ status: 503 });
		}
		fetchMock.mockRejectedValueOnce(new Error('network'));
		await expect(
			new IdentityInvitationClient(config).assignees(
				workspaceId,
				[member],
				false
			)
		).rejects.toMatchObject({ status: 503 });
	});
	it('does not request an empty non-owner batch and rejects duplicate/oversize input', async () => {
		const client = new IdentityInvitationClient(config);
		expect(await client.assignees(workspaceId, [], false)).toEqual([]);
		await expect(
			client.assignees(workspaceId, [member, member], false)
		).rejects.toMatchObject({ status: 503 });
		await expect(
			client.assignees(
				workspaceId,
				Array.from({ length: 1001 }, () => ({
					membershipId: randomUUID(),
					subject: 'member'
				})),
				false
			)
		).rejects.toMatchObject({ status: 503 });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
