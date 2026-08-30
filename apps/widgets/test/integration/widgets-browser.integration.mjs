import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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
		key: 'aiConsultant',
		type: 'ai-consultant',
		pagePath: 'page-ai-consultant',
		asset: 'ai-consultant.js',
		hostId: 'ai-consultant-widget-host',
		buttonAsset: 'ai-consultant-button.png',
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

const BROWSER_NAVIGATION_TIMEOUT_MS = 60_000;
const BROWSER_RESULT_TIMEOUT_MS = 120_000;
const BROWSER_RESOURCE_TIMEOUT_MS = 12_000;

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
	const pendingPageLoads = new Map();
	const pages = new Map();
	const server = createHarnessServer(
		pages,
		pendingPageLoads,
		pendingResults
	);
	const harnessPort = await listenLoopback(server);
	const harnessOrigin = `http://localhost:${harnessPort}`;
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
				nonce,
				cspNonce:
					definition.type === 'ai-consultant'
						? randomBytes(18).toString('base64')
						: ''
			};
			pages.set(pagePath, browserCase);
			const pageLoadPromise = waitForBrowserPageLoad(
				pendingPageLoads,
				nonce
			);
			const resultPromise = waitForBrowserResult(pendingResults, nonce);
			const result = await runChromeCase({
				browserExecutable,
				url: `${harnessOrigin}${pagePath}?browser-smoke=${nonce}`,
				pageLoadPromise,
				resultPromise,
				type: definition.type
			});
			assertBrowserResult(result, definition.type, widget.publicKey);
			results.push(result);
			pages.delete(pagePath);
		}
	} finally {
		for (const pending of pendingPageLoads.values()) {
			pending.reject(new Error('Widgets browser harness stopped'));
		}
		pendingPageLoads.clear();
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

function createHarnessServer(pages, pendingPageLoads, pendingResults) {
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
				const pendingPageLoad = pendingPageLoads.get(browserCase.nonce);
				pendingPageLoads.delete(browserCase.nonce);
				const headers = {
					'cache-control': 'no-store',
					'content-type': 'text/html; charset=utf-8'
				};
				if (browserCase.type === 'ai-consultant') {
					headers['content-security-policy'] = [
						"default-src 'none'",
						`script-src 'nonce-${browserCase.cspNonce}' ${browserCase.serviceOrigin} https://challenges.cloudflare.com`,
						`connect-src 'self' ${browserCase.serviceOrigin} https://challenges.cloudflare.com`,
						`img-src ${browserCase.serviceOrigin}`,
						`style-src 'nonce-${browserCase.cspNonce}'`,
						"style-src-attr 'none'",
						'frame-src https://challenges.cloudflare.com',
						"base-uri 'none'",
						"form-action 'none'"
					].join('; ');
				}
				response.writeHead(200, headers);
				response.end(browserPage(browserCase));
				pendingPageLoad?.resolve();
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
  <script${browserCase.cspNonce ? ` nonce="${browserCase.cspNonce}"` : ''}>
    (function () {
      'use strict';
      var testCase = ${serialized};
      var nativeFetch = window.fetch.bind(window);
      var requests = [];
      var runtimeErrors = [];
      var resourceErrors = [];
      var reported = false;
	  var callbackConfigMode = testCase.type === 'callback' ? 'OFF' : '';
	  var callbackBaseConfig = null;
	  var callbackChallenge = null;
	  var callbackMockLeadCount = 0;
	  var callbackRateLimitOnce = false;
	  var callbackEvents = [];
	  var aiConsentConfig = null;
	  var aiConsentToken = '';
	  var aiSessionConsentTokenMatched = false;
	  var aiSessionConsentTokenMatchCount = 0;
	  var aiRejectNextMessage = false;
	  var turnstileRenderCount = 0;
	  var turnstileExecuteCount = 0;
	  var turnstileRemoveCount = 0;

	  if (testCase.type === 'callback') {
		['ready', 'open', 'close'].forEach(function (name) {
		  document.addEventListener('winwidget:callback:' + name, function (event) {
			callbackEvents.push({ name: name, key: event && event.detail && event.detail.key });
		  });
		});
	  }

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
      window.addEventListener('securitypolicyviolation', function (event) {
        runtimeErrors.push('CSP blocked ' + String(event.violatedDirective || event.effectiveDirective || 'resource'));
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
		var pathname = new URL(String(url), window.location.href).pathname;

		function complete(response) {
          request.status = response.status;
          if (response.ok) return response;
          return response.clone().text().then(function (body) {
            request.responseBody = String(body).slice(0, 2048);
            return response;
          }, function () { return response; });
		}

		function fail(error) {
          request.status = 0;
          request.error = String(error && error.message || error);
          throw error;
		}

		function callbackJsonResponse(status, payload, headers) {
		  return new Response(JSON.stringify(payload), {
			status: status,
			headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {})
		  });
		}

		if (testCase.type === 'callback' && pathname.endsWith('/callback/' + testCase.publicKey + '/config')) {
		  if (callbackConfigMode === 'OFF' && !callbackBaseConfig) {
			  return nativeFetch(input, options).then(function (response) {
				  return response.clone().json().then(function (config) {
					if (config.isActive !== true) {
					  throw new Error('Callback browser base config is inactive');
					}
					callbackBaseConfig = config;
				return delay(300).then(function () {
				  return callbackJsonResponse(response.status, Object.assign({}, config, {
					verificationMode: 'OFF',
					launcherEnabled: false,
					bubbleEnabled: false,
					autoOpenDelay: 0
				  }));
				});
			  });
			}).then(complete, fail);
		  }
		  return delay(150).then(function () {
			return callbackJsonResponse(200, Object.assign({}, callbackBaseConfig, {
			  isActive: true,
			  hasSubmittedByIp: false,
			  filterDuplicates: false,
			  verificationMode: callbackConfigMode,
			  launcherEnabled: false,
			  bubbleEnabled: false,
			  autoOpenDelay: 0
			}));
		  }).then(complete, fail);
		}

		if (testCase.type === 'callback' && callbackConfigMode !== 'OFF' && pathname.endsWith('/verification/start')) {
		  var startPayload = JSON.parse(body || '{}');
		  var expectedStartKey = callbackConfigMode === 'SMS' ? 'phone' : 'email';
		  if (Object.keys(startPayload).sort().join(',') !== expectedStartKey || typeof startPayload[expectedStartKey] !== 'string' || !startPayload[expectedStartKey]) {
			return Promise.resolve(callbackJsonResponse(400, { message: 'Invalid verification start payload' })).then(complete, fail);
		  }
		  if (callbackRateLimitOnce) {
			callbackRateLimitOnce = false;
			return Promise.resolve(callbackJsonResponse(429, { message: 'Повторная отправка кода пока недоступна' }, { 'Retry-After': '3' })).then(complete, fail);
		  }
		  callbackChallenge = {
			id: 'browser-challenge-' + callbackConfigMode.toLowerCase() + '-' + requests.length,
			contact: startPayload[expectedStartKey],
			used: false,
			lead: null
		  };
		  return Promise.resolve(callbackJsonResponse(200, {
			challengeId: callbackChallenge.id,
			expiresAt: new Date(Date.now() + 300000).toISOString(),
			resendAvailableAt: new Date(Date.now() + 60000).toISOString(),
			destinationHint: callbackConfigMode === 'SMS' ? '+7 (***) ***-00-03' : 'b***@example.test'
		  })).then(complete, fail);
		}

		if (testCase.type === 'callback' && callbackConfigMode !== 'OFF' && pathname.endsWith('/lead')) {
		  var leadPayload = JSON.parse(body || '{}');
		  if (!callbackChallenge || leadPayload.challengeId !== callbackChallenge.id || typeof leadPayload.code !== 'string') {
			return Promise.resolve(callbackJsonResponse(400, { message: 'Сначала получите код подтверждения' })).then(complete, fail);
		  }
		  if ((callbackConfigMode === 'SMS' && Object.hasOwn(leadPayload, 'email')) || (callbackConfigMode === 'EMAIL' && leadPayload.email !== callbackChallenge.contact)) {
			return Promise.resolve(callbackJsonResponse(400, { message: 'Invalid email challenge binding' })).then(complete, fail);
		  }
		  if (leadPayload.code !== '123456') {
			return Promise.resolve(callbackJsonResponse(400, { message: 'Неверный код подтверждения' })).then(complete, fail);
		  }
		  if (!callbackChallenge.used) {
			callbackChallenge.used = true;
			callbackMockLeadCount += 1;
			callbackChallenge.lead = { id: 'browser-lead-' + callbackConfigMode.toLowerCase() };
		  }
		  return Promise.resolve(callbackJsonResponse(201, {
			success: true,
			lead: callbackChallenge.lead
		  })).then(complete, fail);
		}

		if (testCase.type === 'ai-consultant' && aiRejectNextMessage && pathname.endsWith('/messages')) {
		  aiRejectNextMessage = false;
		  return Promise.resolve(callbackJsonResponse(401, {
			message: 'Session expired for browser renewal contract'
		  })).then(complete, fail);
		}

		if (testCase.type === 'ai-consultant' && pathname.endsWith('/config')) {
		  return nativeFetch(input, options).then(function (response) {
			return response.clone().json().then(function (config) {
			  aiConsentConfig = config && config.consent;
			  return response;
			});
		  }).then(complete, fail);
		}

		if (testCase.type === 'ai-consultant' && pathname.endsWith('/consents')) {
		  return nativeFetch(input, options).then(function (response) {
			return response.clone().json().then(function (payload) {
			  aiConsentToken = payload && typeof payload.consentToken === 'string' ? payload.consentToken : '';
			  return response;
			}, function () { return response; });
		  }).then(complete, fail);
		}

		if (testCase.type === 'ai-consultant' && pathname.endsWith('/session')) {
		  try {
			var aiSessionPayload = JSON.parse(body || '{}');
			aiSessionConsentTokenMatched = Boolean(aiConsentToken) && aiSessionPayload.consentToken === aiConsentToken;
			if (aiSessionConsentTokenMatched) aiSessionConsentTokenMatchCount += 1;
		  } catch (error) {
			aiSessionConsentTokenMatched = false;
		  }
		}

		return nativeFetch(input, options).then(complete, fail);
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
      } else if (testCase.type === 'ai-consultant') {
        window.winAiConsultantAutoOpen = true;
        window.winAiConsultant = testCase.publicKey;
        var turnstileOptions = null;
        window.turnstile = {
          render: function (_container, options) {
			var completedConsent = requests.find(function (request) {
			  return request.method === 'POST' && new URL(request.url).pathname.endsWith('/consents') && request.status >= 200 && request.status < 300;
			});
			if (!completedConsent) throw new Error('Turnstile rendered before consent was accepted');
			turnstileRenderCount += 1;
            turnstileOptions = options;
            return 'browser-turnstile-widget';
          },
          reset: function () {},
          execute: function () {
			turnstileExecuteCount += 1;
            setTimeout(function () {
			  turnstileOptions.callback('turnstile-browser-' + testCase.publicKey + '-' + turnstileExecuteCount);
            }, 0);
          },
          remove: function () {
			turnstileRemoveCount += 1;
		  }
        };
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
          var timeoutId = setTimeout(function () {
            reject(new Error('Timed out loading image: ' + url));
          }, ${BROWSER_RESOURCE_TIMEOUT_MS});
          image.onload = function () {
            clearTimeout(timeoutId);
            image.naturalWidth > 0 ? resolve() : reject(new Error('Image has no dimensions: ' + url));
          };
          image.onerror = function () {
            clearTimeout(timeoutId);
            reject(new Error('Image failed to load: ' + url));
          };
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
		if (testCase.type === 'ai-consultant') {
			await waitFor(function () {
				return shadow.querySelector('.waic-button-ready');
			}, 'consultant ready');
			var styleNodes = Array.prototype.slice.call(
				shadow.querySelectorAll('style')
			);
			if (
				styleNodes.length !== 2 ||
				styleNodes.some(function (node) {
					return node.nonce !== testCase.cspNonce;
				}) ||
				shadow.host.hasAttribute('style') ||
				shadow.querySelector('[style]')
			) {
				throw new Error('AI consultant strict CSP style contract drifted');
			}
			var consentPanel = await waitFor(function () {
				return shadow.querySelector('.waic-consent');
			}, 'consultant consent panel');
			var consentCheckbox = consentPanel.querySelector(
				'.waic-consent-checkbox'
			);
			var consentButton = consentPanel.querySelector(
				'.waic-consent-submit'
			);
			var consentStatement = consentPanel.querySelector(
				'.waic-consent-copy span'
			);
			var consentLink = consentPanel.querySelector('.waic-consent-link');
			var consentPolicyUrl = aiConsentConfig
				? new URL(aiConsentConfig.privacyUrl)
				: null;
			if (
				!aiConsentConfig ||
				!consentCheckbox ||
				consentCheckbox.required !== true ||
				consentCheckbox.getAttribute('aria-required') !== 'true' ||
				!consentButton ||
				consentButton.disabled !== true ||
				consentButton.textContent !== 'Согласен, продолжить' ||
				!consentStatement ||
				consentStatement.textContent !== aiConsentConfig.statementText ||
				!consentLink ||
				!consentPolicyUrl ||
				(consentPolicyUrl.protocol !== 'http:' &&
					consentPolicyUrl.protocol !== 'https:') ||
				consentPolicyUrl.username ||
				consentPolicyUrl.password ||
				consentLink.href !== consentPolicyUrl.href ||
				shadow.querySelector('.waic-form').hidden !== true ||
				shadow.querySelector('.waic-input').disabled !== true ||
				shadow.querySelector('.waic-turnstile').hidden !== true ||
				turnstileRenderCount !== 0 ||
				turnstileExecuteCount !== 0 ||
				document.querySelector('[data-win-ai-turnstile]') ||
				observedRequest('/consents', 'POST') ||
				observedRequest('/session', 'POST') ||
				observedRequest('/messages', 'POST')
			) {
				throw new Error(
					'AI consultant consent gate or pre-acceptance network boundary drifted'
				);
			}
			click(consentCheckbox, 'consultant consent checkbox');
			if (consentButton.disabled) {
				throw new Error('AI consultant consent action stayed disabled');
			}
			click(consentButton, 'consultant consent action');
			var consentRequest = await waitFor(function () {
				var request = observedRequest('/consents', 'POST');
				return request && request.status === 201 ? request : null;
			}, 'consultant consent acceptance');
			await waitFor(function () {
				return shadow.querySelector('.waic-form').hidden === false;
			}, 'consultant question flow');
			if (
				consentPanel.hidden !== true ||
				shadow.querySelector('.waic-input').disabled !== false ||
				shadow.querySelector('.waic-turnstile').hidden !== false ||
				turnstileRenderCount !== 0 ||
				turnstileExecuteCount !== 0 ||
				observedRequest('/session', 'POST') ||
				observedRequest('/messages', 'POST') ||
				consentRequest.sequence <= observedRequest('/config', 'GET').sequence
			) {
				throw new Error(
					'AI consultant unlocked the question flow out of order'
				);
			}
			var privacyLink = await waitFor(function () {
				return shadow.querySelector('.waic-privacy a');
			}, 'consultant privacy policy');
			if (
				!shadow.querySelector('.waic-privacy').textContent.includes(
					'Не указывайте персональные данные'
				) ||
				!shadow.querySelector('.waic-privacy').textContent.includes(
					'обрабатываются Cloudflare Workers AI'
				) ||
				privacyLink.href !== consentPolicyUrl.href
			) {
				throw new Error('AI consultant privacy notice drifted');
			}
			fill(await waitFor(function () { return shadow.querySelector('.waic-input'); }, 'consultant question'), 'Сколько стоит товар?');
          click(await waitFor(function () { return shadow.querySelector('.waic-send'); }, 'consultant send'), 'consultant send');
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

	  async function exerciseAiConsentRenewal(shadow) {
		var question = 'Нужно ли подтвердить согласие повторно?';
		await waitFor(function () {
		  var input = shadow.querySelector('.waic-input');
		  return input && !input.disabled ? input : null;
		}, 'consultant first response completion');
		var firstConsent = observedRequest('/consents', 'POST');
		var firstSession = observedRequest('/session', 'POST');
		var firstConsentPayload = JSON.parse(firstConsent.body || '{}');
		var firstSessionPayload = JSON.parse(firstSession.body || '{}');
		var renewalStart = requests.length;
		aiRejectNextMessage = true;
		fill(shadow.querySelector('.waic-input'), question);
		click(shadow.querySelector('.waic-send'), 'consultant expired-session send');
		var unauthorizedMessage = await waitFor(function () {
		  return observedRequestAfter(renewalStart, '/messages', 'POST', 401);
		}, 'consultant expired session response');
		var renewedConsentPanel = await waitFor(function () {
		  var panel = shadow.querySelector('.waic-consent');
		  var input = shadow.querySelector('.waic-input');
		  return panel && !panel.hidden && input && input.value === question ? panel : null;
		}, 'consultant renewed consent gate');
		var requestsAfterUnauthorized = requests.slice(unauthorizedMessage.sequence + 1);
		if (
		  shadow.querySelector('.waic-form').hidden !== true ||
		  shadow.querySelector('.waic-input').disabled !== true ||
		  !renewedConsentPanel.querySelector('.waic-consent-checkbox') ||
		  renewedConsentPanel.querySelector('.waic-consent-checkbox').checked ||
		  !renewedConsentPanel.querySelector('.waic-consent-submit').disabled ||
		  !renewedConsentPanel.querySelector('.waic-consent-error').textContent.includes('Срок сессии') ||
		  turnstileRemoveCount !== 1 ||
		  turnstileRenderCount !== 1 ||
		  turnstileExecuteCount !== 1 ||
		  requestsAfterUnauthorized.some(function (request) {
			var pathname = new URL(request.url).pathname;
			return request.method === 'POST' && (pathname.endsWith('/consents') || pathname.endsWith('/session'));
		  })
		) {
		  throw new Error('AI consultant did not fail closed to a fresh consent gate after 401');
		}
		var secondConsentStart = requests.length;
		click(renewedConsentPanel.querySelector('.waic-consent-checkbox'), 'renewed consultant consent checkbox');
		click(renewedConsentPanel.querySelector('.waic-consent-submit'), 'renewed consultant consent action');
		var secondConsent = await waitFor(function () {
		  return observedRequestAfter(secondConsentStart, '/consents', 'POST', 201);
		}, 'renewed consultant consent acceptance');
		await waitFor(function () {
		  return shadow.querySelector('.waic-form').hidden === false;
		}, 'renewed consultant question flow');
		var secondConsentPayload = JSON.parse(secondConsent.body || '{}');
		if (
		  secondConsentPayload.acceptanceId === firstConsentPayload.acceptanceId ||
		  secondConsentPayload.sessionId === firstConsentPayload.sessionId ||
		  shadow.querySelector('.waic-input').value !== question
		) {
		  throw new Error('AI consultant reused consent or session identity after 401');
		}
		var secondSessionStart = requests.length;
		click(shadow.querySelector('.waic-send'), 'renewed consultant send');
		var secondSession = await waitFor(function () {
		  return observedRequestAfter(secondSessionStart, '/session', 'POST', 200);
		}, 'renewed consultant session');
		var renewedMessage = await waitFor(function () {
		  return observedRequestAfter(secondSessionStart, '/messages', 'POST', 200);
		}, 'renewed consultant response');
		var secondSessionPayload = JSON.parse(secondSession.body || '{}');
		var renewedMessagePayload = JSON.parse(renewedMessage.body || '{}');
		if (
		  secondSessionPayload.sessionId !== secondConsentPayload.sessionId ||
		  secondSessionPayload.sessionId === firstSessionPayload.sessionId ||
		  renewedMessagePayload.sessionId !== secondSessionPayload.sessionId ||
		  renewedMessagePayload.message !== question
		) {
		  throw new Error('AI consultant renewed session/message binding drifted');
		}
		await waitFor(function () {
		  return turnstileRenderCount === 2 && turnstileExecuteCount === 2 && aiSessionConsentTokenMatchCount === 2;
		}, 'renewed consultant Turnstile/session binding');
	  }

      function observedRequest(suffix, method) {
        return requests.find(function (request) {
          return request.status !== null && request.method === method && new URL(request.url).pathname.endsWith(suffix);
        });
      }

	  function observedRequestAfter(startIndex, suffix, method, status) {
		return requests.slice(startIndex).find(function (request) {
		  return request.status !== null && request.method === method && new URL(request.url).pathname.endsWith(suffix) && (typeof status !== 'number' || request.status === status);
		});
	  }

	  async function verifyCallbackNativeOpen() {
		var api = await waitFor(function () { return window.winwidgetCallback; }, 'callback public API');
		if (api.key !== testCase.publicKey || api.ready !== false) {
		  throw new Error('Callback public API was not exposed in the loading state');
		}
		if (api.open() !== false) {
		  throw new Error('Callback early open did not report its queued state');
		}
		var initialConfig = await waitFor(function () { return callbackBaseConfig; }, 'callback public config');
		if (initialConfig.isActive !== true) {
		  throw new Error('Callback direct-page config was inactive; check the full-referrer AUTO_OPEN contract');
		}
		await waitFor(function () { return api.ready === true; }, 'callback ready state');
		var host = await waitFor(function () {
		  var candidate = document.getElementById(testCase.hostId);
		  return candidate && candidate.shadowRoot ? candidate : null;
		}, 'callback Shadow DOM');
		await waitFor(function () {
		  return host.shadowRoot.getElementById('callback-widget-overlay').style.display === 'flex';
		}, 'queued callback open');
		var launcher = document.getElementById('callback-widget-button');
		if (!launcher || launcher.style.display !== 'none') {
		  throw new Error('Callback launcherEnabled=false exposed the built-in launcher');
		}
		var launcherIcon = launcher.querySelector('#wcb-btn-icon');
		if (!launcherIcon || launcherIcon.src !== testCase.serviceOrigin + '/widgets/callback-button.png') {
		  throw new Error('Callback launcher icon URL was duplicated or changed');
		}
		if (!callbackEvents.some(function (event) { return event.name === 'ready' && event.key === testCase.publicKey; }) || !callbackEvents.some(function (event) { return event.name === 'open' && event.key === testCase.publicKey; })) {
		  throw new Error('Callback keyed ready/open events were not dispatched');
		}
		var readyCount = callbackEvents.filter(function (event) { return event.name === 'ready'; }).length;
		var refreshed = api.refresh();
		if (!refreshed || typeof refreshed.then !== 'function' || api.ready !== false || await refreshed !== true || window.winwidgetCallback !== api || api.ready !== true) {
		  throw new Error('Callback refresh did not preserve and restore the public API');
		}
		await waitFor(function () {
		  return callbackEvents.filter(function (event) { return event.name === 'ready'; }).length === readyCount + 1;
		}, 'callback refresh ready event');
	  }

	  async function loadCallbackMode(mode) {
		var previousApi = window.winwidgetCallback;
		if (!previousApi || previousApi.destroy() !== true) {
		  throw new Error('Callback runtime did not destroy cleanly before ' + mode);
		}
		if (window.winwidgetCallback || window.__wincallbackScriptRunning) {
		  throw new Error('Callback destroy left public runtime state behind');
		}
		window.wincallbackAutoOpen = false;
		window.winwidgetCallbackAutoOpen = false;
		window.winwidget = { autoOpen: false };
		callbackConfigMode = mode;
		callbackChallenge = null;
		var script = document.createElement('script');
		script.src = testCase.serviceOrigin + '/widgets/callback.js?browser-mode=' + mode.toLowerCase() + '-' + Date.now();
		script.async = true;
		script.setAttribute('data-key', testCase.publicKey);
		var loaded = new Promise(function (resolve, reject) {
		  script.onload = resolve;
		  script.onerror = function () { reject(new Error('Failed to reload callback runtime for ' + mode)); };
		});
		document.body.appendChild(script);
		await loaded;
		var api = await waitFor(function () { return window.winwidgetCallback; }, mode + ' callback API');
		if (api.ready !== false || api.open() !== false) {
		  throw new Error(mode + ' callback did not queue early external open');
		}
		await waitFor(function () { return api.ready === true; }, mode + ' callback ready');
		var host = await waitFor(function () {
		  var candidate = document.getElementById(testCase.hostId);
		  return candidate && candidate.shadowRoot ? candidate : null;
		}, mode + ' callback host');
		await waitFor(function () {
		  return host.shadowRoot.getElementById('callback-widget-overlay').style.display === 'flex';
		}, mode + ' callback open');
		if (document.getElementById('callback-widget-button').style.display !== 'none') {
		  throw new Error(mode + ' callback exposed its disabled launcher');
		}
		return host.shadowRoot;
	  }

	  async function exerciseCallbackOtpPaths() {
		var smsShadow = await loadCallbackMode('SMS');
		fill(await waitFor(function () { return smsShadow.querySelector('input[type="tel"]'); }, 'SMS callback phone'), testCase.phone);
		var smsRequestStart = requests.length;
		click(await waitFor(function () { return findButton(smsShadow, /Получить код/); }, 'SMS get code'), 'SMS get code');
		var firstSmsStart = await waitFor(function () {
		  return observedRequestAfter(smsRequestStart, '/verification/start', 'POST', 200);
		}, 'SMS verification start');
		if (observedRequestAfter(smsRequestStart, '/lead', 'POST')) {
		  throw new Error('Callback sent a lead before an OTP code was entered');
		}
		var firstSmsPayload = JSON.parse(firstSmsStart.body || '{}');
		if (Object.keys(firstSmsPayload).join(',') !== 'phone') {
		  throw new Error('SMS verification start payload drifted');
		}
		var smsCode = await waitFor(function () {
		  var input = smsShadow.querySelector('input[autocomplete="one-time-code"]');
		  return input && input.parentNode.style.display !== 'none' ? input : null;
		}, 'SMS code input');
		if (smsCode.inputMode !== 'numeric' || smsCode.maxLength !== 6) {
		  throw new Error('Callback OTP browser hints drifted');
		}
		var resend = findButton(smsShadow, /Повторить через/);
		if (resend || !Array.prototype.some.call(smsShadow.querySelectorAll('button'), function (button) { return button.disabled && /Повторить через (59|60) с/.test(button.textContent); })) {
		  throw new Error('Callback resend countdown did not start at 60 seconds');
		}

		fill(smsShadow.querySelector('input[type="tel"]'), '+79991119999');
		await waitFor(function () { return smsCode.parentNode.style.display === 'none'; }, 'changed SMS contact invalidation');
		var secondSmsStartIndex = requests.length;
		callbackRateLimitOnce = true;
		click(await waitFor(function () { return findButton(smsShadow, /Получить код/); }, 'SMS get replacement code'), 'SMS get replacement code');
		await waitFor(function () { return observedRequestAfter(secondSmsStartIndex, '/verification/start', 'POST', 429); }, 'SMS Retry-After response');
		await waitFor(function () {
		  return Array.prototype.some.call(smsShadow.querySelectorAll('button'), function (button) {
			return button.disabled && /Повторить через (1|2|3) с/.test(button.textContent);
		  });
		}, 'SMS server Retry-After cooldown');
		var replacementButton = await waitFor(function () { return findButton(smsShadow, /Получить код/); }, 'SMS Retry-After cooldown', 5000);
		var replacementSmsStart = requests.length;
		click(replacementButton, 'SMS get replacement code after cooldown');
		await waitFor(function () { return observedRequestAfter(replacementSmsStart, '/verification/start', 'POST', 200); }, 'replacement SMS challenge');
		smsCode = await waitFor(function () {
		  var input = smsShadow.querySelector('input[autocomplete="one-time-code"]');
		  return input && input.parentNode.style.display !== 'none' ? input : null;
		}, 'replacement SMS code input');

		var invalidLeadStart = requests.length;
		fill(smsCode, '000000');
		click(await waitFor(function () { return findButton(smsShadow, /Подтвердить и отправить/); }, 'SMS invalid code submit'), 'SMS invalid code submit');
		await waitFor(function () { return observedRequestAfter(invalidLeadStart, '/lead', 'POST', 400); }, 'SMS invalid-code response');
		await waitFor(function () { return smsShadow.querySelector('.wcb-err-show'); }, 'SMS invalid-code error');

		var validLeadStart = requests.length;
		fill(smsCode, '123456');
		click(await waitFor(function () { return findButton(smsShadow, /Подтвердить и отправить/); }, 'SMS valid code submit'), 'SMS valid code submit');
		var validSmsLead = await waitFor(function () { return observedRequestAfter(validLeadStart, '/lead', 'POST', 201); }, 'SMS verified lead');
		var validSmsPayload = JSON.parse(validSmsLead.body || '{}');
		if (!validSmsPayload.challengeId || validSmsPayload.code !== '123456' || Object.hasOwn(validSmsPayload, 'email')) {
		  throw new Error('SMS verified lead payload drifted');
		}
		var smsCreatedCount = callbackMockLeadCount;
		await window.fetch(validSmsLead.url, {
		  method: 'POST',
		  headers: { 'Content-Type': 'application/json' },
		  body: validSmsLead.body
		});
		if (callbackMockLeadCount !== smsCreatedCount) {
		  throw new Error('Callback OTP replay created a duplicate mock lead');
		}

		var emailShadow = await loadCallbackMode('EMAIL');
		fill(await waitFor(function () { return emailShadow.querySelector('input[type="tel"]'); }, 'EMAIL callback phone'), '+79991118888');
		fill(await waitFor(function () { return emailShadow.querySelector('input[type="email"]'); }, 'EMAIL verification address'), 'browser@example.test');
		var emailStartIndex = requests.length;
		click(await waitFor(function () { return findButton(emailShadow, /Получить код/); }, 'EMAIL get code'), 'EMAIL get code');
		var emailStart = await waitFor(function () { return observedRequestAfter(emailStartIndex, '/verification/start', 'POST', 200); }, 'EMAIL verification start');
		var emailPayload = JSON.parse(emailStart.body || '{}');
		if (Object.keys(emailPayload).join(',') !== 'email' || emailPayload.email !== 'browser@example.test' || observedRequestAfter(emailStartIndex, '/lead', 'POST')) {
		  throw new Error('EMAIL verification request or pre-code lead contract drifted');
		}
		var emailCode = await waitFor(function () {
		  var input = emailShadow.querySelector('input[autocomplete="one-time-code"]');
		  return input && input.parentNode.style.display !== 'none' ? input : null;
		}, 'EMAIL code input');
		var emailLeadStart = requests.length;
		fill(emailCode, '123456');
		click(await waitFor(function () { return findButton(emailShadow, /Подтвердить и отправить/); }, 'EMAIL valid code submit'), 'EMAIL valid code submit');
		var emailLead = await waitFor(function () { return observedRequestAfter(emailLeadStart, '/lead', 'POST', 201); }, 'EMAIL verified lead');
		var emailLeadPayload = JSON.parse(emailLead.body || '{}');
		if (!emailLeadPayload.challengeId || emailLeadPayload.code !== '123456' || emailLeadPayload.email !== 'browser@example.test' || callbackMockLeadCount !== smsCreatedCount + 1) {
		  throw new Error('EMAIL verified lead lost its challenge binding or duplicated a lead');
		}
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
		if (testCase.type === 'callback') {
		  await verifyCallbackNativeOpen();
		}
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
        var completionSuffix = testCase.type === 'ai-consultant' ? '/messages' : '/lead';
        var completionStatus = testCase.type === 'ai-consultant' ? 200 : 201;
        var completion = await waitFor(function () {
          return observedRequest(completionSuffix, 'POST');
        }, testCase.type + ' completion request', 15000);
        if (completion.status !== completionStatus) {
          throw new Error(testCase.type + ' completion returned ' + completion.status + ', expected ' + completionStatus +
            (completion.responseBody ? ': ' + completion.responseBody : ''));
        }
        var telemetry = await waitFor(function () {
          return requiredTelemetrySequence();
        }, testCase.type + ' completion telemetry', 10000);
        var events = telemetry.map(function (request) { return request.event; });
		if (testCase.type === 'ai-consultant') {
		  if (turnstileRenderCount !== 1 || turnstileExecuteCount !== 1 || !aiSessionConsentTokenMatched || aiSessionConsentTokenMatchCount !== 1) {
			throw new Error('AI consultant consent/Turnstile/session ordering drifted');
		  }
		  await exerciseAiConsentRenewal(shadow);
		}
		if (testCase.type === 'callback') {
		  await exerciseCallbackOtpPaths();
		}
        if (resourceErrors.length) {
          throw new Error('Failed browser resources: ' + resourceErrors.join(', '));
        }
        if (runtimeErrors.length) {
          throw new Error('Browser runtime errors: ' + runtimeErrors.join('; '));
        }
		await report({
		  ok: true,
		  type: testCase.type,
		  requests: requests,
		  events: events,
		  telemetry: telemetry,
		  aiConsentConfig: aiConsentConfig,
		  aiSessionConsentTokenMatched: aiSessionConsentTokenMatched,
		  aiSessionConsentTokenMatchCount: aiSessionConsentTokenMatchCount,
		  turnstileRenderCount: turnstileRenderCount,
		  turnstileExecuteCount: turnstileExecuteCount,
		  turnstileRemoveCount: turnstileRemoveCount
		});
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
  <script src="${browserCase.serviceOrigin}/widgets/${browserCase.asset}" data-key="${browserCase.publicKey}"${browserCase.cspNonce ? ` nonce="${browserCase.cspNonce}"` : ''} async></script>
</body>
</html>`;
}

function waitForBrowserResult(pendingResults, nonce) {
	return new Promise((resolve, reject) => {
		pendingResults.set(nonce, { resolve, reject });
	});
}

function waitForBrowserPageLoad(pendingPageLoads, nonce) {
	return new Promise((resolve, reject) => {
		pendingPageLoads.set(nonce, { resolve, reject });
	});
}

async function runChromeCase({
	browserExecutable,
	url,
	pageLoadPromise,
	resultPromise,
	type
}) {
	const profileDirectory = await mkdtemp(
		join(tmpdir(), 'winwidget-widgets-browser-')
	);
	let browser;
	let stderr = '';
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
		const resultOutcome = resultPromise.then(result => ({ result }));
		const navigationOutcome = await waitForBrowserPhase({
			promises: [
				pageLoadPromise.then(() => ({ pageLoaded: true })),
				resultOutcome,
				browserExit
			],
			timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS,
			timeoutError: () =>
				new Error(
					`Timed out waiting for ${type} browser navigation${stderr ? `: ${stderr}` : ''}`
				)
		});
		if ('result' in navigationOutcome) return navigationOutcome.result;
		const resultOutcomeAfterNavigation = await waitForBrowserPhase({
			promises: [resultOutcome, browserExit],
			timeoutMs: BROWSER_RESULT_TIMEOUT_MS,
			timeoutError: () =>
				new Error(
					`Timed out waiting for ${type} browser result after navigation${stderr ? `: ${stderr}` : ''}`
				)
		});
		return resultOutcomeAfterNavigation.result;
	} finally {
		await stopChild(browser);
		await rm(profileDirectory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100
		});
	}
}

async function waitForBrowserPhase({ promises, timeoutMs, timeoutError }) {
	let timeoutId;
	try {
		const timeout = new Promise((_, reject) => {
			timeoutId = setTimeout(() => reject(timeoutError()), timeoutMs);
		});
		return await Promise.race([...promises, timeout]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
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
	if (expectedType === 'ai-consultant') {
		const aiRequests = suffix =>
			result.requests.filter(request => {
				const pathname = new URL(request.url).pathname;
				return (
					request.method === 'POST' &&
					pathname.endsWith(
						`/ai-consultant/${expectedPublicKey}/${suffix}`
					)
				);
			});
		const consents = aiRequests('consents');
		const sessions = aiRequests('session');
		const messages = aiRequests('messages');
		const [consent, renewedConsent] = consents;
		const [session, renewedSession] = sessions;
		const [message, unauthorizedMessage, renewedMessage] = messages;
		if (
			consents.length !== 2 ||
			sessions.length !== 2 ||
			messages.length !== 3 ||
			config?.status !== 200 ||
			consent?.status !== 201 ||
			session?.status !== 200 ||
			message?.status !== 200 ||
			unauthorizedMessage?.status !== 401 ||
			renewedConsent?.status !== 201 ||
			renewedSession?.status !== 200 ||
			renewedMessage?.status !== 200 ||
			config.sequence >= consent.sequence ||
			consent.sequence >= session.sequence ||
			session.sequence >= message.sequence ||
			message.sequence >= unauthorizedMessage.sequence ||
			unauthorizedMessage.sequence >= renewedConsent.sequence ||
			renewedConsent.sequence >= renewedSession.sequence ||
			renewedSession.sequence >= renewedMessage.sequence
		) {
			throw new Error(
				'Widgets ai-consultant browser HTTP contract drifted'
			);
		}
		if (
			result.requests.some(
				request =>
					request.method === 'POST' &&
					new URL(request.url).pathname.endsWith('/lead')
			)
		) {
			throw new Error(
				'Widgets ai-consultant sent a forbidden lead request'
			);
		}
		let consentPayload;
		let sessionPayload;
		let messagePayload;
		let renewedConsentPayload;
		let renewedSessionPayload;
		let unauthorizedMessagePayload;
		let renewedMessagePayload;
		try {
			consentPayload = JSON.parse(consent.body || '{}');
			sessionPayload = JSON.parse(session.body || '{}');
			messagePayload = JSON.parse(message.body || '{}');
			renewedConsentPayload = JSON.parse(renewedConsent.body || '{}');
			renewedSessionPayload = JSON.parse(renewedSession.body || '{}');
			unauthorizedMessagePayload = JSON.parse(
				unauthorizedMessage.body || '{}'
			);
			renewedMessagePayload = JSON.parse(renewedMessage.body || '{}');
		} catch {
			throw new Error(
				'Widgets ai-consultant consent/session/message payload is not JSON'
			);
		}
		let consentPrivacyUrl;
		try {
			consentPrivacyUrl = new URL(result.aiConsentConfig?.privacyUrl);
		} catch {
			consentPrivacyUrl = null;
		}
		const requestIdPattern =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		if (
			!requestIdPattern.test(consentPayload.acceptanceId) ||
			consentPayload.accepted !== true ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(consentPayload.sessionId) ||
			!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(
				result.aiConsentConfig?.documentVersion || ''
			) ||
			!/^[a-f0-9]{64}$/.test(result.aiConsentConfig?.documentHash || '') ||
			typeof result.aiConsentConfig?.statementText !== 'string' ||
			!result.aiConsentConfig.statementText ||
			!consentPrivacyUrl ||
			!['http:', 'https:'].includes(consentPrivacyUrl.protocol) ||
			consentPrivacyUrl.username ||
			consentPrivacyUrl.password ||
			consentPayload.documentVersion !==
				result.aiConsentConfig.documentVersion ||
			consentPayload.documentHash !==
				result.aiConsentConfig.documentHash ||
			Object.keys(consentPayload).sort().join(',') !==
				'acceptanceId,accepted,documentHash,documentVersion,sessionId' ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(sessionPayload.sessionId) ||
			sessionPayload.sessionId !== consentPayload.sessionId ||
			sessionPayload.turnstileToken !==
				`turnstile-browser-${expectedPublicKey}-1` ||
			typeof sessionPayload.consentToken !== 'string' ||
			!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
				sessionPayload.consentToken
			) ||
			sessionPayload.consentToken.length > 3072 ||
			result.aiSessionConsentTokenMatched !== true ||
			result.aiSessionConsentTokenMatchCount !== 2 ||
			result.turnstileRenderCount !== 2 ||
			result.turnstileExecuteCount !== 2 ||
			result.turnstileRemoveCount !== 1 ||
			Object.keys(sessionPayload).sort().join(',') !==
				'consentToken,sessionId,turnstileToken' ||
			!requestIdPattern.test(messagePayload.requestId) ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(messagePayload.sessionId) ||
			messagePayload.sessionId !== sessionPayload.sessionId ||
			typeof messagePayload.sessionToken !== 'string' ||
			messagePayload.sessionToken.length < 80 ||
			messagePayload.message !== 'Сколько стоит товар?' ||
			!Array.isArray(messagePayload.history) ||
			messagePayload.history.length !== 0 ||
			Object.keys(messagePayload).sort().join(',') !==
				'history,message,requestId,sessionId,sessionToken' ||
			!requestIdPattern.test(renewedConsentPayload.acceptanceId) ||
			renewedConsentPayload.acceptanceId === consentPayload.acceptanceId ||
			renewedConsentPayload.accepted !== true ||
			renewedConsentPayload.sessionId === consentPayload.sessionId ||
			renewedConsentPayload.documentVersion !==
				consentPayload.documentVersion ||
			renewedConsentPayload.documentHash !== consentPayload.documentHash ||
			Object.keys(renewedConsentPayload).sort().join(',') !==
				'acceptanceId,accepted,documentHash,documentVersion,sessionId' ||
			renewedSessionPayload.sessionId !==
				renewedConsentPayload.sessionId ||
			renewedSessionPayload.sessionId === sessionPayload.sessionId ||
			renewedSessionPayload.turnstileToken !==
				`turnstile-browser-${expectedPublicKey}-2` ||
			!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
				renewedSessionPayload.consentToken
			) ||
			renewedSessionPayload.consentToken === sessionPayload.consentToken ||
			Object.keys(renewedSessionPayload).sort().join(',') !==
				'consentToken,sessionId,turnstileToken' ||
			!requestIdPattern.test(unauthorizedMessagePayload.requestId) ||
			unauthorizedMessagePayload.sessionId !== sessionPayload.sessionId ||
			unauthorizedMessagePayload.message !==
				'Нужно ли подтвердить согласие повторно?' ||
			!requestIdPattern.test(renewedMessagePayload.requestId) ||
			renewedMessagePayload.requestId ===
				unauthorizedMessagePayload.requestId ||
			renewedMessagePayload.sessionId !==
				renewedSessionPayload.sessionId ||
			renewedMessagePayload.message !==
				unauthorizedMessagePayload.message ||
			!Array.isArray(renewedMessagePayload.history) ||
			renewedMessagePayload.history.length !== 0 ||
			Object.keys(renewedMessagePayload).sort().join(',') !==
				'history,message,requestId,sessionId,sessionToken'
		) {
			throw new Error('Widgets ai-consultant message payload drifted');
		}
	} else {
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
	const exitPromise = new Promise(resolve => child.once('exit', resolve));
	child.kill('SIGTERM');
	const exited = await Promise.race([
		exitPromise,
		new Promise(resolve => setTimeout(() => resolve(false), 3000))
	]);
	if (exited !== false) return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill('SIGKILL');
	const killed = await Promise.race([
		exitPromise,
		new Promise(resolve => setTimeout(() => resolve(false), 3000))
	]);
	if (
		killed === false &&
		child.exitCode === null &&
		child.signalCode === null
	) {
		throw new Error('Headless Chrome did not exit after SIGKILL');
	}
}
