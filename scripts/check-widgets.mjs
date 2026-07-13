import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const widgetDir = join(root, 'public/widgets');

const files = [
	'wheel.js',
	'quiz.js',
	'callback.js',
	'timer.js',
	'stop-offer.js',
	'online-consultant.js',
	'calculator.js',
	'helpers/winwidget-phone.js'
];

for (const file of files) {
	const fullPath = join(widgetDir, file);

	await stat(fullPath);

	const result = spawnSync(process.execPath, ['--check', fullPath], {
		stdio: 'inherit'
	});

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}

	console.log(`widgets: checked ${file}`);
}
