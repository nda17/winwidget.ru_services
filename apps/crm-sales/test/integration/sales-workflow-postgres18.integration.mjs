import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/crm-sales-client');
const { SalesService } = require('../../dist/src/sales/sales.service.js');
const {
	WorkdayService
} = require('../../dist/src/workday/workday.service.js');
const { WorkdayQuery } = require('../../dist/src/workday/workday.dto.js');
const {
	PipelineTemplateCatalogService
} = require('../../dist/src/templates/pipeline-template-catalog.service.js');
const {
	PipelineTemplateInstallationService
} = require('../../dist/src/pipelines/pipeline-template-installation.service.js');

assert.equal(process.env.CRM_SALES_INTEGRATION_ALLOW_MUTATION, 'true');
const databaseUrl = requiredEnv('CRM_SALES_TEST_DATABASE_URL');
const roleName = requiredEnv('CRM_SALES_TEST_RUNTIME_ROLE');
const url = new URL(databaseUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.match(url.pathname, /^\/winwidget_crm_sales_test(?:_[a-z0-9]+)*$/);
assert.equal(decodeURIComponent(url.username), roleName);
assert.equal(url.searchParams.get('schema'), 'crm_sales');

const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const catalog = new PipelineTemplateCatalogService();
const installer = new PipelineTemplateInstallationService(prisma, catalog);
let allowContact = true;
const service = new SalesService(prisma, {
	requireContact: async (_authorization, workspaceId, id) => {
		if (!allowContact) {
			const error = new Error('contact not visible');
			error.status = 404;
			throw error;
		}
		assert.equal(workspaceId, access.workspaceId);
		return { id, name: 'Integration contact' };
	}
});
const access = {
	schemaVersion: 1,
	workspaceId: randomUUID(),
	subject: 'workflow-owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read', 'sales:write', 'sales:analytics']
};
const contactId = randomUUID();
const nextTask = {
	title: 'Первый звонок',
	dueAt: new Date(Date.now() + 86400000).toISOString()
};

