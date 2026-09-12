import { compare, hash } from 'bcryptjs';
import { EmailPasswordRecoveryService } from './email-password-recovery.service';

jest.mock('../common/identity.util', () => ({
	...jest.requireActual('../common/identity.util'),
	PASSWORD_SALT_ROUNDS: 4
}));

async function harness() {
	const user = {
		id: 'user',
		password: await hash('OldPass1', 4),
		status: 'ACTIVE',
		deletedAt: null,
		authIdentities: [
			{
				id: 'identity',
				type: 'EMAIL',
				value: 'recipient@example.test',
				verifiedAt: new Date('2026-09-01')
			}
		]
	};
	const rows: any[] = [];
	const select = (where: any) =>
		rows.filter(row =>
			Object.entries(where).every(([key, value]: [string, any]) => {
				if (value && typeof value === 'object')
					return value.not
						? row[key] !== value.not
						: value.gt
							? row[key] > value.gt
							: false;
				return row[key] === value;
			})
		);
	const prisma: any = {
		$queryRaw: jest.fn(async () => []),
		user: {
			findUnique: jest.fn(async () => structuredClone(user)),
			updateMany: jest.fn(async ({ where, data }: any) => {
				if (where.password !== user.password) return { count: 0 };
				Object.assign(user, data);
				return { count: 1 };
			})
		},
		userSession: { updateMany: jest.fn(async () => ({ count: 1 })) },
		emailPasswordRecovery: {
			findMany: jest.fn(async ({ where }: any) =>
				structuredClone(
					select(where).sort((a, b) => b.createdAt - a.createdAt)
				)
			),
			create: jest.fn(async ({ data }: any) => {
				rows.push({ consumedAt: null, ...data });
			}),
			updateMany: jest.fn(async ({ where, data }: any) => {
				const found = select(where);
				found.forEach(row => Object.assign(row, data));
				return { count: found.length };
			})
		}
	};
	prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));
	const transport = { newPassword: jest.fn(async () => undefined) };
	return {
		user,
		rows,
		prisma,
		transport,
		service: new EmailPasswordRecoveryService(prisma, transport as any)
	};
}

describe('pending email password recovery', () => {
	it('keeps the original password and sessions after a definite SMTP failure', async () => {
		const h = await harness();
		h.transport.newPassword.mockRejectedValueOnce(
			Object.assign(new Error('synthetic'), { outcome: 'FAILED' })
		);
		await expect(
			h.service.issue(
				h.user.id,
				h.user.authIdentities[0].value,
				'TempPass1'
			)
		).rejects.toMatchObject({
			response: { code: 'email_delivery_failed' }
		});
		expect(await compare('OldPass1', h.user.password)).toBe(true);
		expect(h.prisma.userSession.updateMany).not.toHaveBeenCalled();
		expect(await h.service.match(h.user as any, 'TempPass1')).toBeNull();
	});

	it('accepts a possibly delivered temporary password and changes credentials only when it is used', async () => {
		const h = await harness();
		h.transport.newPassword.mockRejectedValueOnce(
			new Error('SMTP disconnect after DATA')
		);
		await expect(
			h.service.issue(
				h.user.id,
				h.user.authIdentities[0].value,
				'TempPass1'
			)
		).rejects.toMatchObject({
			response: { code: 'email_delivery_unknown' }
		});
		expect(await compare('OldPass1', h.user.password)).toBe(true);
		expect(h.prisma.userSession.updateMany).not.toHaveBeenCalled();
		const recovery = await h.service.match(h.user as any, 'TempPass1');
		expect(recovery).not.toBeNull();
		await h.service.activate(h.prisma, h.user as any, recovery!);
		expect(await compare('TempPass1', h.user.password)).toBe(true);
		expect(await compare('OldPass1', h.user.password)).toBe(false);
		expect(h.prisma.userSession.updateMany).toHaveBeenCalledTimes(1);
		expect(h.rows[0].consumedAt).toBeInstanceOf(Date);
	});

	it('invalidates pending recovery after a password or verified email identity change', async () => {
		const h = await harness();
		await h.service.issue(
			h.user.id,
			h.user.authIdentities[0].value,
			'TempPass1'
		);
		expect(h.prisma.user.updateMany).not.toHaveBeenCalled();
		const prior = h.user.password;
		h.user.password = await hash('ChangedPass1', 4);
		expect(await h.service.match(h.user as any, 'TempPass1')).toBeNull();
		h.user.password = prior;
		h.user.authIdentities[0].value = 'replacement@example.test';
		expect(await h.service.match(h.user as any, 'TempPass1')).toBeNull();
	});

	it('rejects expired temporary passwords while retaining the original password', async () => {
		const h = await harness();
		await h.service.issue(
			h.user.id,
			h.user.authIdentities[0].value,
			'TempPass1'
		);
		h.rows[0].expiresAt = new Date(0);
		expect(await h.service.match(h.user as any, 'TempPass1')).toBeNull();
		expect(await compare('OldPass1', h.user.password)).toBe(true);
	});
});
