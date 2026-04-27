import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const sourceDir = join(root, 'widgets-src');
const outputDir = join(root, 'public/widgets');

const widgetEntries = [
	['wheel.js', 'wheel.js'],
	['quiz.js', 'quiz.js'],
	['callback.js', 'callback.js'],
	['timer.js', 'timer.js'],
	['helpers/winwidget-phone.js', 'helpers/winwidget-phone.js']
];

const copiedAssets = [
	['helpers/libphonenumber-min.js', 'helpers/libphonenumber-min.js']
];

const formatSize = bytes => `${(bytes / 1024).toFixed(1)} KB`;

for (const [input, output] of widgetEntries) {
	const entryPoint = join(sourceDir, input);
	const outfile = join(outputDir, output);

	await mkdir(dirname(outfile), { recursive: true });

	await build({
		entryPoints: [entryPoint],
		outfile,
		bundle: false,
		minify: true,
		legalComments: 'none',
		target: ['es2018'],
		logLevel: 'silent'
	});

	const [before, after] = await Promise.all([
		stat(entryPoint),
		stat(outfile)
	]);
	const saved = before.size - after.size;
	const percent = before.size
		? Math.round((saved / before.size) * 100)
		: 0;

	console.log(
		`widgets: ${output} ${formatSize(before.size)} -> ${formatSize(after.size)} (${percent}% smaller)`
	);
}

for (const [input, output] of copiedAssets) {
	const source = join(sourceDir, input);
	const destination = join(outputDir, output);

	await mkdir(dirname(destination), { recursive: true });
	await copyFile(source, destination);

	const size = await stat(destination);
	console.log(`widgets: copied ${output} (${formatSize(size.size)})`);
}
