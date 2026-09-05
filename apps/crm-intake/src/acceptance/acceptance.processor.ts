import {
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable
} from '@nestjs/common';
import { Prisma, type Acceptance } from '@prisma/crm-intake-client';
import { randomUUID } from 'node:crypto';
import { IntakeAuthorizationClient } from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import {
	acceptanceHash,
	type AcceptanceEvent,
	type OperationProof
} from './acceptance.contract';
import {
	AcceptanceOperationsClient,
	parseOperationProof
} from './acceptance-operations.client';
import {
	acceptanceBinding,
	enqueueAcceptance
} from './acceptance.service';

export const ACCEPTANCE_CONSUMER = 'crm-intake-acceptance-v1';
export const ACCEPTANCE_LEASE_MS = 120000;
export const ACCEPTANCE_RETRY_MS = [30000, 300000, 1800000] as const;
export class AcceptanceLeaseLost extends Error {}
export type AcceptanceClaim =
	| { state: 'CLAIMED'; token: string }
	| { state: 'DONE' };

@Injectable()
export class AcceptanceProcessor {
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly authorization: IntakeAuthorizationClient,
		private readonly operations: AcceptanceOperationsClient
	) {}

	async claim(
		event: AcceptanceEvent,
		retryAttempt: number
	): Promise<AcceptanceClaim> {
		return this.prisma.$transaction(async tx => {
			await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
			await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-intake:acceptance-event:${event.eventId}`},0))`;
			const hash = acceptanceHash(event);
			const prior = await tx.acceptanceReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId: event.eventId,
						consumer: ACCEPTANCE_CONSUMER
					}
				}
			});
			if (
				prior &&
				(prior.payloadHash !== hash ||
					prior.workspaceId !== event.workspaceId ||
					prior.workflowId !== event.workflowId)
			)
				throw new ConflictException('Event binding does not match');
			if (prior && ['DELIVERED', 'DEAD_LETTERED'].includes(prior.status))
				return { state: 'DONE' };
			const row = await tx.acceptance.findFirst({
				where: { id: event.workflowId, workspaceId: event.workspaceId }
			});
			if (!row) throw new ConflictException('Workflow is not available');
			if (
				row.generation !== event.generation ||
				row.mode !== event.mode ||
				['CANCELLED', 'COMPLETED'].includes(row.status)
			) {
				await tx.acceptanceReceipt.upsert({
					where: {
						eventId_consumer: {
							eventId: event.eventId,
							consumer: ACCEPTANCE_CONSUMER
						}
					},
					create: {
						eventId: event.eventId,
						consumer: ACCEPTANCE_CONSUMER,
						workspaceId: event.workspaceId,
						workflowId: event.workflowId,
						payloadHash: hash,
						status: 'DELIVERED'
					},
					update: {
						status: 'DELIVERED',
						leaseToken: null,
						leaseUntil: null
					}
				});
				return { state: 'DONE' };
			}
			const now = new Date();
			if (
				prior?.status === 'PROCESSING' &&
				prior.leaseUntil &&
				prior.leaseUntil > now
			) {
				await enqueueAcceptance(
					tx,
					event,
					'MAIN',
					`${event.eventId}:claim-recovery:${prior.leaseUntil.toISOString()}`,
					new Date(prior.leaseUntil.getTime() + 1000),
					prior.retryAttempt
				);
				return { state: 'DONE' };
			}
			if (prior && retryAttempt !== prior.retryAttempt)
				return { state: 'DONE' };
			const token = randomUUID();
			await tx.acceptanceReceipt.upsert({
				where: {
					eventId_consumer: {
						eventId: event.eventId,
						consumer: ACCEPTANCE_CONSUMER
					}
				},
				create: {
					eventId: event.eventId,
					consumer: ACCEPTANCE_CONSUMER,
					workspaceId: event.workspaceId,
					workflowId: event.workflowId,
					payloadHash: hash,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: new Date(now.getTime() + ACCEPTANCE_LEASE_MS),
					retryAttempt
				},
				update: {
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: new Date(now.getTime() + ACCEPTANCE_LEASE_MS)
				}
			});
			const changed = await tx.acceptance.updateMany({
				where: {
					id: row.id,
					generation: row.generation,
					version: row.version,
					mode: row.mode,
					status: row.status
				},
				data: {
					status: row.mode === 'RECOVER' ? 'RECOVERING' : 'RUNNING',
					version: { increment: 1 },
					retryAt: null
				}
			});
			if (changed.count !== 1) throw new AcceptanceLeaseLost();
			return { state: 'CLAIMED', token };
		});
	}

	async renew(event: AcceptanceEvent, token: string): Promise<boolean> {
		const changed = await this.prisma.acceptanceReceipt.updateMany({
			where: {
				eventId: event.eventId,
				consumer: ACCEPTANCE_CONSUMER,
				status: 'PROCESSING',
				leaseToken: token,
				leaseUntil: { gt: new Date() }
			},
			data: { leaseUntil: new Date(Date.now() + ACCEPTANCE_LEASE_MS) }
		});
		return changed.count === 1;
	}

	async run(event: AcceptanceEvent, token: string): Promise<void> {
		let row = await this.current(event, token);
		let sales = await this.operations.request(
			'sales',
			'read',
			acceptanceBinding(row, 'sales')
		);
		await this.current(event, token);
		if (sales.state === 'COMMITTED') {
			const contact = await this.operations.request(
				'customers',
				'read',
				acceptanceBinding(row, 'customers')
			);
			await this.finish(event, token, contact, sales);
			return;
		}
		if (event.mode === 'RECOVER') {
			const recovery = await this.authorization.authorizeWorkflow(
				row.workspaceId,
				row.recoverySubject!
			);
			if (!['OWNER', 'CRM_ADMIN'].includes(recovery.role))
				throw new ForbiddenException('Recovery authority is not active');
			await this.current(event, token);
			sales = await this.operations.request(
				'sales',
				'close',
				acceptanceBinding(row, 'sales'),
				{
					commandId: row.recoverySalesCommandId!,
					recoverySubject: row.recoverySubject!
				}
			);
			await this.current(event, token);
			if (sales.state === 'COMMITTED') {
				const contact = await this.operations.request(
					'customers',
					'read',
					acceptanceBinding(row, 'customers')
				);
				await this.finish(event, token, contact, sales);
				return;
			}
			if (sales.state !== 'CANCELLED')
				throw new ConflictException('Sales close was not confirmed');
			const contact = await this.operations.request(
				'customers',
				'close',
				acceptanceBinding(row, 'customers'),
				{
					commandId: row.recoveryContactCommandId!,
					recoverySubject: row.recoverySubject!
				}
			);
			if (!['CANCELLED', 'COMMITTED'].includes(contact.state))
				throw new ConflictException('Contact close was not confirmed');
			await this.cancel(event, token, contact, sales);
			return;
		}
		if (sales.state === 'CANCELLED')
			throw new ConflictException('Sales operation is closed');
		let contact = await this.operations.request(
			'customers',
			'read',
			acceptanceBinding(row, 'customers')
		);
		await this.current(event, token);
		if (contact.state === 'ABSENT') {
			await this.authorization.authorizeWorkflow(
				row.workspaceId,
				row.actorSubject
			);
			await this.current(event, token);
			contact = await this.operations.request(
				'customers',
				'execute',
				acceptanceBinding(row, 'customers'),
				{ commandId: row.contactCommandId, payload: row.contactPayload }
			);
		}
		if (contact.state !== 'COMMITTED')
			throw new ConflictException('Contact operation is closed');
		await this.checkpoint(event, token, contact);
		row = await this.current(event, token);
		await this.authorization.authorizeWorkflow(
			row.workspaceId,
			row.actorSubject
		);
		await this.current(event, token);
		sales = await this.operations.request(
			'sales',
			'execute',
			acceptanceBinding(row, 'sales'),
			{ commandId: row.salesCommandId, payload: row.salesPayload }
		);
		if (sales.state !== 'COMMITTED')
			throw new ConflictException('Sales operation is closed');
		// No further business writes: completing already committed facts is allowed after expiry.
		await this.finish(event, token, contact, sales);
	}

	async fail(
		event: AcceptanceEvent,
		token: string,
		retryAttempt: number,
		error: unknown
	): Promise<boolean> {
		const status =
			error instanceof HttpException ? error.getStatus() : 503;
		const blocked = [400, 403, 404, 409].includes(status);
		const retry = !blocked && retryAttempt < ACCEPTANCE_RETRY_MS.length;
		const code =
			status === 403
				? 'WORKFLOW_ACCESS_BLOCKED'
				: blocked
					? 'WORKFLOW_REFERENCE_CONFLICT'
					: 'WORKFLOW_DEPENDENCY_UNAVAILABLE';
		return this.prisma.$transaction(async tx => {
			const receipt = await tx.acceptanceReceipt.updateMany({
				where: {
					eventId: event.eventId,
					consumer: ACCEPTANCE_CONSUMER,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: new Date() }
				},
				data: {
					status: retry ? 'RETRY_SCHEDULED' : 'DEAD_LETTERED',
					leaseToken: null,
					leaseUntil: null,
					retryAttempt: retry ? retryAttempt + 1 : retryAttempt
				}
			});
			if (receipt.count !== 1) return false;
			const changed = await tx.acceptance.updateMany({
				where: {
					id: event.workflowId,
					workspaceId: event.workspaceId,
					generation: event.generation,
					mode: event.mode,
					status: { notIn: ['COMPLETED', 'CANCELLED'] }
				},
				data: {
					status: blocked ? 'BLOCKED' : retry ? 'RETRY_WAIT' : 'FAILED',
					version: { increment: 1 },
					lastErrorCode: code,
					retryAt: retry
						? new Date(Date.now() + ACCEPTANCE_RETRY_MS[retryAttempt])
						: null
				}
			});
			if (changed.count !== 1) return true;
			await enqueueAcceptance(
				tx,
				event,
				retry ? `RETRY_${retryAttempt + 1}` : 'DLQ',
				`${event.eventId}:${retry ? 'retry' : 'dead'}:${retryAttempt + 1}`,
				new Date(),
				retry ? retryAttempt + 1 : retryAttempt
			);
			return true;
		});
	}

	private async current(
		event: AcceptanceEvent,
		token: string,
		tx: Prisma.TransactionClient | CrmIntakePrismaService = this.prisma
	): Promise<Acceptance> {
		const receipt = await tx.acceptanceReceipt.findFirst({
			where: {
				eventId: event.eventId,
				consumer: ACCEPTANCE_CONSUMER,
				status: 'PROCESSING',
				leaseToken: token,
				leaseUntil: { gt: new Date() }
			}
		});
		const row = await tx.acceptance.findFirst({
			where: {
				id: event.workflowId,
				workspaceId: event.workspaceId,
				generation: event.generation,
				mode: event.mode,
				status: { in: ['RUNNING', 'RECOVERING'] }
			}
		});
		if (!receipt || !row)
			throw new AcceptanceLeaseLost('Acceptance lease was lost');
		return row;
	}
	private async checkpoint(
		event: AcceptanceEvent,
		token: string,
		contact: OperationProof
	) {
		await this.prisma.$transaction(async tx => {
			const row = await this.current(event, token, tx);
			const proof = parseOperationProof(
				contact,
				acceptanceBinding(row, 'customers'),
				'customers'
			);
			if (proof.state !== 'COMMITTED')
				throw new ConflictException('Contact was not committed');
			await this.claimFence(tx, event, token);
			const updated = await tx.acceptance.updateMany({
				where: { id: row.id, generation: event.generation },
				data: {
					contactProof: proof as unknown as Prisma.InputJsonObject,
					contactId: String(proof.result!.contactId),
					version: { increment: 1 }
				}
			});
			if (updated.count !== 1) throw new AcceptanceLeaseLost();
		});
	}
	private async finish(
		event: AcceptanceEvent,
		token: string,
		contact: OperationProof,
		sales: OperationProof
	) {
		await this.prisma.$transaction(async tx => {
			await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
			await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
			const hint = await tx.acceptance.findUnique({
				where: { id: event.workflowId }
			});
			if (!hint) throw new AcceptanceLeaseLost();
			await tx.$queryRaw`SELECT id FROM crm_intake.inbox_entries WHERE id=${hint.entryId}::uuid AND workspace_id=${event.workspaceId}::uuid FOR UPDATE`;
			const row = await this.current(event, token, tx);
			const c = parseOperationProof(
				contact,
				acceptanceBinding(row, 'customers'),
				'customers'
			);
			const s = parseOperationProof(
				sales,
				acceptanceBinding(row, 'sales'),
				'sales'
			);
			if (
				c.state !== 'COMMITTED' ||
				s.state !== 'COMMITTED' ||
				c.result!.contactId !== s.result!.contactId
			)
				throw new ConflictException('Committed proofs do not match');
			await this.claimFence(tx, event, token);
			const now = new Date();
			const completed = await tx.acceptance.updateMany({
				where: { id: row.id, generation: event.generation },
				data: {
					status: 'COMPLETED',
					contactProof: c as unknown as Prisma.InputJsonObject,
					salesProof: s as unknown as Prisma.InputJsonObject,
					contactId: String(c.result!.contactId),
					dealId: String(s.result!.dealId),
					firstTaskId: String(s.result!.firstTaskId),
					completedAt: now,
					version: { increment: 1 },
					lastErrorCode: null,
					retryAt: null
				}
			});
			if (completed.count !== 1) throw new AcceptanceLeaseLost();
			const entry = await tx.inboxEntry.updateMany({
				where: {
					id: row.entryId,
					workspaceId: row.workspaceId,
					status: 'NEW'
				},
				data: {
					status: 'ACCEPTED',
					contactId: String(c.result!.contactId),
					dealId: String(s.result!.dealId),
					acceptedAt: now,
					version: { increment: 1 }
				}
			});
			if (entry.count !== 1)
				throw new ConflictException('Inbox outcome changed');
			await this.audit(tx, row, 'ACCEPTED');
			await this.delivered(tx, event, token);
		});
	}
	private async cancel(
		event: AcceptanceEvent,
		token: string,
		contact: OperationProof,
		sales: OperationProof
	) {
		await this.prisma.$transaction(async tx => {
			await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
			await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
			const hint = await tx.acceptance.findUnique({
				where: { id: event.workflowId }
			});
			if (!hint) throw new AcceptanceLeaseLost();
			await tx.$queryRaw`SELECT id FROM crm_intake.inbox_entries WHERE id=${hint.entryId}::uuid AND workspace_id=${event.workspaceId}::uuid FOR UPDATE`;
			const row = await this.current(event, token, tx);
			const c = parseOperationProof(
				contact,
				acceptanceBinding(row, 'customers'),
				'customers'
			);
			const s = parseOperationProof(
				sales,
				acceptanceBinding(row, 'sales'),
				'sales'
			);
			if (
				s.state !== 'CANCELLED' ||
				!['COMMITTED', 'CANCELLED'].includes(c.state)
			)
				throw new ConflictException('Cancellation is not proven');
			await this.claimFence(tx, event, token);
			await tx.acceptance.update({
				where: { id: row.id },
				data: {
					status: 'CANCELLED',
					contactProof: c as unknown as Prisma.InputJsonObject,
					salesProof: s as unknown as Prisma.InputJsonObject,
					contactId:
						c.state === 'COMMITTED' ? String(c.result!.contactId) : null,
					version: { increment: 1 },
					completedAt: new Date(),
					lastErrorCode: null,
					retryAt: null
				}
			});
			const entry = await tx.inboxEntry.updateMany({
				where: {
					id: row.entryId,
					workspaceId: row.workspaceId,
					status: 'NEW'
				},
				data: { version: { increment: 1 } }
			});
			if (entry.count !== 1)
				throw new ConflictException('Inbox outcome changed');
			await this.audit(tx, row, 'ACCEPTANCE_CANCELLED');
			await this.delivered(tx, event, token);
		});
	}
	private async claimFence(
		tx: Prisma.TransactionClient,
		event: AcceptanceEvent,
		token: string
	) {
		const changed = await tx.acceptanceReceipt.updateMany({
			where: {
				eventId: event.eventId,
				consumer: ACCEPTANCE_CONSUMER,
				status: 'PROCESSING',
				leaseToken: token,
				leaseUntil: { gt: new Date() }
			},
			data: { leaseUntil: new Date(Date.now() + ACCEPTANCE_LEASE_MS) }
		});
		if (changed.count !== 1) throw new AcceptanceLeaseLost();
	}
	private async delivered(
		tx: Prisma.TransactionClient,
		event: AcceptanceEvent,
		token: string
	) {
		const changed = await tx.acceptanceReceipt.updateMany({
			where: {
				eventId: event.eventId,
				consumer: ACCEPTANCE_CONSUMER,
				status: 'PROCESSING',
				leaseToken: token
			},
			data: { status: 'DELIVERED', leaseToken: null, leaseUntil: null }
		});
		if (changed.count !== 1) throw new AcceptanceLeaseLost();
	}
	private async audit(
		tx: Prisma.TransactionClient,
		row: Acceptance,
		action: string
	) {
		await tx.intakeActivity.create({
			data: {
				workspaceId: row.workspaceId,
				entityId: row.entryId,
				entityKind: 'entry',
				commandId: randomUUID(),
				actorSubject:
					row.mode === 'RECOVER' ? row.recoverySubject! : row.actorSubject,
				action,
				entityVersion: row.version + 1
			}
		});
	}
}
