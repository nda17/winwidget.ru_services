import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
	TaskSeriesService
} = require('../../dist/src/recurring-tasks/task-series.service.js');
const {
	TaskSeriesGenerationService
} = require('../../dist/src/recurring-tasks/task-series-generation.service.js');

// Prisma exposes a trigger exception on model updates as UnknownRequestError,
// whereas raw SQL carries SQLSTATE in meta.code. Require the exact guard too.
const isSeriesIdentityViolation = error =>
	(error?.meta?.code === 'P0001' ||
		(error?.name === 'PrismaClientUnknownRequestError' &&
			/code: "P0001"/.test(error.message))) &&
	String(error.message).includes(
		'Task series identity, calendar and consumed periods are immutable'
	);

/** Called only by the existing explicitly opted-in, localhost PostgreSQL 18
 * workflow harness. Reuses its restricted owner-scoped runtime role. */
export async function taskSeriesPostgresCases(prisma) {
	const workspaceId = randomUUID();
	const access = {
		schemaVersion: 1,
		workspaceId,
		subject: 'series-owner',
		role: 'OWNER',
		state: 'ACTIVE',
		dataScope: 'ALL',
		teamIds: [],
		permissions: ['sales:read', 'sales:write']
	};
	let allowed = true;
	const authority = {
		authorize: async () =>
			allowed
				? { allowed: true, reason: null }
				: { allowed: false, reason: 'READ_ONLY' }
	};
	const service = new TaskSeriesService(
		prisma,
		{ authorize: async () => access },
		{
			verify: async () => ({ subject: access.subject, membershipId: null })
		},
		authority
	);
	const generation = new TaskSeriesGenerationService(prisma, authority);
	const dto = {
		schemaVersion: 1,
		workspaceId,
		commandId: randomUUID(),
		actorMembershipId: null,
		frequency: 'DAILY',
		startDate: '2026-09-01',
		content: {
			title: 'Ежедневный отчёт',
			localTime: '10:00',
			timeZone: 'Europe/Moscow',
			assignee: { subject: access.subject, membershipId: null }
		}
	};
	const created = await service.create(access, dto, 'Bearer integration');
	assert.deepEqual(
		await service.create(access, dto, 'Bearer integration'),
		created
	);
	assert.equal(
		await prisma.taskSeries.count({ where: { workspaceId } }),
		1
	);
	assert.equal(
		await prisma.salesTask.count({ where: { workspaceId } }),
		0
	);
	const read = () =>
		prisma.taskSeries.findUniqueOrThrow({
			where: { id: created.series.id },
			include: { deal: true }
		});
	const stale = await read();
	const lease = { jobId: randomUUID(), token: randomUUID() };
	await prisma.reminderJob.create({
		data: {
			id: lease.jobId,
			periodKey: `test-series:${lease.jobId}`,
			status: 'PROCESSING',
			leaseToken: lease.token,
			leaseExpiresAt: new Date(Date.now() + 60000)
		}
	});
	const now = new Date('2026-09-08T12:00:00Z');
	allowed = false;
	await generation.generate(stale, lease, () => true, now);
	assert.equal((await read()).nextIndex, 0);
	assert.equal(
		await prisma.salesTask.count({ where: { workspaceId } }),
		0
	);
	allowed = true;
	const attempts = await Promise.allSettled([
		generation.generate(stale, lease, () => true, now),
		generation.generate(stale, lease, () => true, now)
	]);
	assert.ok(attempts.some(result => result.status === 'fulfilled'));
	for (const result of attempts)
		if (result.status === 'rejected')
			assert.equal(result.reason?.code, 'P2034');
	await generation.generate(stale, lease, () => true, now);
	assert.equal(
		await prisma.salesTask.count({ where: { workspaceId } }),
		1
	);
	assert.equal(
		await prisma.taskSeriesOccurrence.count({ where: { workspaceId } }),
		1
	);
	assert.equal((await read()).nextIndex, 8);
	await assert.rejects(
		prisma.taskSeries.update({
			where: { id: created.series.id },
			data: { nextIndex: 0 }
		}),
		isSeriesIdentityViolation
	);
	await assert.rejects(
		prisma.taskSeries.update({
			where: { id: created.series.id },
			data: { frequency: 'WEEKLY' }
		}),
		isSeriesIdentityViolation
	);
	assert.equal((await read()).nextIndex, 8);
	assert.equal((await read()).frequency, 'DAILY');
	const occurrence = await prisma.taskSeriesOccurrence.findFirstOrThrow({
		where: { workspaceId }
	});
	assert.equal(occurrence.periodIndex, 7);
	const taskBefore = await prisma.salesTask.findUniqueOrThrow({
		where: { id: occurrence.taskId }
	});
	assert.equal(taskBefore.dueAt.toISOString(), '2026-09-08T07:00:00.000Z');
	const periodicJob = await prisma.reminderJob.findUniqueOrThrow({
		where: { periodKey: `task-series-task:${created.series.id}:7` }
	});
	assert.equal(
		await prisma.reminderOutbox.count({
			where: { payload: { path: ['jobId'], equals: periodicJob.id } }
		}),
		1
	);
	const edited = await service.edit(
		access,
		created.series.id,
		{
			schemaVersion: 1,
			workspaceId,
			commandId: randomUUID(),
			actorMembershipId: null,
			expectedVersion: 1,
			content: {
				...dto.content,
				title: 'Изменён только будущий отчёт',
				localTime: '12:00'
			}
		},
		'Bearer integration'
	);
	assert.equal(edited.series.version, 2);
	assert.equal((await read()).nextIndex, 8);
	assert.deepEqual(
		await prisma.salesTask.findUniqueOrThrow({
			where: { id: occurrence.taskId }
		}),
		taskBefore
	);
	await generation.generate(await read(), lease, () => true, now);
	assert.equal(
		await prisma.salesTask.count({ where: { workspaceId } }),
		1
	);
	const duplicateTask = await prisma.salesTask.create({
		data: {
			workspaceId,
			title: 'Проверка уникальности',
			dueAt: now,
			assignedToSubject: access.subject
		}
	});
	await assert.rejects(
		prisma.taskSeriesOccurrence.create({
			data: {
				id: randomUUID(),
				workspaceId,
				seriesId: created.series.id,
				periodIndex: 7,
				seriesVersion: 2,
				taskId: duplicateTask.id,
				dueAt: now
			}
		}),
		error => error?.code === 'P2002'
	);
	await assert.rejects(
		prisma.taskSeriesOccurrence.create({
			data: {
				id: randomUUID(),
				workspaceId: randomUUID(),
				seriesId: created.series.id,
				periodIndex: 8,
				seriesVersion: 2,
				taskId: duplicateTask.id,
				dueAt: now
			}
		}),
		error => error?.code === 'P2003'
	);
	for (const table of [
		'task_series_commands',
		'task_series_occurrences'
	]) {
		await assert.rejects(
			prisma.$executeRawUnsafe(
				`DELETE FROM crm_sales.${table} WHERE FALSE`
			),
			error => error?.meta?.code === '42501'
		);
		await assert.rejects(
			prisma.$executeRawUnsafe(
				`UPDATE crm_sales.${table} SET workspace_id = workspace_id WHERE FALSE`
			),
			error => error?.meta?.code === '42501'
		);
	}
	await service.status(
		access,
		created.series.id,
		{
			schemaVersion: 1,
			workspaceId,
			commandId: randomUUID(),
			actorMembershipId: null,
			expectedVersion: 2,
			status: 'CANCELLED'
		},
		'Bearer integration'
	);
	await generation.generate(
		await read(),
		lease,
		() => true,
		new Date('2026-09-09T12:00:00Z')
	);
	assert.equal(
		await prisma.taskSeriesOccurrence.count({ where: { workspaceId } }),
		1
	);
}
