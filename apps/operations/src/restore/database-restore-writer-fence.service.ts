import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration
} from './database-restore-target-registry.service';

export interface DatabaseRestoreWriterFenceEvidence {
	roles: [string, string, string];
	verifiedAt: Date;
	evidenceSha256: string;
}

const DATABASE_RESTORE_TARGET_LOCK_TIMEOUT = '5000ms';
const DATABASE_RESTORE_TARGET_STATEMENT_TIMEOUT = '15000ms';
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class DatabaseRestoreWriterFenceService {
	constructor(private readonly process: DatabaseRestoreProcessService) {}

	async apply(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		operationId: string,
		signal?: AbortSignal
	): Promise<DatabaseRestoreWriterFenceEvidence> {
		const roles = this.roles(target);
		const generationMarker = this.generationMarker(
			target,
			roles,
			operationId
		);
		await this.process.executeSql(
			connection,
			[
				'BEGIN;',
				...this.targetTransactionGuards(target),
				this.verifyApplyBoundaryBlock(target, roles, generationMarker),
				`ALTER ROLE ${this.identifier(target.adminRole)} SET ${this.identifier('winwidget.restore_generation')} TO ${this.literal(generationMarker)};`,
				...roles.map(
					role => `ALTER ROLE ${this.identifier(role)} NOLOGIN;`
				),
				'COMMIT;'
			].join('\n'),
			signal
		);
		await this.process.executeSql(
			connection,
			this.terminateSql(target, roles),
			signal
		);
		await this.process.executeSql(
			connection,
			this.verifyFencedSql(target, roles, generationMarker),
			signal
		);
		return this.fencedEvidence(roles, generationMarker);
	}

	async reapply(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		operationId: string,
		signal?: AbortSignal
	): Promise<DatabaseRestoreWriterFenceEvidence> {
		const roles = this.roles(target);
		const generationMarker = this.generationMarker(
			target,
			roles,
			operationId
		);
		await this.process.executeSql(
			connection,
			[
				'BEGIN;',
				...this.targetTransactionGuards(target),
				this.verifyReapplyBoundaryBlock(target, roles, generationMarker),
				...roles.map(
					role => `ALTER ROLE ${this.identifier(role)} NOLOGIN;`
				),
				'COMMIT;'
			].join('\n'),
			signal
		);
		await this.process.executeSql(
			connection,
			this.terminateSql(target, roles),
			signal
		);
		await this.process.executeSql(
			connection,
			this.verifyFencedSql(target, roles, generationMarker),
			signal
		);
		return this.fencedEvidence(roles, generationMarker);
	}

	async verify(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		generationMarker: string,
		signal?: AbortSignal
	): Promise<DatabaseRestoreWriterFenceEvidence> {
		this.assertGenerationMarker(generationMarker);
		const roles = this.roles(target);
		await this.process.executeSql(
			connection,
			this.verifyFencedSql(target, roles, generationMarker),
			signal
		);
		return this.fencedEvidence(roles, generationMarker);
	}

	async release(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		generationMarker: string,
		signal?: AbortSignal
	): Promise<DatabaseRestoreWriterFenceEvidence> {
		this.assertGenerationMarker(generationMarker);
		const roles = this.roles(target);
		await this.process.executeSql(
			connection,
			[
				'BEGIN;',
				...this.targetTransactionGuards(target),
				this.verifyFencedBlock(target, roles, generationMarker),
				...roles.map(role => `ALTER ROLE ${this.identifier(role)} LOGIN;`),
				this.verifyOpenBlock(target, roles, generationMarker),
				'COMMIT;'
			].join('\n'),
			signal
		);
		return this.releaseEvidence(target, roles, generationMarker);
	}

	async ensureReleased(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		generationMarker: string,
		signal?: AbortSignal
	): Promise<DatabaseRestoreWriterFenceEvidence> {
		this.assertGenerationMarker(generationMarker);
		const roles = this.roles(target);
		await this.process.executeSql(
			connection,
			[
				'BEGIN;',
				...this.targetTransactionGuards(target),
				this.verifyReleasableTerminalBlock(
					target,
					roles,
					generationMarker
				),
				...roles.map(role => `ALTER ROLE ${this.identifier(role)} LOGIN;`),
				this.verifyOpenBlock(target, roles, generationMarker),
				'COMMIT;'
			].join('\n'),
			signal
		);
		return this.releaseEvidence(target, roles, generationMarker);
	}

	private terminateSql(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string]
	): string {
		const roleValues = [...roles, target.adminRole]
			.map(role => this.literal(role))
			.join(', ');
		return `DO $database_restore_terminate_writers$
DECLARE
	backend_pid INTEGER;
BEGIN
	IF current_database() <> ${this.literal(target.database)} THEN
		RAISE EXCEPTION 'Database restore writer fence connected to an unexpected database';
	END IF;
	FOR backend_pid IN
		SELECT activity.pid
		FROM pg_stat_activity AS activity
		WHERE activity.usesysid IN (
				SELECT role_state.oid FROM pg_roles AS role_state
				WHERE role_state.rolname IN (${roleValues})
			)
			AND activity.pid <> pg_backend_pid()
	LOOP
		IF NOT pg_terminate_backend(backend_pid, 5000) THEN
			RAISE EXCEPTION 'Database restore writer session could not be terminated';
		END IF;
	END LOOP;
END
$database_restore_terminate_writers$;`;
	}

	private verifyFencedSql(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string],
		generationMarker: string
	): string {
		return this.verifyFencedBlock(target, roles, generationMarker);
	}

	private verifyFencedBlock(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string],
		generationMarker: string
	): string {
		const roleValues = roles.map(role => this.literal(role)).join(', ');
		return `DO $database_restore_verify_writer_fence$
DECLARE
	role_count INTEGER;
BEGIN
	IF current_database() <> ${this.literal(target.database)} THEN
		RAISE EXCEPTION 'Database restore writer fence connected to an unexpected database';
	END IF;
	${this.verifyTrustedControlPlaneBoundary(target, roles)}
	${this.verifyGenerationMarker(target, generationMarker)}
	SELECT count(*) INTO role_count
	FROM pg_roles AS role_state
	WHERE role_state.rolname IN (${roleValues});
	IF role_count <> 3 OR EXISTS (
		SELECT 1 FROM pg_roles AS role_state
		WHERE role_state.rolname IN (${roleValues}) AND role_state.rolcanlogin
	) THEN
		RAISE EXCEPTION 'Database restore writer roles are not fully fenced';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_stat_activity AS activity
		WHERE activity.usesysid IN (
				SELECT role_state.oid FROM pg_roles AS role_state
				WHERE role_state.rolname IN (${roleValues})
			)
	) THEN
		RAISE EXCEPTION 'Database restore writer sessions remain active';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_prepared_xacts AS prepared
		WHERE prepared.database = current_database()
	) THEN
		RAISE EXCEPTION 'Database restore target has prepared transactions';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_stat_activity AS activity
		WHERE activity.usename = ${this.literal(target.adminRole)}
			AND activity.pid <> pg_backend_pid()
	) THEN
		RAISE EXCEPTION 'Database restore target has an unexpected admin session';
	END IF;
END
$database_restore_verify_writer_fence$;`;
	}

	private verifyOpenBlock(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string],
		generationMarker: string
	): string {
		const roleValues = roles.map(role => this.literal(role)).join(', ');
		return `DO $database_restore_verify_writer_unfence$
DECLARE
	role_count INTEGER;
BEGIN
	IF current_database() <> ${this.literal(target.database)} THEN
		RAISE EXCEPTION 'Database restore writer release connected to an unexpected database';
	END IF;
	${this.verifyGenerationMarker(target, generationMarker)}
	SELECT count(*) INTO role_count
	FROM pg_roles AS role_state
	WHERE role_state.rolname IN (${roleValues});
	IF role_count <> 3 OR EXISTS (
		SELECT 1 FROM pg_roles AS role_state
		WHERE role_state.rolname IN (${roleValues}) AND NOT role_state.rolcanlogin
	) THEN
		RAISE EXCEPTION 'Database restore writer roles were not fully unfenced';
	END IF;
END
$database_restore_verify_writer_unfence$;`;
	}

	private verifyReleasableTerminalBlock(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string],
		generationMarker: string
	): string {
		const roleValues = roles.map(role => this.literal(role)).join(', ');
		return `DO $database_restore_verify_terminal_release$
DECLARE
	role_count INTEGER;
	login_count INTEGER;
BEGIN
	IF current_database() <> ${this.literal(target.database)} THEN
		RAISE EXCEPTION 'Database restore terminal release connected to an unexpected database';
	END IF;
	${this.verifyTrustedControlPlaneBoundary(target, roles)}
	${this.verifyGenerationMarker(target, generationMarker)}
	SELECT count(*), count(*) FILTER (WHERE role_state.rolcanlogin)
	INTO role_count, login_count
	FROM pg_roles AS role_state
	WHERE role_state.rolname IN (${roleValues});
	IF role_count <> 3 OR login_count NOT IN (0, 3) THEN
		RAISE EXCEPTION 'Database restore terminal writer boundary is mixed or unknown';
	END IF;
	IF login_count = 0 AND EXISTS (
		SELECT 1 FROM pg_stat_activity AS activity
		WHERE activity.usesysid IN (
				SELECT role_state.oid FROM pg_roles AS role_state
				WHERE role_state.rolname IN (${roleValues})
			)
	) THEN
		RAISE EXCEPTION 'Database restore fenced terminal has writer sessions';
	END IF;
	IF login_count = 0 AND EXISTS (
		SELECT 1 FROM pg_prepared_xacts AS prepared
		WHERE prepared.database = current_database()
	) THEN
		RAISE EXCEPTION 'Database restore fenced terminal has prepared transactions';
	END IF;
	IF login_count = 0 AND EXISTS (
		SELECT 1 FROM pg_stat_activity AS activity
		WHERE activity.usename = ${this.literal(target.adminRole)}
			AND activity.pid <> pg_backend_pid()
	) THEN
		RAISE EXCEPTION 'Database restore fenced terminal has an unexpected admin session';
	END IF;
END
$database_restore_verify_terminal_release$;`;
	}

	private verifyTrustedControlPlaneBoundary(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string]
	): string {
		const protectedRoleValues = [...roles, target.adminRole]
			.map(role => this.literal(role))
			.join(', ');
		return `IF NOT EXISTS (
		SELECT 1 FROM pg_roles AS admin_state
		WHERE admin_state.rolname = ${this.literal(target.adminRole)}
			AND admin_state.rolcanlogin AND admin_state.rolsuper
	) THEN
		RAISE EXCEPTION 'Database restore trusted bootstrap admin boundary drifted';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_roles AS superuser_state
		WHERE superuser_state.rolcanlogin AND superuser_state.rolsuper
			AND superuser_state.rolname <> ${this.literal(target.adminRole)}
	) THEN
		RAISE EXCEPTION 'Database restore has an unexpected login superuser';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_auth_members AS membership
		WHERE membership.member IN (
			SELECT role_state.oid FROM pg_roles AS role_state
			WHERE role_state.rolname IN (${protectedRoleValues})
		) OR membership.roleid IN (
			SELECT role_state.oid FROM pg_roles AS role_state
			WHERE role_state.rolname IN (${protectedRoleValues})
		)
	) THEN
		RAISE EXCEPTION 'Database restore protected role membership drifted';
	END IF;`;
	}

	private verifyApplyBoundaryBlock(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string],
		generationMarker: string
	): string {
		const roleValues = roles.map(role => this.literal(role)).join(', ');
		return `DO $database_restore_verify_apply_boundary$
DECLARE
	role_count INTEGER;
	login_count INTEGER;
BEGIN
	IF current_database() <> ${this.literal(target.database)} THEN
		RAISE EXCEPTION 'Database restore writer fence connected to an unexpected database';
	END IF;
	${this.verifyTrustedControlPlaneBoundary(target, roles)}
	SELECT count(*), count(*) FILTER (WHERE role_state.rolcanlogin)
	INTO role_count, login_count
	FROM pg_roles AS role_state
	WHERE role_state.rolname IN (${roleValues});
	IF role_count <> 3 OR login_count NOT IN (0, 3) THEN
		RAISE EXCEPTION 'Database restore writer apply boundary is mixed or unknown';
	END IF;
	IF login_count = 0 THEN
		${this.verifyGenerationMarker(target, generationMarker)}
	END IF;
END
$database_restore_verify_apply_boundary$;`;
	}

	private verifyReapplyBoundaryBlock(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string],
		generationMarker: string
	): string {
		const roleValues = roles.map(role => this.literal(role)).join(', ');
		return `DO $database_restore_verify_reapply_boundary$
DECLARE
	role_count INTEGER;
	login_count INTEGER;
BEGIN
	IF current_database() <> ${this.literal(target.database)} THEN
		RAISE EXCEPTION 'Database restore writer re-fence connected to an unexpected database';
	END IF;
	${this.verifyTrustedControlPlaneBoundary(target, roles)}
	${this.verifyGenerationMarker(target, generationMarker)}
	SELECT count(*), count(*) FILTER (WHERE role_state.rolcanlogin)
	INTO role_count, login_count
	FROM pg_roles AS role_state
	WHERE role_state.rolname IN (${roleValues});
	IF role_count <> 3 OR login_count NOT IN (0, 3) THEN
		RAISE EXCEPTION 'Database restore writer reapply boundary is mixed or unknown';
	END IF;
END
$database_restore_verify_reapply_boundary$;`;
	}

	private verifyGenerationMarker(
		target: DatabaseRestoreTargetConfiguration,
		generationMarker: string
	): string {
		return `IF (
		SELECT count(*)
		FROM pg_db_role_setting AS role_setting
		JOIN pg_roles AS role_state ON role_state.oid = role_setting.setrole
		CROSS JOIN LATERAL unnest(role_setting.setconfig) AS configured(setting)
		WHERE role_state.rolname = ${this.literal(target.adminRole)}
			AND split_part(configured.setting, '=', 1) = 'winwidget.restore_generation'
	) <> 1 OR NOT EXISTS (
		SELECT 1
		FROM pg_db_role_setting AS role_setting
		JOIN pg_roles AS role_state ON role_state.oid = role_setting.setrole
		CROSS JOIN LATERAL unnest(role_setting.setconfig) AS configured(setting)
		WHERE role_state.rolname = ${this.literal(target.adminRole)}
			AND role_setting.setdatabase = 0
			AND configured.setting = ${this.literal(`winwidget.restore_generation=${generationMarker}`)}
	) THEN
		RAISE EXCEPTION 'Database restore writer fence generation marker drifted';
	END IF;`;
	}

	private targetTransactionGuards(
		target: DatabaseRestoreTargetConfiguration
	): string[] {
		const [namespaceKey, targetKey] = this.advisoryLockKeys(target);
		return [
			`SET LOCAL lock_timeout = ${this.literal(DATABASE_RESTORE_TARGET_LOCK_TIMEOUT)};`,
			`SET LOCAL statement_timeout = ${this.literal(DATABASE_RESTORE_TARGET_STATEMENT_TIMEOUT)};`,
			`SELECT pg_advisory_xact_lock(${namespaceKey}, ${targetKey});`
		];
	}

	private advisoryLockKeys(
		target: DatabaseRestoreTargetConfiguration
	): [number, number] {
		const digest = createHash('sha256')
			.update(`winwidget:database-restore:${target.database}`)
			.digest();
		return [digest.readInt32BE(0), digest.readInt32BE(4)];
	}

	private generationMarker(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string],
		operationId: string
	): string {
		if (!UUID_PATTERN.test(operationId)) {
			throw new Error('Database restore operation generation is invalid');
		}
		return createHash('sha256')
			.update(
				JSON.stringify({
					version: 1,
					database: target.database,
					schema: target.schema,
					adminRole: target.adminRole,
					roles,
					operationId
				})
			)
			.digest('hex');
	}

	private assertGenerationMarker(value: string): void {
		if (!/^[0-9a-f]{64}$/.test(value)) {
			throw new Error(
				'Database restore fence generation marker is invalid'
			);
		}
	}

	private fencedEvidence(
		roles: [string, string, string],
		generationMarker: string
	): DatabaseRestoreWriterFenceEvidence {
		return {
			roles,
			verifiedAt: new Date(),
			evidenceSha256: generationMarker
		};
	}

	private releaseEvidence(
		target: DatabaseRestoreTargetConfiguration,
		roles: [string, string, string],
		generationMarker: string
	): DatabaseRestoreWriterFenceEvidence {
		const verifiedAt = new Date();
		const payload = JSON.stringify({
			version: 2,
			database: target.database,
			schema: target.schema,
			adminRole: target.adminRole,
			roles,
			state: 'OPEN',
			generationMarker,
			verifiedAt: verifiedAt.toISOString()
		});
		return {
			roles,
			verifiedAt,
			evidenceSha256: createHash('sha256').update(payload).digest('hex')
		};
	}

	private roles(
		target: DatabaseRestoreTargetConfiguration
	): [string, string, string] {
		return [target.runtimeRole, target.migrationRole, target.backupRole];
	}

	private identifier(value: string): string {
		return `"${value.replace(/"/g, '""')}"`;
	}

	private literal(value: string): string {
		return `'${value.replace(/'/g, "''")}'`;
	}
}
