import {
	classifyOperationsCoreSourcePresence,
	OperationsCoreCutoverError,
	parseOperationsCoreCutoverArgs
} from './operations-cutover-main';

const REVISION = 'a'.repeat(40);
const SHA = 'b'.repeat(64);

describe('Operations Core cutover arguments', () => {
	it('accepts the minimal forward-only actions', () => {
		expect(parseOperationsCoreCutoverArgs(['status'])).toEqual({
			action: 'status'
		});
		expect(
			parseOperationsCoreCutoverArgs([
				'export',
				'--revision',
				REVISION,
				'--file',
				'/tmp/operations.json'
			])
		).toEqual({
			action: 'export',
			revision: REVISION,
			file: '/tmp/operations.json'
		});
		expect(
			parseOperationsCoreCutoverArgs([
				'activate',
				'--revision',
				REVISION,
				'--sha256',
				SHA,
				'--notes',
				'0',
				'--events',
				'17'
			])
		).toEqual({
			action: 'activate',
			revision: REVISION,
			sha256: SHA,
			notes: 0,
			events: 17
		});
	});

	it('has no abort or rollback action', () => {
		expect(() => parseOperationsCoreCutoverArgs(['abort'])).toThrow(
			OperationsCoreCutoverError
		);
	});

	it('classifies only exact present or exact removed Core sources', () => {
		const present = {
			notesPresent: true,
			adminEventLogsPresent: true,
			statePresent: true,
			writeGuardPresent: true,
			stateGuardPresent: true,
			ownershipTypePresent: true
		};
		expect(classifyOperationsCoreSourcePresence(present)).toBe('present');
		expect(
			classifyOperationsCoreSourcePresence({
				...present,
				notesPresent: false,
				adminEventLogsPresent: false,
				statePresent: false,
				writeGuardPresent: false,
				stateGuardPresent: false,
				ownershipTypePresent: false
			})
		).toBe('removed');
		expect(() =>
			classifyOperationsCoreSourcePresence({
				...present,
				notesPresent: false
			})
		).toThrow(OperationsCoreCutoverError);
	});
});
