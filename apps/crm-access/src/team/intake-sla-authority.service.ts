import {
	BadRequestException,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { CrmAuthorizationService } from '../authorization/crm-authorization.service';
import {
	hasExactKeys,
	isRecord,
	isUuidV4
} from '../internal/internal-http.config';

export interface IntakeSlaAuthorityRequest {
	schemaVersion: 1;
	purpose: 'INTAKE_SLA';
	workspaceId: string;
	actorSubject: string;
	/** null resolves the authenticated writer's binding; an object checks a stored binding. */
	expectedBinding: { subject: string; membershipId: string | null } | null;
}
export function parseIntakeSlaAuthority(
	value: unknown
): IntakeSlaAuthorityRequest {
	const subject = (item: unknown) =>
		typeof item === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/.test(item);
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'purpose',
			'workspaceId',
			'actorSubject',
			'expectedBinding'
		]) ||
		value.schemaVersion !== 1 ||
		value.purpose !== 'INTAKE_SLA' ||
		!isUuidV4(value.workspaceId) ||
		!subject(value.actorSubject) ||
		!(
			value.expectedBinding === null ||
			(isRecord(value.expectedBinding) &&
				hasExactKeys(value.expectedBinding, ['subject', 'membershipId']) &&
				value.expectedBinding.subject === value.actorSubject &&
				(value.expectedBinding.membershipId === null ||
					isUuidV4(value.expectedBinding.membershipId)))
		)
	)
		throw new BadRequestException('Invalid Intake SLA authority request');
	return value as unknown as IntakeSlaAuthorityRequest;
}

/** Only authority for managing/evaluating the Intake-owned rule. This endpoint
 * deliberately does NOT authorize recipients or return delivery channels. */
@Injectable()
export class IntakeSlaAuthorityService {
	constructor(private readonly authorization: CrmAuthorizationService) {}
	async authorize(input: IntakeSlaAuthorityRequest) {
		const denied = () => ({
			schemaVersion: 1,
			workspaceId: input.workspaceId,
			allowed: false,
			binding: null
		});
		try {
			const access = await this.authorization.assignmentSubject(
				input.workspaceId,
				input.actorSubject
			);
			const binding = {
				subject: access.subject,
				membershipId: access.role === 'OWNER' ? null : access.membershipId
			};
			if (
				!['OWNER', 'CRM_ADMIN'].includes(access.role) ||
				!['ACTIVE', 'GRACE'].includes(access.state) ||
				!access.permissions.includes('intake:write') ||
				!access.permissions.includes('intake:read') ||
				(input.expectedBinding !== null &&
					(input.expectedBinding.subject !== binding.subject ||
						input.expectedBinding.membershipId !== binding.membershipId))
			)
				return denied();
			return {
				schemaVersion: 1,
				workspaceId: input.workspaceId,
				allowed: true,
				binding
			};
		} catch (error) {
			if (error instanceof ForbiddenException) return denied();
			throw error;
		}
	}
}
