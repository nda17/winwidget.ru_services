import { ReportingJsonLogger } from './reporting-json.logger';

describe('ReportingJsonLogger credential redaction', () => {
	const write = jest
		.spyOn(process.stderr, 'write')
		.mockImplementation(() => true);

	afterEach(() => write.mockClear());
	afterAll(() => write.mockRestore());

	it('does not write RabbitMQ credentials from connection errors', () => {
		new ReportingJsonLogger().error(
			'connection failed amqps://reporting:super-secret@rabbitmq:5671/vhost'
		);
		const line = String(write.mock.calls[0][0]);
		expect(line).toContain('[RABBITMQ_URL_REDACTED]');
		expect(line).not.toContain('super-secret');
	});

	it('redacts PostgreSQL credentials and Bearer tokens from fatal errors', () => {
		new ReportingJsonLogger().fatal(
			new Error(
				'bootstrap failed postgresql://reporting:db-secret@127.0.0.1:55435/reporting Bearer access-secret'
			),
			'Bootstrap'
		);
		const line = String(write.mock.calls[0][0]);
		expect(line).toContain('[DATABASE_URL_REDACTED]');
		expect(line).toContain('Bearer [REDACTED]');
		expect(line).not.toContain('db-secret');
		expect(line).not.toContain('access-secret');
		expect(JSON.parse(line)).toMatchObject({
			level: 'fatal',
			service: 'reporting',
			context: 'Bootstrap'
		});
	});
});
