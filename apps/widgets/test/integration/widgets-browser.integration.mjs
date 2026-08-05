import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSER_CASES = [
	{
		key: 'wheel',
		type: 'wheel',
		pagePath: 'page-wheel',
		asset: 'wheel.js',
		hostId: 'wheel-widget-host',
		buttonAsset: 'gift-button.png',
		expectsPhoneHelper: true
	},
	{
		key: 'quiz',
		type: 'quiz',
		pagePath: 'page-quiz',
		asset: 'quiz.js',
		hostId: 'quiz-widget-host',
		buttonAsset: 'quiz-button.png',
		expectsPhoneHelper: true
	},
	{
		key: 'callback',
		type: 'callback',
		pagePath: 'page-callback',
		asset: 'callback.js',
		hostId: 'callback-widget-host',
		buttonAsset: 'callback-button.png',
		expectsPhoneHelper: true
	},
	{
		key: 'timer',
		type: 'timer',
		pagePath: 'page-timer',
		asset: 'timer.js',
		hostId: 'timer-widget-host',
		buttonAsset: 'timer-button.png',
		expectsPhoneHelper: true
	},
	{
		key: 'stopOffer',
		type: 'stop-offer',
		pagePath: 'page-stop-offer',
		asset: 'stop-offer.js',
		hostId: 'stop-offer-widget-host',
		buttonAsset: null,
		expectsPhoneHelper: true
	},
	{
		key: 'onlineConsultant',
		type: 'online-consultant',
		pagePath: 'page-online-consultant',
		asset: 'online-consultant.js',
		hostId: 'online-consultant-widget-host',
		buttonAsset: 'online-consultant-button.png',
		expectsPhoneHelper: false
	},
	{
		key: 'calculator',
		type: 'calculator',
		pagePath: 'page-calculator',
		asset: 'calculator.js',
		hostId: 'calculator-widget-host',
		buttonAsset: 'calculator-button.png',
		expectsPhoneHelper: true
	}
];

const BROWSER_TIMEOUT_MS = 25_000;

export async function runWidgetsBrowserIntegration({
	appPort,
	widgets,
	corsAllowedOrigins
}) {
	const browserExecutable = process.env.WIDGETS_BROWSER_EXECUTABLE?.trim();
	if (!browserExecutable) {
		throw new Error(
			'WIDGETS_BROWSER_EXECUTABLE is required for Widgets browser integration'
		);
	}
	if (!Number.isInteger(appPort) || appPort < 1) {
		throw new Error(
			'Widgets browser integration requires a valid appPort'
		);
	}
	if (!Array.isArray(corsAllowedOrigins) || !corsAllowedOrigins.length) {
		throw new Error(
			'Widgets browser integration requires the exact CORS allowlist fixture'
		);
	}

	const pendingResults = new Map();
	const pages = new Map();
	const server = createHarnessServer(pages, pendingResults);
	const harnessPort = await listenLoopback(server);
	const harnessOrigin = `http://127.0.0.1:${harnessPort}`;
	if (corsAllowedOrigins.includes(harnessOrigin)) {
		throw new Error(
			`Widgets browser harness origin must be outside the CORS allowlist: ${harnessOrigin}`
		);
	}
	const results = [];

	try {
		for (const [index, definition] of BROWSER_CASES.entries()) {
			const widget = widgets[definition.key];
			if (!widget?.publicKey) {
				throw new Error(
					`Widgets browser integration is missing ${definition.type}`
				);
			}
			const nonce = randomUUID();
			const pagePath = `/${definition.pagePath}/${widget.publicKey}`;
			const browserCase = {
				...definition,
				publicKey: widget.publicKey,
				phone: `+79991110${String(index + 1).padStart(3, '0')}`,
				serviceOrigin: `http://127.0.0.1:${appPort}`,
				nonce
			};
			pages.set(pagePath, browserCase);
			const resultPromise = waitForBrowserResult(pendingResults, nonce);
			const result = await runChromeCase({
				browserExecutable,
				url: `${harnessOrigin}${pagePath}?browser-smoke=${nonce}`,
				resultPromise,
				type: definition.type
			});
			assertBrowserResult(result, definition.type, widget.publicKey);
			results.push(result);
			pages.delete(pagePath);
		}
	} finally {
		for (const pending of pendingResults.values()) {
			pending.reject(new Error('Widgets browser harness stopped'));
		}
		pendingResults.clear();
		await closeServer(server);
	}

	console.log(
		'Widgets real-browser integration passed for all seven runtime types'
	);
	return results;
}

