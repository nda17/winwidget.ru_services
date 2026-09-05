import {
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma, WidgetControlJob } from '@prisma/crm-intake-client';
import { randomUUID } from 'node:crypto';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { IntakeAuthorizationClient } from '../access/intake-authorization.client';
import {
	CONTROL_CONSUMER,
	CONTROL_RETRY_MS,
	ControlError,
	ControlEvent,
	ConfigureRequest,
	controlHash,
	widgetType
} from './widget-control.contract';
import {
	WidgetsControlClient,
	WidgetsControlDependencyError
} from './widgets-control.client';
import {
	controlOutbox,
	widgetControlConstraints
} from './widget-source.service';
const LEASE_MS = 30000;
@Injectable()
export class WidgetControlProcessor {
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly authorization: IntakeAuthorizationClient,
		private readonly widgets: WidgetsControlClient
	) {}
	private transaction<T>(
		fn: (tx: Prisma.TransactionClient) => Promise<T>
	) {
		return this.prisma.$transaction(
			async tx => {
				await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
				await tx.$executeRawUnsafe(
					"SET LOCAL statement_timeout = '3500ms'"
				);
				const result = await fn(tx);
				await widgetControlConstraints(tx);
				return result;
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 1500,
				timeout: 5000
			}
		);
	}
	private bind(job: WidgetControlJob, event: ControlEvent) {
		if (
			job.workspaceId !== event.workspaceId ||
			job.sourceId !== event.sourceId ||
			job.controlVersion !== event.controlVersion ||
			job.generation !== event.generation
		)
			throw new ConflictException('Control event binding mismatch');
	}
	async claim(
		event: ControlEvent,
		retryAttempt: number
	): Promise<{ state: 'DONE' } | { state: 'CLAIMED'; token: string }> {
		return this.transaction(async tx => {
			const job = await tx.widgetControlJob.findUnique({
				where: { commandId: event.commandId }
			});
			if (!job) throw new ConflictException('Control command missing');
			this.bind(job, event);
			const key = {
				eventId_consumer: {
					eventId: event.eventId,
					consumer: CONTROL_CONSUMER
				}
			};
			const old = await tx.widgetControlReceipt.findUnique({ where: key });
			const hash = controlHash(event);
			if (
				old &&
				(old.payloadHash !== hash ||
					old.workspaceId !== event.workspaceId ||
					old.commandId !== event.commandId ||
					old.sourceId !== event.sourceId)
			)
				throw new ConflictException('Control receipt binding mismatch');
			if (
				old?.status === 'DELIVERED' ||
				job.activeEventId !== event.eventId ||
				['APPLIED', 'SUPERSEDED'].includes(job.status)
			)
				return { state: 'DONE' as const };
			if (old?.status === 'FAILED' && retryAttempt <= old.retryAttempt)
				return { state: 'DONE' as const };
			if (
				(!old && retryAttempt !== 0) ||
				(old?.status === 'FAILED' && retryAttempt !== old.retryAttempt + 1)
			)
				throw new ConflictException('Control retry sequence mismatch');
			const now = new Date();
			if (
				job.status === 'PROCESSING' &&
				job.leaseUntil &&
				job.leaseUntil > now
			)
				throw new ServiceUnavailableException('Control command is leased');
			if (!['PENDING', 'PROCESSING'].includes(job.status))
				return { state: 'DONE' as const };
			const token = randomUUID(),
				leaseUntil = new Date(Date.now() + LEASE_MS);
			const changed = await tx.widgetControlJob.updateMany({
				where: {
					commandId: job.commandId,
					activeEventId: event.eventId,
					OR: [
						{ status: 'PENDING' },
						{ status: 'PROCESSING', leaseUntil: { lte: now } }
					]
				},
				data: { status: 'PROCESSING', leaseToken: token, leaseUntil }
			});
			if (changed.count !== 1)
				throw new ServiceUnavailableException('Control claim changed');
			const data = {
				workspaceId: event.workspaceId,
				sourceId: event.sourceId,
				commandId: event.commandId,
				payloadHash: hash,
				status: 'PROCESSING',
				leaseToken: token,
				leaseUntil,
				retryAttempt
			};
			if (old) await tx.widgetControlReceipt.update({ where: key, data });
			else
				await tx.widgetControlReceipt.create({
					data: {
						eventId: event.eventId,
						consumer: CONTROL_CONSUMER,
						...data
					}
				});
			return { state: 'CLAIMED' as const, token };
		});
	}
	async run(event: ControlEvent, token: string) {
		const job = await this.current(event, token);
		const source = await this.prisma.managedWidgetSource.findUniqueOrThrow(
			{ where: { id: job.sourceId } }
		);
		if (
			source.currentCommandId !== job.commandId ||
			source.controlVersion !== job.controlVersion ||
			source.generation !== job.generation ||
			source.enabled !== job.enabled
		) {
			await this.complete(event, token, null, true);
			return;
		}
		if (job.enabled) {
			const authority = await this.authorization.authorizeWidgetSource(
				job.workspaceId,
				job.actorSubject
			);
			if (authority.ownerSubject !== job.ownerSubject)
				throw new ForbiddenException({ code: 'OWNER_CHANGED' });
			if (source.teamId && !authority.teamIds.includes(source.teamId))
				throw new ForbiddenException({ code: 'DELEGATION_REVOKED' });
		}
		// An immutable disabling intent remains a technical fence after CRM expiry.
		await this.current(event, token);
		const freshSource =
			await this.prisma.managedWidgetSource.findUniqueOrThrow({
				where: { id: job.sourceId }
			});
		if (freshSource.currentCommandId !== job.commandId) {
			await this.complete(event, token, null, true);
			return;
		}
		const request: ConfigureRequest = {
			schemaVersion: 1,
			commandId: job.commandId,
			workspaceId: job.workspaceId,
			sourceId: job.sourceId,
			ownerSubject: job.ownerSubject,
			widgetType: widgetType(job.widgetType),
			widgetId: job.widgetId,
			controlVersion: job.controlVersion,
			generation: job.generation,
			enabled: job.enabled
		};
		const response = await this.widgets.configure(
			job.connectorId,
			request
		);
		await this.complete(event, token, response, false);
	}
	async renew(event: ControlEvent, token: string) {
		return this.transaction(async tx => {
			const now = new Date(),
				until = new Date(Date.now() + LEASE_MS);
			const claim = await tx.widgetControlJob.updateMany({
				where: {
					commandId: event.commandId,
					activeEventId: event.eventId,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: now }
				},
				data: { leaseUntil: until }
			});
			if (claim.count !== 1) return false;
			const receipt = await tx.widgetControlReceipt.updateMany({
				where: {
					eventId: event.eventId,
					consumer: CONTROL_CONSUMER,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: now }
				},
				data: { leaseUntil: until }
			});
			if (receipt.count !== 1)
				throw new ConflictException('Control receipt lease missing');
			return true;
		});
	}
	private async current(event: ControlEvent, token: string) {
		const row = await this.prisma.widgetControlJob.findFirst({
			where: {
				commandId: event.commandId,
				workspaceId: event.workspaceId,
				sourceId: event.sourceId,
				activeEventId: event.eventId,
				status: 'PROCESSING',
				leaseToken: token,
				leaseUntil: { gt: new Date() }
			}
		});
		if (!row) throw new ConflictException('Control lease lost');
		this.bind(row, event);
		return row;
	}
	private async complete(
		event: ControlEvent,
		token: string,
		response: unknown,
		superseded: boolean
	) {
		await this.transaction(async tx => {
			const now = new Date();
			const changed = await tx.widgetControlJob.updateMany({
				where: {
					commandId: event.commandId,
					activeEventId: event.eventId,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: now }
				},
				data: {
					status: superseded ? 'SUPERSEDED' : 'APPLIED',
					response: response
						? (JSON.parse(
								JSON.stringify(response)
							) as Prisma.InputJsonObject)
						: Prisma.DbNull,
					leaseToken: null,
					leaseUntil: null,
					lastErrorCode: null,
					completedAt: now
				}
			});
			if (changed.count !== 1)
				throw new ConflictException('Control completion lease lost');
			if (!superseded)
				await tx.managedWidgetSource.updateMany({
					where: {
						id: event.sourceId,
						workspaceId: event.workspaceId,
						currentCommandId: event.commandId,
						controlVersion: event.controlVersion,
						generation: event.generation
					},
					data: {
						appliedControlVersion: event.controlVersion,
						appliedGeneration: event.generation,
						syncState: 'SYNCED',
						lastErrorCode: null,
						syncedAt: now
					}
				});
			const receipt = await tx.widgetControlReceipt.updateMany({
				where: {
					eventId: event.eventId,
					consumer: CONTROL_CONSUMER,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: now }
				},
				data: { status: 'DELIVERED', leaseToken: null, leaseUntil: null }
			});
			if (receipt.count !== 1)
				throw new ConflictException('Control receipt lease lost');
		});
	}
	async fail(
		event: ControlEvent,
		token: string,
		retryAttempt: number,
		error: unknown
	): Promise<boolean> {
		if (
			error instanceof WidgetsControlDependencyError &&
			error.code === 'widgets_wincrm_control_stale'
		) {
			const source = await this.prisma.managedWidgetSource.findFirst({
				where: { id: event.sourceId, workspaceId: event.workspaceId }
			});
			if (source && source.controlVersion > event.controlVersion) {
				await this.complete(event, token, null, true);
				return true;
			}
		}
		const status =
			error instanceof WidgetsControlDependencyError
				? error.status
				: error instanceof HttpException
					? error.getStatus()
					: 503;
		let code: ControlError =
			status === 403
				? 'DELEGATION_REVOKED'
				: status === 404
					? 'WIDGET_UNAVAILABLE'
					: status === 409
						? 'CONTROL_CONFLICT'
						: 'DEPENDENCY_UNAVAILABLE';
		if (error instanceof WidgetsControlDependencyError) {
			if (error.code === 'widgets_wincrm_subscription_required')
				code = 'SUBSCRIPTION_REQUIRED';
			if (error.code === 'widgets_wincrm_widget_already_connected')
				code = 'ALREADY_CONNECTED';
		}
		if (
			error instanceof HttpException &&
			typeof error.getResponse() === 'object' &&
			(error.getResponse() as { code?: string }).code === 'OWNER_CHANGED'
		)
			code = 'OWNER_CHANGED';
		const transient = ![400, 403, 404, 409].includes(status);
		const retry = transient && retryAttempt < CONTROL_RETRY_MS.length;
		return this.transaction(async tx => {
			const [clock] = await tx.$queryRaw<
				Array<{ now: Date }>
			>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
			if (!clock || !Number.isFinite(clock.now.getTime()))
				throw new Error('RETRY_CLOCK_UNAVAILABLE');
			const now = clock.now;
			const availableAt = new Date(
				now.getTime() + (retry ? CONTROL_RETRY_MS[retryAttempt] : 0)
			);
			const changed = await tx.widgetControlJob.updateMany({
				where: {
					commandId: event.commandId,
					activeEventId: event.eventId,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: now }
				},
				data: {
					status: retry ? 'PENDING' : transient ? 'ERROR' : 'BLOCKED',
					leaseToken: null,
					leaseUntil: null,
					lastErrorCode: code
				}
			});
			if (changed.count !== 1) return false;
			const receipt = await tx.widgetControlReceipt.updateMany({
				where: {
					eventId: event.eventId,
					consumer: CONTROL_CONSUMER,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: now }
				},
				data: { status: 'FAILED', leaseToken: null, leaseUntil: null }
			});
			if (receipt.count !== 1)
				throw new ConflictException('Control failure receipt lease lost');
			await tx.managedWidgetSource.updateMany({
				where: {
					id: event.sourceId,
					workspaceId: event.workspaceId,
					currentCommandId: event.commandId,
					controlVersion: event.controlVersion,
					generation: event.generation
				},
				data: {
					syncState: retry ? 'PENDING' : transient ? 'ERROR' : 'BLOCKED',
					lastErrorCode: code
				}
			});
			await tx.widgetControlOutbox.create({
				data: {
					...controlOutbox(
						event,
						retry ? 'MAIN' : 'DLQ',
						retry ? retryAttempt + 1 : retryAttempt,
						retry ? 'retry:' + (retryAttempt + 1) : 'dlq'
					),
					availableAt,
					lastErrorCode: code
				}
			});
			return true;
		});
	}
}