try {
	const [role] = await prisma.$queryRaw`
		SELECT current_user AS name, current_setting('server_version_num')::integer AS version,
			NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolcanlogin AS restricted,
			pg_get_userbyid(nspowner) <> current_user AS not_owner,
			NOT has_database_privilege(current_user, current_database(), 'CREATE') AS database_create_denied,
			NOT has_schema_privilege(current_user, 'foreign_service_guard', 'USAGE') AS foreign_schema_denied
		FROM pg_roles JOIN pg_namespace ON nspname = 'crm_sales' WHERE rolname = current_user
	`;
	assert.equal(role.name, roleName);
	assert.equal(role.restricted, true);
	assert.equal(role.not_owner, true);
	assert.equal(role.database_create_denied, true);
	assert.equal(role.foreign_schema_denied, true);
	assert.ok(role.version >= 180000 && role.version < 190000);
	await assert.rejects(
		prisma.$queryRawUnsafe(
			'SELECT id FROM foreign_service_guard.sentinel LIMIT 1'
		),
		error => error?.meta?.code === '42501'
	);

	const installed = await installer.install({
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		templateKey: 'universal-sales',
		templateVersion: 1,
		installedBySubject: access.subject
	});
	const pipeline = await prisma.pipeline.findUniqueOrThrow({
		where: { id: installed.installation.pipelineId },
		include: { stages: true }
	});
	const openStage = pipeline.stages.find(stage => stage.state === 'OPEN');
	const wonStage = pipeline.stages.find(stage => stage.state === 'WON');
	assert.ok(openStage);
	assert.ok(wonStage);
	const foreignWorkspace = randomUUID();
	const other = await installer.install({
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: foreignWorkspace,
		templateKey: 'universal-sales',
		templateVersion: 1,
		installedBySubject: 'foreign-owner'
	});
	const foreignStage = await prisma.pipelineStage.findFirstOrThrow({
		where: { pipelineId: other.installation.pipelineId, state: 'OPEN' }
	});
	const command = {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		title: 'Проверка workflow',
		currency: 'RUB',
		amountMinor: 120000,
		pipelineId: pipeline.id,
		stageId: openStage.id,
		contactId,
		nextTask
	};

	allowContact = false;
	await assert.rejects(
		service.create(access, command, 'Bearer test'),
		error => error.status === 404
	);
	assert.equal(
		await prisma.deal.count({
			where: { workspaceId: access.workspaceId }
		}),
		0
	);
	allowContact = true;
	const missingTaskPrisma = {
		$transaction: (callback, options) =>
			prisma.$transaction(
				transaction =>
					callback(
						new Proxy(transaction, {
							get(target, property) {
								if (property === 'salesTask')
									return { ...target.salesTask, create: async () => ({}) };
								const value = Reflect.get(target, property);
								return typeof value === 'function'
									? value.bind(target)
									: value;
							}
						})
					),
				options
			)
	};
	const unsavedCommandId = randomUUID();
	await assert.rejects(
		new SalesService(missingTaskPrisma, {
			requireContact: async () => ({
				id: contactId,
				name: 'Injected contact'
			})
		}).create(
			access,
			{ ...command, commandId: unsavedCommandId },
			'Bearer test'
		),
		error => error?.meta?.code === '23503'
	);
	assert.equal(
		await prisma.deal.count({
			where: { workspaceId: access.workspaceId }
		}),
		0,
		'A failed deferred invariant must not acknowledge or persist a deal'
	);
	assert.equal(
		await prisma.salesCommandReceipt.count({
			where: { commandId: unsavedCommandId }
		}),
		0
	);
	await assert.rejects(
		service.create(
			access,
			{ ...command, stageId: foreignStage.id },
			'Bearer test'
		),
		error => error.status === 404
	);
	const results = await Promise.all([
		service.create(access, command, 'Bearer test'),
		service.create(access, command, 'Bearer test')
	]);
	assert.deepEqual(results[0], results[1]);
	let current = results[0].deal;
	assert.equal(current.version, 1);
	assert.equal(current.nextTask.status, 'OPEN');
	assert.equal(
		await prisma.deal.count({
			where: { workspaceId: access.workspaceId }
		}),
		1
	);
	assert.equal(
		await prisma.salesTask.count({
			where: { workspaceId: access.workspaceId, status: 'OPEN' }
		}),
		1
	);
	assert.equal(
		await prisma.dealTimeline.count({ where: { dealId: current.id } }),
		1
	);
	await assert.rejects(
		service.create(
			access,
			{ ...command, title: 'Changed' },
			'Bearer test'
		),
		error => error.status === 409
	);
	await assert.rejects(
		service.detail(
			{ ...access, workspaceId: foreignWorkspace },
			current.id
		),
		error => error.status === 404
	);
	await assert.rejects(
		service.detail(
			{
				...access,
				subject: 'other-manager',
				dataScope: 'OWN',
				role: 'MANAGER'
			},
			current.id
		),
		error => error.status === 404
	);
	await assert.rejects(
		service.detail({ ...access, role: 'ANALYST' }, current.id),
		error => error.status === 403
	);
	await assert.rejects(
		service.create(
			{ ...access, state: 'READ_ONLY' },
			command,
			'Bearer test'
		),
		error => error.status === 403
	);
	assert.equal(
		(await service.analytics({ ...access, role: 'ANALYST' })).items.find(
			item => item.status === 'OPEN'
		).count,
		1
	);
	assert.equal(
		(
			await service.deals(access, {
				page: 1,
				pageSize: 1,
				workspaceId: access.workspaceId,
				search: 'workflow'
			})
		).total,
		1
	);
	assert.equal(
		(
			await service.tasks(access, {
				page: 1,
				pageSize: 20,
				workspaceId: access.workspaceId
			})
		).total,
		1
	);

	await assert.rejects(
		prisma.$transaction(async transaction => {
			await transaction.salesTask.updateMany({
				where: { id: current.nextTask.id },
				data: { status: 'COMPLETED', completedAt: new Date() }
			});
			await transaction.$executeRaw`SET CONSTRAINTS crm_sales.deals_next_task_fkey, crm_sales.deals_next_action_integrity, crm_sales.tasks_next_action_integrity IMMEDIATE`;
		}),
		error =>
			error?.meta?.code === 'P0001' &&
			String(error?.meta?.message).includes(
				'Deal next action must match its active tasks'
			)
	);
	assert.equal(
		(await service.detail(access, current.id)).deal.nextTask.status,
		'OPEN'
	);
	await assert.rejects(
		prisma.$executeRaw`UPDATE crm_sales.deals SET stage_id = ${foreignStage.id}::uuid WHERE id = ${current.id}::uuid`,
		error => error?.meta?.code === '23503'
	);

	const completeCommand = {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		expectedVersion: current.nextTask.version,
		outcome: 'Обсудили предложение',
		nextTask: { ...nextTask, title: 'Подготовить предложение' }
	};
	const completed = await service.complete(
		access,
		current.nextTask.id,
		completeCommand
	);
	assert.equal(completed.deal.version, 2);
	assert.notEqual(completed.deal.nextTask.id, current.nextTask.id);
	assert.deepEqual(
		await service.complete(access, current.nextTask.id, completeCommand),
		completed
	);
	current = completed.deal;
	const transition = {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		expectedVersion: current.version,
		targetStageId: wonStage.id,
		outcome: 'Оплачено'
	};
	const competitors = await Promise.allSettled([
		service.transition(access, current.id, transition),
		service.transition(access, current.id, {
			...transition,
			commandId: randomUUID()
		})
	]);
	assert.equal(
		competitors.filter(item => item.status === 'fulfilled').length,
		1
	);
	assert.equal(
		competitors.find(item => item.status === 'rejected').reason.status,
		409
	);
	current = (await service.detail(access, current.id)).deal;
	assert.equal(current.status, 'WON');
	assert.equal(current.nextTask, null);
	assert.equal(current.version, 3);
	assert.equal(
		await prisma.salesTask.count({
			where: { dealId: current.id, status: 'OPEN' }
		}),
		0
	);

	const reopened = await service.transition(access, current.id, {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		expectedVersion: current.version,
		targetStageId: openStage.id,
		outcome: 'Повторное обращение',
		nextTask
	});
	assert.equal(reopened.deal.status, 'OPEN');
	assert.equal(reopened.deal.nextTask.status, 'OPEN');
	const archiveCommand = {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		expectedVersion: reopened.deal.version
	};
	const archived = await service.archive(
		access,
		current.id,
		archiveCommand
	);
	assert.ok(archived.deal.archivedAt);
	assert.equal(archived.deal.nextTask, null);
	assert.deepEqual(
		await service.archive(access, current.id, archiveCommand),
		archived
	);
	await assert.rejects(
		service.detail(access, current.id),
		error => error.status === 404
	);
	assert.equal(
		await prisma.dealTimeline.count({ where: { dealId: current.id } }),
		5
	);
	assert.equal(
		(
			await service.tasks(access, {
				workspaceId: access.workspaceId,
				page: 1,
				pageSize: 20
			})
		).total,
		0
	);

	// Expanded model: standalone tasks, multiple active actions and IN_PROGRESS
	// coexist with unchanged v1 commands and their immutable receipts.
	const standalone = await prisma.salesTask.create({
		data: {
			workspaceId: access.workspaceId,
			dealId: null,
			title: 'Подготовить отчёт',
			dueAt: new Date(nextTask.dueAt),
			assignedToSubject: access.subject
		}
	});
	assert.equal(standalone.status, 'OPEN');
	const workdayCommand = {
		...command,
		commandId: randomUUID(),
		title: 'Рабочий день'
	};
	let workday = (
		await service.create(access, workdayCommand, 'Bearer test')
	).deal;
	const originalReceipt =
		await prisma.salesCommandReceipt.findUniqueOrThrow({
			where: { commandId: workdayCommand.commandId }
		});
	let parallelTask = await prisma.$transaction(async tx => {
		const row = await tx.salesTask.create({
			data: {
				workspaceId: access.workspaceId,
				dealId: workday.id,
				title: 'Параллельная работа',
				dueAt: new Date(nextTask.dueAt),
				assignedToSubject: access.subject,
				status: 'OPEN'
			}
		});
		await tx.$executeRaw`SET CONSTRAINTS crm_sales.deals_next_task_fkey, crm_sales.deals_next_action_integrity, crm_sales.tasks_next_action_integrity IMMEDIATE`;
		return row;
	});
	assert.equal(
		await prisma.salesTask.count({
			where: { dealId: workday.id, status: 'OPEN' }
		}),
		2
	);
	parallelTask = await prisma.$transaction(async tx => {
		const row = await tx.salesTask.update({
			where: { id: parallelTask.id },
			data: { status: 'IN_PROGRESS' }
		});
		await tx.$executeRaw`SET CONSTRAINTS crm_sales.deals_next_action_integrity, crm_sales.tasks_next_action_integrity IMMEDIATE`;
		return row;
	});
	assert.equal(parallelTask.completedAt, null);
	await assert.rejects(
		service.complete(access, parallelTask.id, {
			schemaVersion: 1,
			commandId: randomUUID(),
			workspaceId: access.workspaceId,
			expectedVersion: parallelTask.version,
			outcome: 'Не выбранное действие',
			nextTask
		}),
		error => error.status === 409
	);
	await prisma.$transaction(async tx => {
		await tx.salesTask.update({
			where: { id: workday.nextTask.id },
			data: { status: 'IN_PROGRESS' }
		});
		await tx.$executeRaw`SET CONSTRAINTS crm_sales.deals_next_action_integrity, crm_sales.tasks_next_action_integrity IMMEDIATE`;
	});
	assert.equal(
		(await service.detail(access, workday.id)).deal.nextTask.status,
		'IN_PROGRESS'
	);
	workday = (
		await service.complete(access, workday.nextTask.id, {
			schemaVersion: 1,
			commandId: randomUUID(),
			workspaceId: access.workspaceId,
			expectedVersion: workday.nextTask.version,
			outcome: 'Первое действие выполнено',
			nextTask
		})
	).deal;
	assert.deepEqual(
		await prisma.salesTask.findUniqueOrThrow({
			where: { id: parallelTask.id }
		}),
		parallelTask
	);
	assert.deepEqual(
		await prisma.salesTask.findUniqueOrThrow({
			where: { id: standalone.id }
		}),
		standalone
	);
	workday = (
		await service.transition(access, workday.id, {
			schemaVersion: 1,
			commandId: randomUUID(),
			workspaceId: access.workspaceId,
			expectedVersion: workday.version,
			targetStageId: openStage.id,
			outcome: 'Следующий этап',
			nextTask
		})
	).deal;
	assert.deepEqual(
		await prisma.salesTask.findUniqueOrThrow({
			where: { id: parallelTask.id }
		}),
		parallelTask
	);
	workday = (
		await service.transition(access, workday.id, {
			schemaVersion: 1,
			commandId: randomUUID(),
			workspaceId: access.workspaceId,
			expectedVersion: workday.version,
			targetStageId: wonStage.id,
			outcome: 'Сделка завершена'
		})
	).deal;
	assert.equal(
		(
			await prisma.salesTask.findUniqueOrThrow({
				where: { id: parallelTask.id }
			})
		).status,
		'COMPLETED'
	);
	assert.deepEqual(
		await prisma.salesTask.findUniqueOrThrow({
			where: { id: standalone.id }
		}),
		standalone
	);
	assert.deepEqual(
		await prisma.salesCommandReceipt.findUniqueOrThrow({
			where: { commandId: workdayCommand.commandId }
		}),
		originalReceipt
	);
	assert.deepEqual(
		await service.create(access, workdayCommand, 'Bearer test'),
		originalReceipt.result
	);

	const flush = async tx => {
		await tx.$executeRaw`SET CONSTRAINTS crm_sales.deals_next_task_fkey, crm_sales.deals_next_action_integrity, crm_sales.tasks_next_action_integrity IMMEDIATE`;
	};
	for (const status of ['OPEN', 'IN_PROGRESS']) {
		await assert.rejects(
			prisma.$transaction(async tx => {
				await tx.salesTask.create({
					data: {
						workspaceId: access.workspaceId,
						dealId: workday.id,
						title: 'Недопустимая задача',
						dueAt: new Date(nextTask.dueAt),
						assignedToSubject: access.subject,
						status
					}
				});
				await flush(tx);
			}),
			error => error?.meta?.code === 'P0001'
		);
	}
	await assert.rejects(
		prisma.$transaction(async tx => {
			await tx.salesTask.update({
				where: { id: standalone.id },
				data: { dealId: workday.id }
			});
			await flush(tx);
		}),
		error => error?.meta?.code === 'P0001'
	);
	await assert.rejects(
		prisma.$transaction(async tx => {
			await tx.salesTask.update({
				where: { id: standalone.id },
				data: { workspaceId: foreignWorkspace, dealId: workday.id }
			});
			await flush(tx);
		}),
		error => error?.code === 'P2003' || error?.meta?.code === '23503'
	);
	for (const status of ['COMPLETED', 'CANCELLED']) {
		await assert.rejects(
			prisma.salesTask.update({
				where: { id: standalone.id },
				data: { status }
			}),
			error =>
				error?.meta?.code === '23514' ||
				String(error?.message).includes('tasks_completed_at_check')
		);
	}
	await assert.rejects(
		prisma.salesTask.update({
			where: { id: standalone.id },
			data: { status: 'IN_PROGRESS', completedAt: new Date() }
		}),
		error =>
			error?.meta?.code === '23514' ||
			String(error?.message).includes('tasks_completed_at_check')
	);

	// Completing the final action without a replacement is a valid future
	// workday command; the pointer must be cleared atomically, not left stale.
	const finalAction = (
		await service.create(
			access,
			{ ...command, commandId: randomUUID() },
			'Bearer test'
		)
	).deal;
	await prisma.$transaction(async tx => {
		await tx.salesTask.update({
			where: { id: finalAction.nextTask.id },
			data: {
				status: 'COMPLETED',
				completedAt: new Date(),
				version: { increment: 1 }
			}
		});
		await tx.deal.update({
			where: { id: finalAction.id },
			data: { nextTaskId: null, version: { increment: 1 } }
		});
		await flush(tx);
	});
	assert.equal(
		(await service.detail(access, finalAction.id)).deal.nextTask,
		null
	);
	await assert.rejects(
		prisma.$transaction(async tx => {
			await tx.salesTask.create({
				data: {
					workspaceId: access.workspaceId,
					dealId: finalAction.id,
					title: 'Без указателя',
					dueAt: new Date(nextTask.dueAt),
					assignedToSubject: access.subject
				}
			});
			await flush(tx);
		}),
		error => error?.meta?.code === 'P0001'
	);
	await assert.rejects(
		prisma.$transaction(async tx => {
			await tx.deal.update({
				where: { id: finalAction.id },
				data: { nextTaskId: standalone.id }
			});
			await flush(tx);
		}),
		error => ['23503', 'P0001'].includes(error?.meta?.code)
	);
	assert.deepEqual(
		await prisma.salesTask.findUniqueOrThrow({
			where: { id: standalone.id }
		}),
		standalone
	);
	await assert.rejects(
		service.complete(access, standalone.id, {
			schemaVersion: 1,
			commandId: randomUUID(),
			workspaceId: access.workspaceId,
			expectedVersion: 1,
			outcome: 'Нет сделки',
			nextTask
		}),
		error => error.status === 404
	);
	await prisma.salesTask.update({
		where: { id: standalone.id },
		data: { status: 'COMPLETED', completedAt: new Date() }
	});
	assert.equal(
		(
			await prisma.salesTask.findUniqueOrThrow({
				where: { id: standalone.id }
			})
		).status,
		'COMPLETED'
	);

	for (const table of ['deal_timeline', 'command_receipts']) {
		await assert.rejects(
			prisma.$executeRawUnsafe(
				`UPDATE crm_sales.${table} SET workspace_id = workspace_id WHERE FALSE`
			),
			error => error?.meta?.code === '42501'
		);
		await assert.rejects(
			prisma.$executeRawUnsafe(
				`DELETE FROM crm_sales.${table} WHERE FALSE`
			),
			error => error?.meta?.code === '42501'
		);
	}
	for (const table of ['deals', 'tasks']) {
		await assert.rejects(
			prisma.$executeRawUnsafe(
				`DELETE FROM crm_sales.${table} WHERE FALSE`
			),
			error => error?.meta?.code === '42501'
		);
		await assert.rejects(
			prisma.$executeRawUnsafe(`TRUNCATE TABLE crm_sales.${table}`),
			error => error?.meta?.code === '42501'
		);
	}
	// Real runtime-role SQL for the new commands, separate from legacy receipts.
	{
		let workdayActor = access;
		let allowAssignee = true;
		const ownerMembership = randomUUID(),
			managerMembership = randomUUID();
		const workday = new WorkdayService(
			prisma,
			{
				authorize: async () => workdayActor
			},
			{
				authorize: async (_token, actor, target) => {
					assert.equal(actor.workspaceId, access.workspaceId);
					if (!allowAssignee)
						throw Object.assign(new Error('revoked'), { status: 404 });
					const owner = target.subject === access.subject;
					assert.equal(
						target.membershipId,
						owner ? ownerMembership : managerMembership
					);
					return {
						...target,
						role: owner ? 'OWNER' : 'MANAGER',
						dataScope: owner ? 'ALL' : 'OWN',
						teamIds: []
					};
				}
			}
		);
		const workdayPrefix = `workday-${randomUUID()}`;
		const taskCommand = {
			schemaVersion: 1,
			workspaceId: access.workspaceId,
			commandId: randomUUID(),
			title: workdayPrefix,
			dueAt: '2026-09-07T10:00:00.000Z',
			assignee: { subject: access.subject, membershipId: ownerMembership }
		};
		const dealCountBefore = await prisma.deal.count({
			where: { workspaceId: access.workspaceId }
		});
		const [standalone, duplicate] = await Promise.all([
			workday.create(access, taskCommand, 'Bearer fixture'),
			workday.create(access, taskCommand, 'Bearer fixture')
		]);
		assert.deepEqual(duplicate, standalone);
		assert.equal(standalone.task.dealId, null);
		assert.equal(standalone.task.assignedToMembershipId, ownerMembership);
		assert.equal(
			await prisma.deal.count({
				where: { workspaceId: access.workspaceId }
			}),
			dealCountBefore
		);
		assert.equal(
			await prisma.taskTimeline.count({
				where: { taskId: standalone.task.id }
			}),
			1
		);
		await assert.rejects(
			workday.create(
				access,
				{ ...taskCommand, title: 'conflicting replay' },
				'Bearer fixture'
			),
			error => error.status === 409
		);
		const statusCommand = {
			schemaVersion: 1,
			workspaceId: access.workspaceId,
			commandId: randomUUID(),
			expectedVersion: 1,
			status: 'IN_PROGRESS'
		};
		const started = await workday.status(
			access,
			standalone.task.id,
			statusCommand,
			'Bearer fixture'
		);
		assert.equal(started.task.status, 'IN_PROGRESS');
		assert.equal(started.task.dueAt, standalone.task.dueAt);
		assert.equal(
			started.task.assignedToSubject,
			standalone.task.assignedToSubject
		);
		assert.deepEqual(
			await workday.status(
				access,
				standalone.task.id,
				statusCommand,
				'Bearer fixture'
			),
			started
		);
		const competing = await Promise.allSettled([
			workday.edit(
				access,
				standalone.task.id,
				{
					...statusCommand,
					commandId: randomUUID(),
					expectedVersion: 2,
					title: workdayPrefix,
					dueAt: '2026-09-08T10:00:00.000Z'
				},
				'Bearer fixture'
			),
			workday.status(
				access,
				standalone.task.id,
				{
					...statusCommand,
					commandId: randomUUID(),
					expectedVersion: 2,
					status: 'COMPLETED'
				},
				'Bearer fixture'
			)
		]);
		assert.equal(
			competing.filter(result => result.status === 'fulfilled').length,
			1
		);
		assert.equal(
			competing.find(result => result.status === 'rejected').reason.status,
			409
		);
		const currentStandalone = (
			await workday.detail(access, standalone.task.id)
		).task;
		const assignment = {
			schemaVersion: 1,
			workspaceId: access.workspaceId,
			commandId: randomUUID(),
			expectedVersion: currentStandalone.version,
			assignee: {
				subject: 'workday-manager',
				membershipId: managerMembership
			}
		};
		allowAssignee = false;
		await assert.rejects(
			workday.assign(
				access,
				standalone.task.id,
				assignment,
				'Bearer fixture'
			),
			error => error.status === 404
		);
		assert.equal(
			(await workday.detail(access, standalone.task.id)).task.version,
			currentStandalone.version
		);
		allowAssignee = true;
		const assigned = await workday.assign(
			access,
			standalone.task.id,
			assignment,
			'Bearer fixture'
		);
		assert.equal(assigned.task.assignedToSubject, 'workday-manager');
		assert.equal(assigned.task.assignedToMembershipId, managerMembership);
		workdayActor = {
			...access,
			subject: 'workday-manager',
			role: 'MANAGER',
			dataScope: 'OWN'
		};
		const managerQuery = Object.assign(new WorkdayQuery(), {
			workspaceId: access.workspaceId,
			period: 'ALL',
			search: workdayPrefix
		});
		assert.equal(
			(await workday.list(workdayActor, managerQuery)).total,
			1
		);
		await assert.rejects(
			workday.detail(
				{ ...workdayActor, subject: 'unrelated-manager' },
				standalone.task.id
			),
			error => error.status === 404
		);
		await assert.rejects(
			workday.list(workdayActor, { ...managerQuery, scope: 'ALL' }),
			error => error.status === 403
		);
		await assert.rejects(
			workday.detail(
				{ ...access, workspaceId: foreignWorkspace },
				standalone.task.id
			),
			error => error.status === 404
		);
		workdayActor = { ...access, state: 'READ_ONLY' };
		await assert.rejects(
			workday.status(
				workdayActor,
				standalone.task.id,
				{
					...statusCommand,
					commandId: randomUUID(),
					expectedVersion: assigned.task.version
				},
				'Bearer fixture'
			),
			error => error.status === 403
		);
		workdayActor = access;
		const linkedDeal = await service.create(
			access,
			{
				...command,
				commandId: randomUUID(),
				title: 'Workday linked deal'
			},
			'Bearer fixture'
		);
		const originalTask = await prisma.salesTask.findUniqueOrThrow({
			where: { id: linkedDeal.deal.nextTask.id }
		});
		assert.equal(
			originalTask.assignedToMembershipId,
			null,
			'Do not invent legacy Identity binding'
		);
		const linked = await workday.create(
			access,
			{
				...taskCommand,
				commandId: randomUUID(),
				dealId: linkedDeal.deal.id
			},
			'Bearer fixture'
		);
		assert.equal(
			(await service.detail(access, linkedDeal.deal.id)).deal.nextTask.id,
			originalTask.id,
			'Creating a parallel task preserves the selected action'
		);
		await assert.rejects(
			workday.assign(
				access,
				linked.task.id,
				{
					...assignment,
					commandId: randomUUID(),
					expectedVersion: linked.task.version
				},
				'Bearer fixture'
			),
			error => error.status === 403,
			'An assignee must not gain unrelated deal history'
		);
		await workday.status(
			access,
			originalTask.id,
			{
				...statusCommand,
				commandId: randomUUID(),
				expectedVersion: originalTask.version,
				status: 'COMPLETED'
			},
			'Bearer fixture'
		);
		assert.equal(
			(await service.detail(access, linkedDeal.deal.id)).deal.nextTask.id,
			linked.task.id
		);
		const withoutNextActionQuery = {
			workspaceId: access.workspaceId,
			page: 1,
			pageSize: 1,
			search: linkedDeal.deal.title,
			withoutNextAction: 'true'
		};
		assert.equal(
			(await service.deals(access, withoutNextActionQuery)).total,
			0,
			'An OPEN related task excludes a deal from the no-next-action filter'
		);
		const completedLinked = await workday.status(
			access,
			linked.task.id,
			{
				...statusCommand,
				commandId: randomUUID(),
				expectedVersion: linked.task.version,
				status: 'COMPLETED'
			},
			'Bearer fixture'
		);
		assert.equal(
			(await service.detail(access, linkedDeal.deal.id)).deal.nextTask,
			null,
			'Completing the last task does not force creation of another'
		);
		const withoutNextAction = await service.deals(
			access,
			withoutNextActionQuery
		);
		assert.equal(withoutNextAction.total, 1);
		assert.deepEqual(
			withoutNextAction.items.map(item => item.id),
			[linkedDeal.deal.id]
		);
		const secondFilteredPage = await service.deals(access, {
			...withoutNextActionQuery,
			page: 2
		});
		assert.equal(secondFilteredPage.total, 1);
		assert.deepEqual(secondFilteredPage.items, []);
		for (const status of ['WON', 'LOST']) {
			assert.equal(
				(
					await service.deals(access, {
						...withoutNextActionQuery,
						status
					})
				).total,
				0,
				'Contradictory status remains an intersection, not an ignored filter'
			);
		}
		for (const scoped of [
			{ ...access, workspaceId: randomUUID() },
			{ ...access, dataScope: 'OWN', subject: randomUUID(), teamIds: [] },
			{
				...access,
				dataScope: 'TEAM',
				subject: randomUUID(),
				teamIds: [randomUUID()]
			}
		]) {
			assert.equal(
				(await service.deals(scoped, withoutNextActionQuery)).total,
				0,
				'The next-action predicate never broadens workspace or record scope'
			);
		}
		assert.equal(
			(
				await service.deals(
					{ ...access, state: 'READ_ONLY' },
					withoutNextActionQuery
				)
			).total,
			1
		);
		assert.deepEqual(
			await service.deals(access, {
				...withoutNextActionQuery,
				withoutNextAction: 'false'
			}),
			await service.deals(access, {
				...withoutNextActionQuery,
				withoutNextAction: undefined
			})
		);
		const reopened = await workday.status(
			access,
			linked.task.id,
			{
				...statusCommand,
				commandId: randomUUID(),
				expectedVersion: completedLinked.task.version,
				status: 'IN_PROGRESS'
			},
			'Bearer fixture'
		);
		assert.equal(
			(await service.detail(access, linkedDeal.deal.id)).deal.nextTask.id,
			linked.task.id
		);
		assert.equal(
			(await service.deals(access, withoutNextActionQuery)).total,
			0,
			'IN_PROGRESS also excludes a deal from the no-next-action filter'
		);
		const cancelled = await workday.status(
			access,
			linked.task.id,
			{
				...statusCommand,
				commandId: randomUUID(),
				expectedVersion: reopened.task.version,
				status: 'CANCELLED'
			},
			'Bearer fixture'
		);
		assert.equal(cancelled.task.status, 'CANCELLED');
		assert.equal(
			(await service.deals(access, withoutNextActionQuery)).total,
			1,
			'COMPLETED and CANCELLED tasks are not pending next actions'
		);
		const listQuery = Object.assign(new WorkdayQuery(), {
			workspaceId: access.workspaceId,
			scope: 'ALL',
			period: 'DAY',
			from: '2026-09-07',
			timeZone: 'Europe/Moscow',
			search: workdayPrefix,
			pageSize: 1
		});
		const day = await workday.list(access, listQuery);
		assert.equal(day.items.length, 1);
		assert.equal(day.counts.CANCELLED, 1);
		assert.equal(
			day.total,
			Object.values(day.counts).reduce((sum, count) => sum + count, 0)
		);
		assert.deepEqual(day.range, {
			from: '2026-09-06T21:00:00.000Z',
			until: '2026-09-07T21:00:00.000Z'
		});
		const history = await workday.timeline(access, linked.task.id, {
			page: 1,
			pageSize: 1
		});
		assert.equal(history.total, 4);
		assert.equal(history.items.length, 1);
		await assert.rejects(
			prisma.taskCommandReceipt.create({
				data: {
					commandId: randomUUID(),
					workspaceId: foreignWorkspace,
					actorSubject: 'foreign',
					commandType: 'CREATED',
					requestHash: 'a'.repeat(64),
					taskId: standalone.task.id,
					result: {}
				}
			}),
			error => error?.code === 'P2003'
		);
		for (const table of ['task_command_receipts', 'task_timeline']) {
			await assert.rejects(
				prisma.$executeRawUnsafe(
					`UPDATE crm_sales.${table} SET workspace_id=workspace_id WHERE FALSE`
				),
				error => error?.meta?.code === '42501'
			);
			await assert.rejects(
				prisma.$executeRawUnsafe(
					`DELETE FROM crm_sales.${table} WHERE FALSE`
				),
				error => error?.meta?.code === '42501'
			);
		}
	}
	console.log(
		'CRM Sales PostgreSQL 18 workflow, tenant scope, replay, CAS and next-action invariants passed'
	);
} finally {
	await prisma.$disconnect();
}

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	assert.ok(value, `${name} is required`);
	return value;
}