function createHarnessServer(pages, pendingResults) {
	return createServer(async (request, response) => {
		try {
			const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
			if (
				request.method === 'GET' &&
				requestUrl.pathname === '/favicon.ico'
			) {
				response.writeHead(204).end();
				return;
			}
			const browserCase = pages.get(requestUrl.pathname);
			if (request.method === 'GET' && browserCase) {
				response.writeHead(200, {
					'cache-control': 'no-store',
					'content-type': 'text/html; charset=utf-8'
				});
				response.end(browserPage(browserCase));
				return;
			}
			const resultMatch = requestUrl.pathname.match(
				/^\/__widgets_browser_result\/([a-f0-9-]+)$/
			);
			if (request.method === 'POST' && resultMatch) {
				const pending = pendingResults.get(resultMatch[1]);
				if (!pending) {
					response.writeHead(404).end();
					return;
				}
				const result = await readJson(request, 256 * 1024);
				pendingResults.delete(resultMatch[1]);
				pending.resolve(result);
				response.writeHead(204).end();
				return;
			}
			response.writeHead(404).end();
		} catch (error) {
			response.writeHead(500, {
				'content-type': 'application/json; charset=utf-8'
			});
			response.end(
				JSON.stringify({
					message:
						error instanceof Error ? error.message : 'harness failed'
				})
			);
		}
	});
}

function browserPage(browserCase) {
	const serialized = JSON.stringify(browserCase).replace(/</g, '\\u003c');
	return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Widgets browser integration</title>
</head>
<body>
  <main>Widgets browser integration</main>
  <script>
    (function () {
      'use strict';
      var testCase = ${serialized};
      var nativeFetch = window.fetch.bind(window);
      var requests = [];
      var runtimeErrors = [];
      var resourceErrors = [];
      var reported = false;

      window.addEventListener('error', function (event) {
        var target = event.target;
        if (target && target !== window && (target.src || target.href)) {
          resourceErrors.push(String(target.src || target.href));
          return;
        }
        runtimeErrors.push(String(event.message || 'window error'));
      }, true);
      window.addEventListener('unhandledrejection', function (event) {
        runtimeErrors.push(String(event.reason && event.reason.message || event.reason || 'unhandled rejection'));
      });

      window.fetch = function (input, options) {
        var url = typeof input === 'string' ? input : input.url;
        var method = String(options && options.method || input && input.method || 'GET').toUpperCase();
        var body = options && typeof options.body === 'string' ? options.body : null;
        var request = {
          sequence: requests.length,
          url: String(url),
          method: method,
          status: null,
          body: body
        };
        requests.push(request);
        return nativeFetch(input, options).then(function (response) {
          request.status = response.status;
          if (response.ok) return response;
          return response.clone().text().then(function (body) {
            request.responseBody = String(body).slice(0, 2048);
            return response;
          }, function () { return response; });
        }, function (error) {
          request.status = 0;
          request.error = String(error && error.message || error);
          throw error;
        });
      };

      if (testCase.type === 'wheel') {
        window.winwidget = testCase.publicKey;
        window.winwidgetAutoOpen = true;
      } else if (testCase.type === 'quiz') {
        window.winquizAutoOpen = true;
      } else if (testCase.type === 'callback') {
        window.wincallbackAutoOpen = true;
        window.winwidgetCallbackAutoOpen = true;
        window.winwidget = { autoOpen: true };
      } else if (testCase.type === 'timer') {
        window.wintimerAutoOpen = true;
      } else if (testCase.type === 'stop-offer') {
        window.winstopofferAutoOpen = true;
      } else if (testCase.type === 'online-consultant') {
        window.winonlineconsultantAutoOpen = true;
        window.winonlineconsultant = testCase.publicKey;
      } else if (testCase.type === 'calculator') {
        window.wincalculatorAutoOpen = true;
        window.wincalculator = testCase.publicKey;
      }

      function delay(milliseconds) {
        return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
      }

      async function waitFor(read, label, timeout) {
        var deadline = Date.now() + (timeout || 12000);
        while (Date.now() < deadline) {
          var value = read();
          if (value) return value;
          await delay(50);
        }
        throw new Error('Timed out waiting for ' + label);
      }

      function fill(input, value) {
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function click(element, label) {
        if (!element) throw new Error('Missing ' + label);
        element.click();
      }

      function findButton(root, pattern) {
        return Array.prototype.find.call(root.querySelectorAll('button'), function (button) {
          return pattern.test(String(button.textContent || '').trim()) && !button.disabled;
        });
      }

      function loadImage(url) {
        return new Promise(function (resolve, reject) {
          var image = new Image();
          image.onload = function () {
            image.naturalWidth > 0 ? resolve() : reject(new Error('Image has no dimensions: ' + url));
          };
          image.onerror = function () { reject(new Error('Image failed to load: ' + url)); };
          image.src = url;
        });
      }

      async function interact(shadow) {
        if (testCase.type === 'wheel') {
          fill(await waitFor(function () { return shadow.getElementById('name-input'); }, 'wheel name'), 'Browser User');
          fill(await waitFor(function () { return shadow.getElementById('phone-input'); }, 'wheel phone'), testCase.phone);
          var policy = await waitFor(function () { return shadow.getElementById('policy-input'); }, 'wheel policy');
          if (!policy.checked) policy.click();
          click(await waitFor(function () { return shadow.getElementById('spin'); }, 'wheel spin'), 'wheel spin');
          return;
        }
        if (testCase.type === 'quiz') {
          click(await waitFor(function () { return shadow.getElementById('wq-start'); }, 'quiz start'), 'quiz start');
          for (var question = 0; question < 12; question += 1) {
            var submit = shadow.getElementById('wq-submit');
            if (submit) break;
            click(await waitFor(function () { return shadow.querySelector('.wq-opt'); }, 'quiz option'), 'quiz option');
			var next = shadow.querySelector('.wq-next-btn');
			if (next && !next.disabled) click(next, 'quiz next');
            await delay(400);
          }
          fill(await waitFor(function () { return shadow.getElementById('wq-phone'); }, 'quiz phone'), testCase.phone);
          click(await waitFor(function () { return shadow.getElementById('wq-submit'); }, 'quiz submit'), 'quiz submit');
          return;
        }
        if (testCase.type === 'callback') {
          fill(await waitFor(function () { return shadow.querySelector('input[type="tel"]'); }, 'callback phone'), testCase.phone);
          click(await waitFor(function () { return findButton(shadow, /Заказать звонок|Отправить/); }, 'callback submit'), 'callback submit');
          return;
        }
        if (testCase.type === 'timer') {
          fill(await waitFor(function () { return shadow.querySelector('input[type="tel"]'); }, 'timer phone'), testCase.phone);
          click(await waitFor(function () { return findButton(shadow, /Получить предложение|Отправить/); }, 'timer submit'), 'timer submit');
          return;
        }
        if (testCase.type === 'stop-offer') {
          fill(await waitFor(function () { return shadow.querySelector('input[type="tel"]'); }, 'stop-offer phone'), testCase.phone);
          click(await waitFor(function () { return findButton(shadow, /Забрать скидку|Отправить/); }, 'stop-offer submit'), 'stop-offer submit');
          return;
        }
        if (testCase.type === 'online-consultant') {
          click(await waitFor(function () { return shadow.querySelector('.woc-action'); }, 'consultant action'), 'consultant action');
          fill(await waitFor(function () { return shadow.getElementById('woc-phone'); }, 'consultant phone'), testCase.phone);
          click(await waitFor(function () { return shadow.getElementById('woc-submit'); }, 'consultant submit'), 'consultant submit');
          return;
        }
        if (testCase.type === 'calculator') {
          click(await waitFor(function () { return shadow.getElementById('wwc-start'); }, 'calculator start'), 'calculator start');
          var select = await waitFor(function () { return shadow.querySelector('.wwc-select'); }, 'calculator select');
          select.value = select.options[1].value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          click(await waitFor(function () { return shadow.getElementById('wwc-calculate'); }, 'calculator calculate'), 'calculator calculate');
          fill(await waitFor(function () { return shadow.getElementById('wwc-phone'); }, 'calculator phone'), testCase.phone);
          click(await waitFor(function () { return shadow.getElementById('wwc-submit'); }, 'calculator submit'), 'calculator submit');
          return;
        }
        throw new Error('Unsupported browser case ' + testCase.type);
      }

      function observedRequest(suffix, method) {
        return requests.find(function (request) {
          return request.status !== null && request.method === method && new URL(request.url).pathname.endsWith(suffix);
        });
      }

      function telemetryRequests() {
        return requests.filter(function (request) {
          return request.method === 'POST' && new URL(request.url).pathname.indexOf('/api/v1/widget-events/') === 0;
        }).map(function (request) {
          var event = null;
          try { event = JSON.parse(request.body || '{}').event; } catch (error) {}
          return {
            event: event,
            sequence: request.sequence,
            status: request.status
          };
        }).filter(function (request) { return Boolean(request.event); });
      }

      function requiredTelemetrySequence() {
        var telemetry = telemetryRequests();
        var required = ['IMPRESSION', 'START', 'COMPLETE'];
        var selected = [];
        var previousSequence = -1;
        for (var index = 0; index < required.length; index += 1) {
          var event = required[index];
          var request = telemetry.find(function (candidate) {
            return candidate.event === event && candidate.sequence > previousSequence;
          });
          if (!request || request.status === null) return null;
          if (request.status !== 204) {
            throw new Error(testCase.type + ' telemetry ' + event + ' returned ' + request.status + ', expected 204');
          }
          selected.push(request);
          previousSequence = request.sequence;
        }
        return selected;
      }

      async function report(payload) {
        if (reported) return;
        reported = true;
        try {
          await nativeFetch('/__widgets_browser_result/' + testCase.nonce, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          });
        } catch (error) {}
      }

      async function run() {
        var host = await waitFor(function () {
          var candidate = document.getElementById(testCase.hostId);
          return candidate && candidate.shadowRoot ? candidate : null;
        }, testCase.type + ' Shadow DOM');
        var shadow = host.shadowRoot;
        await waitFor(function () {
          return observedRequest('/config', 'GET');
        }, testCase.type + ' config request');
        if (testCase.expectsPhoneHelper) {
          await waitFor(function () {
            return window.winwidgetPhone && window.libphonenumber;
          }, testCase.type + ' phone helper');
        }
        if (testCase.buttonAsset) {
          await loadImage(testCase.serviceOrigin + '/widgets/' + testCase.buttonAsset);
        }
        await interact(shadow);
        var lead = await waitFor(function () {
          return observedRequest('/lead', 'POST');
        }, testCase.type + ' lead request', 15000);
        if (lead.status !== 201) {
          throw new Error(testCase.type + ' lead returned ' + lead.status + ', expected 201' +
            (lead.responseBody ? ': ' + lead.responseBody : ''));
        }
        var telemetry = await waitFor(function () {
          return requiredTelemetrySequence();
        }, testCase.type + ' completion telemetry', 10000);
        var events = telemetry.map(function (request) { return request.event; });
        if (resourceErrors.length) {
          throw new Error('Failed browser resources: ' + resourceErrors.join(', '));
        }
        if (runtimeErrors.length) {
          throw new Error('Browser runtime errors: ' + runtimeErrors.join('; '));
        }
        await report({ ok: true, type: testCase.type, requests: requests, events: events, telemetry: telemetry });
      }

      run().catch(function (error) {
        report({
          ok: false,
          type: testCase.type,
          error: String(error && error.stack || error),
          requests: requests,
          runtimeErrors: runtimeErrors,
          resourceErrors: resourceErrors
        });
      });
    })();
  </script>
  <script src="${browserCase.serviceOrigin}/widgets/${browserCase.asset}" data-key="${browserCase.publicKey}" async></script>
</body>
</html>`;
}

function waitForBrowserResult(pendingResults, nonce) {
	return new Promise((resolve, reject) => {
		pendingResults.set(nonce, { resolve, reject });
	});
}

async function runChromeCase({
	browserExecutable,
	url,
	resultPromise,
	type
}) {
	const profileDirectory = await mkdtemp(
		join(tmpdir(), 'winwidget-widgets-browser-')
	);
	let browser;
	let stderr = '';
	let timeoutId;
	try {
		const args = [
			'--headless=new',
			'--disable-background-networking',
			'--disable-dev-shm-usage',
			'--disable-extensions',
			'--disable-gpu',
			'--no-default-browser-check',
			'--no-first-run',
			'--remote-debugging-port=0',
			`--user-data-dir=${profileDirectory}`,
			'--window-size=1280,900',
			...(process.platform === 'linux' ? ['--no-sandbox'] : []),
			url
		];
		browser = spawn(browserExecutable, args, {
			stdio: ['ignore', 'ignore', 'pipe']
		});
		browser.stderr?.on('data', chunk => {
			stderr = `${stderr}${chunk.toString()}`.slice(-20_000);
		});
		const browserExit = new Promise((_, reject) => {
			browser.once('error', reject);
			browser.once('exit', code => {
				reject(
					new Error(
						`Headless Chrome exited before ${type} result (code=${code})${stderr ? `: ${stderr}` : ''}`
					)
				);
			});
		});
		const timeout = new Promise((_, reject) => {
			timeoutId = setTimeout(
				() =>
					reject(
						new Error(
							`Timed out waiting for ${type} browser result${stderr ? `: ${stderr}` : ''}`
						)
					),
				BROWSER_TIMEOUT_MS
			);
		});
		return await Promise.race([resultPromise, browserExit, timeout]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		await stopChild(browser);
		await rm(profileDirectory, { recursive: true, force: true });
	}
}

function assertBrowserResult(result, expectedType, expectedPublicKey) {
	if (!result || result.ok !== true || result.type !== expectedType) {
		throw new Error(
			`Widgets ${expectedType} browser integration failed: ${result?.error || JSON.stringify(result)}`
		);
	}
	const config = result.requests.find(
		request =>
			request.method === 'GET' &&
			new URL(request.url).pathname.endsWith('/config')
	);
	const lead = result.requests.find(
		request =>
			request.method === 'POST' &&
			new URL(request.url).pathname.endsWith('/lead')
	);
	if (config?.status !== 200 || lead?.status !== 201) {
		throw new Error(
			`Widgets ${expectedType} browser HTTP contract drifted`
		);
	}
	if (expectedType === 'online-consultant') {
		let leadPayload;
		try {
			leadPayload = JSON.parse(lead.body || '{}');
		} catch {
			throw new Error(
				'Widgets online-consultant lead payload is not JSON'
			);
		}
		if (leadPayload.key !== expectedPublicKey) {
			throw new Error(
				'Widgets online-consultant lead payload lost the cached-client key field'
			);
		}
	}
	let previousSequence = -1;
	for (const event of ['IMPRESSION', 'START', 'COMPLETE']) {
		const telemetry = result.telemetry?.find(
			request =>
				request.event === event && request.sequence > previousSequence
		);
		if (!telemetry || telemetry.status !== 204) {
			throw new Error(
				`Widgets ${expectedType} browser telemetry ${event} did not return 204 in dispatch order`
			);
		}
		previousSequence = telemetry.sequence;
	}
}

async function listenLoopback(server, port = 0) {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Could not allocate Widgets browser harness port');
	}
	return address.port;
}

async function closeServer(server) {
	if (!server.listening) return;
	await new Promise((resolve, reject) => {
		server.close(error => (error ? reject(error) : resolve()));
	});
}

async function readJson(request, limit) {
	let size = 0;
	const chunks = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > limit) throw new Error('Browser result is too large');
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function stopChild(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null)
		return;
	child.kill('SIGTERM');
	const exited = await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise(resolve => setTimeout(() => resolve(false), 3000))
	]);
	if (exited !== false) return;
	child.kill('SIGKILL');
	await new Promise(resolve => child.once('exit', resolve));
}
