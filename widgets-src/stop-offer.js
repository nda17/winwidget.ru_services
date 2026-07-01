(function () {
	'use strict';

	if (window.__winstopofferScriptRunning) return;
	window.__winstopofferScriptRunning = true;

	var _currentScript = document.currentScript;
	var API_BASE = (function () {
		try {
			var src = new URL(
				_currentScript && _currentScript.src
					? _currentScript.src
					: location.href
			);
			return src.origin + '/api';
		} catch (e) {
			return 'https://winwidget.ru/api';
		}
	})();
	var KEY =
		(_currentScript && _currentScript.getAttribute('data-key')) ||
		window.winstopoffer ||
		'';
	if (!KEY) {
		delete window.__winstopofferScriptRunning;
		return;
	}

	function getWidgetAssetUrl(fileName) {
		try {
			var src = new URL(
				_currentScript && _currentScript.src
					? _currentScript.src
					: location.href
			);
			src.pathname = src.pathname.replace(/\/[^/]*$/, '/' + fileName);
			src.search = '';
			src.hash = '';
			return src.toString();
		} catch (e) {
			return 'https://winwidget.ru/widgets/' + fileName;
		}
	}

	function loadExternalScript(src) {
		return new Promise(function (resolve, reject) {
			var existing = document.querySelector('script[src="' + src + '"]');
			if (existing) {
				existing.addEventListener('load', resolve, { once: true });
				existing.addEventListener('error', reject, { once: true });
				if (window.winwidgetPhone) resolve();
				return;
			}
			var script = document.createElement('script');
			script.src = src;
			script.async = true;
			script.onload = function () {
				resolve();
			};
			script.onerror = reject;
			document.head.appendChild(script);
		});
	}

	function ensurePhoneHelper() {
		if (window.winwidgetPhone) return window.winwidgetPhone.load();
		return loadExternalScript(
			getWidgetAssetUrl('helpers/winwidget-phone.js')
		)
			.then(function () {
				return window.winwidgetPhone ? window.winwidgetPhone.load() : null;
			})
			.catch(function (e) {
				console.warn('[winstopoffer] Failed to load phone formatter:', e);
				return null;
			});
	}

	var AUTO_OPEN = Boolean(
		window.winstopofferAutoOpen ||
		window.winwidgetStopOfferAutoOpen ||
		(window.winwidget && window.winwidget.autoOpen)
	);
	var widgetLayerZIndex = AUTO_OPEN ? '2147483647' : '10000';

	function getWidgetFetchOptions(options) {
		var next = options || {};
		if (AUTO_OPEN) next.referrerPolicy = 'unsafe-url';
		return next;
	}

	function el(tag, styles, html) {
		var node = document.createElement(tag);
		if (styles) {
			Object.keys(styles).forEach(function (key) {
				node.style[key] = styles[key];
			});
		}
		if (html !== undefined) node.innerHTML = html;
		return node;
	}

	function safeText(value, fallback) {
		return value == null || value === '' ? fallback : String(value);
	}

	function getConfigUrl() {
		return (
			API_BASE +
			'/stop-offer/' +
			encodeURIComponent(KEY) +
			'/config?_=' +
			Date.now()
		);
	}

	var cfg = null;
	var isOpen = false;
	var hasTriggered = false;
	var autoOpenTimer = null;
	var mobileTimer = null;

	var host = document.createElement('div');
	host.id = 'stop-offer-widget-host';
	document.body.appendChild(host);
	var shadow = host.attachShadow({ mode: 'open' });

	var style = document.createElement('style');
	style.id = 'stop-offer-widget-style';
	style.textContent = [
		'.wso-input-error{border-color:#ef4444!important;box-shadow:0 0 0 3px rgba(239,68,68,.12)!important}',
		'@media(max-width:520px){#wso-overlay{padding:12px!important}#wso-modal{padding:24px 16px 18px!important;border-radius:18px!important}.wso-title{font-size:23px!important}.wso-offer{font-size:30px!important}}'
	].join('');
	shadow.appendChild(style);

	var overlay = document.createElement('div');
	overlay.id = 'wso-overlay';
	overlay.style.cssText =
		'position:fixed;inset:0;z-index:' +
		widgetLayerZIndex +
		';display:none;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
	var backdrop = document.createElement('div');
	backdrop.style.cssText =
		'position:absolute;inset:0;background:rgba(8,4,20,.82);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);touch-action:none';
	overlay.appendChild(backdrop);
	var modal = document.createElement('div');
	modal.id = 'wso-modal';
	modal.style.cssText = [
		'position:relative',
		'z-index:1',
		'width:100%',
		'max-width:460px',
		'background:#fff',
		'border-radius:24px',
		'padding:30px 24px 22px',
		'box-sizing:border-box',
		'box-shadow:0 28px 80px rgba(0,0,0,.3)',
		'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
		'transform:translateY(28px) scale(.98)',
		'opacity:0',
		'transition:transform .3s cubic-bezier(.22,1,.36,1),opacity .25s ease',
		'overflow:hidden'
	].join(';');
	overlay.appendChild(modal);
	shadow.appendChild(overlay);

	function getDisplayResetToken() {
		return cfg && cfg.displayResetToken ? cfg.displayResetToken : '';
	}

	function getSubmissionResetToken() {
		return cfg && cfg.submissionResetToken ? cfg.submissionResetToken : '';
	}

	function getSeenStorageKey() {
		return 'winstopoffer_seen_' + KEY + '_' + getDisplayResetToken();
	}

	function getSubmittedStorageKey() {
		return (
			'winstopoffer_submitted_' + KEY + '_' + getSubmissionResetToken()
		);
	}

	function hasRecentStorageRecord(storageKey, cooldownDays) {
		try {
			var storedTs = localStorage.getItem(storageKey);
			if (!storedTs) return false;
			var storedAt = parseInt(storedTs, 10);
			if (!storedAt) return false;
			var cooldownMs = (Number(cooldownDays) || 0) * 24 * 60 * 60 * 1000;
			return cooldownMs === 0 || Date.now() - storedAt < cooldownMs;
		} catch (e) {
			return false;
		}
	}

	function rememberStorageRecord(storageKey) {
		try {
			localStorage.setItem(storageKey, Date.now().toString());
		} catch (e) {}
	}

	function shouldSkipBySeenState() {
		if (!cfg || cfg.showOnce === false || AUTO_OPEN) return false;
		return hasRecentStorageRecord(
			getSeenStorageKey(),
			cfg.displayCooldownDays ?? 7
		);
	}

	function rememberSeen() {
		if (!cfg || cfg.showOnce === false) return;
		rememberStorageRecord(getSeenStorageKey());
	}

	function rememberSubmitted() {
		if (
			!cfg ||
			(cfg.filterDuplicates !== true && cfg.hideIfSubmitted === false) ||
			cfg.dataType === 'NONE'
		)
			return;
		rememberStorageRecord(getSubmittedStorageKey());
	}

	function hasSubmittedLocally() {
		if (
			!cfg ||
			(cfg.filterDuplicates !== true && cfg.hideIfSubmitted === false) ||
			cfg.dataType === 'NONE'
		)
			return false;
		return hasRecentStorageRecord(
			getSubmittedStorageKey(),
			cfg.submissionCooldownDays ?? 0
		);
	}

	function isAlreadySubmitted() {
		return (
			cfg &&
			cfg.dataType !== 'NONE' &&
			(cfg.hasSubmittedByIp === true || hasSubmittedLocally())
		);
	}

	function firePixelEvent(goalName) {
		if (cfg && cfg.yandexMetrikaId && typeof ym === 'function') {
			try {
				ym(Number(cfg.yandexMetrikaId), 'reachGoal', goalName);
			} catch (e) {}
		}
		if (
			cfg &&
			cfg.vkPixelId &&
			window.VK &&
			typeof VK.Goal === 'function'
		) {
			try {
				VK.Goal(goalName);
			} catch (e) {}
		}
		if (
			cfg &&
			cfg.roistatEnabled &&
			window.roistat &&
			window.roistat.event &&
			typeof window.roistat.event.send === 'function'
		) {
			try {
				window.roistat.event.send(goalName);
			} catch (e) {}
		}
	}

	function shouldSkipBySubmittedState() {
		if (
			!cfg ||
			AUTO_OPEN ||
			cfg.hideIfSubmitted === false ||
			cfg.dataType === 'NONE'
		)
			return false;
		return isAlreadySubmitted();
	}

	function buildCloseBtn() {
		var close = el(
			'button',
			{
				position: 'absolute',
				top: '12px',
				right: '14px',
				width: '32px',
				height: '32px',
				border: 'none',
				borderRadius: '50%',
				background: 'rgba(71,5,251,.08)',
				color: '#7b3fa0',
				fontSize: '20px',
				lineHeight: '1',
				cursor: 'pointer'
			},
			'&times;'
		);
		if (AUTO_OPEN) close.style.display = 'none';
		close.onclick = closeModal;
		return close;
	}

	function buildBrand() {
		if (
			cfg &&
			(cfg.developInfoActive === false || cfg.hideBranding === true)
		)
			return document.createDocumentFragment();
		var brand = el('div', {
			textAlign: 'center',
			fontSize: '12px',
			color: '#6b6378',
			marginTop: '12px',
			lineHeight: '1.5',
			letterSpacing: '0.2px'
		});
		brand.innerHTML =
			'Сделано в&nbsp;<a href="https://winwidget.ru" target="_blank" rel="noopener" style="color:#4705fb;text-decoration:none;font-weight:600">winwidget.ru</a>';
		return brand;
	}

	function buildActionLink(fullWidth) {
		if (cfg.actionButtonEnabled !== true) return null;
		if (!cfg.actionButtonUrl) return null;
		var link = el('a', {
			display: 'inline-flex',
			alignItems: 'center',
			justifyContent: 'center',
			width: fullWidth ? '100%' : 'auto',
			minHeight: '48px',
			padding: '0 18px',
			borderRadius: '12px',
			background: cfg.buttonColor || cfg.color || '#4705fb',
			color: '#fff',
			fontSize: '15px',
			fontWeight: '750',
			textDecoration: 'none',
			boxSizing: 'border-box',
			boxShadow: '0 8px 22px rgba(71,5,251,.22)'
		});
		link.href = cfg.actionButtonUrl;
		link.target = '_blank';
		link.rel = 'noopener noreferrer';
		link.textContent = cfg.actionButtonText || 'Перейти к акции';
		link.onclick = function () {
			fireEvent('action');
		};
		return link;
	}

	function makeInput(type, placeholder) {
		var input = el('input', {
			width: '100%',
			height: '48px',
			border: '1px solid #e0d6f0',
			borderRadius: '12px',
			background: '#f8f5ff',
			padding: '0 14px',
			fontSize: '15px',
			color: '#1a1a1a',
			outline: 'none',
			boxSizing: 'border-box'
		});
		input.type = type;
		input.placeholder = placeholder;
		input.onfocus = function () {
			input.style.borderColor = cfg.color || '#4705fb';
			input.style.boxShadow =
				'0 0 0 3px ' + (cfg.color || '#4705fb') + '22';
		};
		input.onblur = function () {
			input.style.borderColor = '#e0d6f0';
			input.style.boxShadow = 'none';
		};
		return input;
	}

	function buildIntro() {
		modal.innerHTML = '';
		modal.appendChild(buildCloseBtn());
		var badge = el('div', {
			display: 'inline-flex',
			padding: '5px 10px',
			borderRadius: '999px',
			background: (cfg.color || '#4705fb') + '12',
			color: cfg.color || '#4705fb',
			fontSize: '11px',
			fontWeight: '800',
			letterSpacing: '.06em',
			textTransform: 'uppercase',
			marginBottom: '12px'
		});
		badge.textContent = safeText(cfg.badgeText, 'Подождите');
		modal.appendChild(badge);
		var offer = el('div', {
			margin: '0 0 12px',
			fontSize: '34px',
			lineHeight: '1.05',
			fontWeight: '900',
			color: cfg.color || '#4705fb',
			letterSpacing: '-.02em'
		});
		offer.className = 'wso-offer';
		offer.textContent = safeText(cfg.offerText, 'Скидка 10%');
		modal.appendChild(offer);
		var title = el('h2', {
			margin: '0 22px 8px 0',
			fontSize: '26px',
			lineHeight: '1.18',
			color: '#1a1a1a',
			fontWeight: '850'
		});
		title.className = 'wso-title';
		title.textContent = safeText(cfg.title, 'Персональное предложение');
		modal.appendChild(title);
		if (cfg.subtitle) {
			var subtitle = el('p', {
				margin: '0 0 18px',
				fontSize: '14px',
				color: '#777',
				lineHeight: '1.5',
				maxWidth: '360px'
			});
			subtitle.textContent = cfg.subtitle;
			modal.appendChild(subtitle);
		}
		if (cfg.dataType === 'NONE') {
			var action = buildActionLink(true);
			if (action) modal.appendChild(action);
			modal.appendChild(buildBrand());
			return;
		}
		if (isAlreadySubmitted()) {
			buildSuccess();
			return;
		}
		buildFormContent();
	}

	function buildFormContent() {
		var contactTitle = el('p', {
			margin: '0 0 10px',
			fontSize: '14px',
			fontWeight: '700',
			color: '#1a1a1a',
			lineHeight: '1.4'
		});
		contactTitle.textContent = safeText(
			cfg.contactTitle,
			'Куда отправить скидку?'
		);
		modal.appendChild(contactTitle);
		var form = el('div', {
			display: 'flex',
			flexDirection: 'column',
			gap: '10px'
		});
		var phoneInput = null;
		var emailInput = null;
		var phoneController = null;

		if (cfg.dataType === 'PHONE' || cfg.dataType === 'PHONE_AND_EMAIL') {
			phoneInput = makeInput('tel', '+7 999 123-45-67');
			if (window.winwidgetPhone) {
				phoneController = window.winwidgetPhone.attach(phoneInput, {
					placeholder: '+7 999 123-45-67',
					onChange: function () {
						phoneInput.classList.remove('wso-input-error');
					}
				});
			}
			phoneInput.addEventListener('input', function () {
				phoneInput.classList.remove('wso-input-error');
			});
			form.appendChild(phoneInput);
		}
		if (cfg.dataType === 'EMAIL' || cfg.dataType === 'PHONE_AND_EMAIL') {
			emailInput = makeInput('email', 'Email');
			emailInput.addEventListener('input', function () {
				emailInput.classList.remove('wso-input-error');
			});
			form.appendChild(emailInput);
		}
		var submit = el('button', {
			width: '100%',
			height: '50px',
			border: 'none',
			borderRadius: '12px',
			background: cfg.buttonColor || cfg.color || '#4705fb',
			color: '#fff',
			fontSize: '15px',
			fontWeight: '750',
			cursor: 'pointer',
			boxShadow: '0 8px 22px rgba(71,5,251,.22)'
		});
		submit.textContent = safeText(cfg.submitButtonText, 'Забрать скидку');
		form.appendChild(submit);
		var action = buildActionLink(false);
		if (action) {
			action.style.background = 'transparent';
			action.style.color = cfg.color || '#4705fb';
			action.style.boxShadow = 'none';
			action.style.minHeight = '34px';
			form.appendChild(action);
		}
		if (cfg.privacyUrl) {
			var privacy = el('p', {
				margin: '0',
				fontSize: '11px',
				color: '#aaa',
				textAlign: 'center',
				lineHeight: '1.45'
			});
			privacy.innerHTML =
				'Нажимая кнопку, вы соглашаетесь с <a href="' +
				cfg.privacyUrl +
				'" target="_blank" style="color:#999">политикой конфиденциальности</a>';
			form.appendChild(privacy);
		}
		var isSubmitting = false;
		submit.onclick = function () {
			if (isSubmitting) return;
			var phone = '';
			var email = '';
			var valid = true;
			if (phoneInput) {
				phone = phoneController ? phoneController.getNumber() : null;
				if (!phone) {
					phoneInput.classList.add('wso-input-error');
					valid = false;
				}
			}
			if (emailInput) {
				email = emailInput.value.trim();
				if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
					emailInput.classList.add('wso-input-error');
					valid = false;
				}
			}
			if (!valid) return;
			isSubmitting = true;
			submit.disabled = true;
			submit.style.opacity = '.65';
			submit.textContent = 'Отправляем...';
			fetch(
				API_BASE + '/stop-offer/' + KEY + '/lead',
				getWidgetFetchOptions({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						phone: phone || undefined,
						email: email || undefined,
						url: window.location.href
					})
				})
			)
				.then(function (r) {
					if (!r.ok) throw new Error('submit failed');
					return r.json();
				})
				.then(function () {
					rememberSubmitted();
					fireEvent('submit');
					buildSuccess();
				})
				.catch(function () {
					isSubmitting = false;
					submit.disabled = false;
					submit.style.opacity = '1';
					submit.textContent = safeText(
						cfg.submitButtonText,
						'Забрать скидку'
					);
				});
		};
		modal.appendChild(form);
		modal.appendChild(buildBrand());
	}

	function buildSuccess() {
		modal.innerHTML = '';
		modal.appendChild(buildCloseBtn());
		var icon = el('div', {
			width: '60px',
			height: '60px',
			borderRadius: '50%',
			background: (cfg.color || '#4705fb') + '12',
			color: cfg.color || '#4705fb',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			margin: '8px auto 16px',
			fontSize: '30px',
			fontWeight: '800'
		});
		icon.textContent = '✓';
		modal.appendChild(icon);
		var title = el('h2', {
			margin: '0 0 8px',
			fontSize: '22px',
			fontWeight: '800',
			color: '#1a1a1a',
			textAlign: 'center'
		});
		title.textContent = safeText(
			cfg.successTitle,
			'Спасибо! Скидка закреплена'
		);
		modal.appendChild(title);
		if (cfg.successSubtitle) {
			var sub = el('p', {
				margin: '0 0 16px',
				fontSize: '14px',
				color: '#777',
				textAlign: 'center',
				lineHeight: '1.5'
			});
			sub.textContent = cfg.successSubtitle;
			modal.appendChild(sub);
		}
		var action = buildActionLink(true);
		if (action) modal.appendChild(action);
		modal.appendChild(buildBrand());
	}

	function openModal() {
		if (!cfg || isOpen) return;
		isOpen = true;
		rememberSeen();
		overlay.style.display = 'flex';
		modal.style.background = cfg.bgColor || '#fff';
		buildIntro();
		requestAnimationFrame(function () {
			requestAnimationFrame(function () {
				modal.style.transform = 'translateY(0) scale(1)';
				modal.style.opacity = '1';
			});
		});
		fireEvent('open');
	}

	function closeModal() {
		if (!isOpen) return;
		isOpen = false;
		modal.style.transform = 'translateY(28px) scale(.98)';
		modal.style.opacity = '0';
		setTimeout(function () {
			if (!isOpen) overlay.style.display = 'none';
		}, 280);
		fireEvent('close');
	}

	function triggerOpen(reason) {
		if (
			!cfg ||
			hasTriggered ||
			isOpen ||
			shouldSkipBySeenState() ||
			shouldSkipBySubmittedState()
		)
			return;
		hasTriggered = true;
		openModal();
		fireEvent('trigger:' + reason);
	}

	function setupTriggers() {
		clearTimers();
		if (AUTO_OPEN) {
			openModal();
			return;
		}
		if (cfg.autoOpenDelay && cfg.autoOpenDelay > 0) {
			autoOpenTimer = setTimeout(function () {
				triggerOpen('delay');
			}, cfg.autoOpenDelay * 1000);
		}
		if (cfg.desktopExitIntent !== false) {
			document.addEventListener('mouseleave', handleExitIntent);
			document.addEventListener('mouseout', handleExitIntent);
			if (document.documentElement) {
				document.documentElement.addEventListener(
					'mouseleave',
					handleExitIntent
				);
			}
			window.addEventListener('mouseout', handleExitIntent);
			window.addEventListener('blur', handlePageLeaveIntent);
			document.addEventListener('visibilitychange', handlePageLeaveIntent);
		}
		window.addEventListener('scroll', handleScroll, { passive: true });
		document.addEventListener('scroll', handleScroll, {
			passive: true,
			capture: true
		});
		if (isLikelyMobile()) {
			mobileTimer = setTimeout(
				function () {
					triggerOpen('mobile-delay');
				},
				Math.max(1, Number(cfg.mobileAutoOpenDelay) || 8) * 1000
			);
		}
	}

	function clearTimers() {
		if (autoOpenTimer) clearTimeout(autoOpenTimer);
		if (mobileTimer) clearTimeout(mobileTimer);
		autoOpenTimer = null;
		mobileTimer = null;
	}

	function teardownTriggers() {
		clearTimers();
		document.removeEventListener('mouseleave', handleExitIntent);
		document.removeEventListener('mouseout', handleExitIntent);
		if (document.documentElement) {
			document.documentElement.removeEventListener(
				'mouseleave',
				handleExitIntent
			);
		}
		window.removeEventListener('mouseout', handleExitIntent);
		window.removeEventListener('blur', handlePageLeaveIntent);
		document.removeEventListener(
			'visibilitychange',
			handlePageLeaveIntent
		);
		window.removeEventListener('scroll', handleScroll);
		document.removeEventListener('scroll', handleScroll, true);
	}

	function handleExitIntent(event) {
		if (!cfg || cfg.desktopExitIntent === false || isLikelyMobile())
			return;
		var y =
			event && typeof event.clientY === 'number' ? event.clientY : null;
		if (y === null || y > 8) return;
		if (event.type === 'mouseout') {
			var relatedTarget = event.relatedTarget || event.toElement;
			if (relatedTarget) return;
		}
		triggerOpen('exit-intent');
	}

	function handlePageLeaveIntent() {
		if (!cfg || cfg.desktopExitIntent === false || isLikelyMobile())
			return;
		if (document.visibilityState === 'hidden') {
			triggerOpen('exit-intent');
			return;
		}
		if (document.hasFocus && !document.hasFocus()) {
			triggerOpen('exit-intent');
		}
	}

	function getElementScrollProgress(element) {
		if (!element || element.nodeType !== 1) return 0;
		var scrollHeight = Number(element.scrollHeight) || 0;
		var clientHeight = Number(element.clientHeight) || 0;
		var scrollTop = Number(element.scrollTop) || 0;
		var maxScroll = scrollHeight - clientHeight;
		if (maxScroll <= 1) return 0;
		return (scrollTop / maxScroll) * 100;
	}

	function getDocumentScrollProgress() {
		var doc = document.documentElement;
		var body = document.body;
		var scrollingElement = document.scrollingElement || doc;
		var scrollTop = Math.max(
			window.pageYOffset || 0,
			window.scrollY || 0,
			scrollingElement ? scrollingElement.scrollTop || 0 : 0,
			doc ? doc.scrollTop || 0 : 0,
			body ? body.scrollTop || 0 : 0
		);
		var scrollHeight = Math.max(
			scrollingElement ? scrollingElement.scrollHeight || 0 : 0,
			doc ? doc.scrollHeight || 0 : 0,
			body ? body.scrollHeight || 0 : 0
		);
		var viewportHeight =
			window.innerHeight ||
			(scrollingElement ? scrollingElement.clientHeight || 0 : 0) ||
			(doc ? doc.clientHeight || 0 : 0);
		var maxScroll = Math.max(1, scrollHeight - viewportHeight);
		return (scrollTop / maxScroll) * 100;
	}

	function getScrollEventProgress(event) {
		var target = event && event.target;
		if (!target || target === document || target === window) return 0;
		return getElementScrollProgress(target);
	}

	function handleScroll(event) {
		if (!cfg || hasTriggered || isOpen) return;
		var progress = Math.max(
			getDocumentScrollProgress(),
			getScrollEventProgress(event)
		);
		if (progress >= (Number(cfg.scrollPercent) || 70)) {
			triggerOpen('scroll');
		}
	}

	function isLikelyMobile() {
		return (
			window.innerWidth < 768 ||
			(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
		);
	}

	function fireEvent(name) {
		try {
			document.dispatchEvent(
				new CustomEvent('winwidget:stop-offer:' + name)
			);
		} catch (e) {}
		if (name === 'open') firePixelEvent('wso_open');
		if (name === 'submit') firePixelEvent('wso_send');
	}

	function showDisabledPage() {
		var existing = document.getElementById('stop-offer-widget-disabled');
		if (existing) return;
		var disabled = document.createElement('div');
		disabled.id = 'stop-offer-widget-disabled';
		disabled.style.cssText =
			'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0d0d1a;color:#fff;font-family:sans-serif;text-align:center;padding:24px;z-index:2147483647';
		disabled.innerHTML =
			'<div style="font-size:3rem;margin-bottom:16px">🔒</div><h1 style="font-size:1.3rem;font-weight:700;margin-bottom:10px">Виджет временно отключен</h1>';
		document.body.appendChild(disabled);
	}

	function loadConfig() {
		return Promise.all([
			ensurePhoneHelper(),
			fetch(getConfigUrl(), getWidgetFetchOptions({ cache: 'no-store' }))
		])
			.then(function (result) {
				var response = result[1];
				if (!response.ok) {
					console.warn(
						'[winstopoffer] Widget not found or inactive (' +
							response.status +
							')'
					);
					return null;
				}
				return response.json();
			})
			.then(function (data) {
				if (data === null) return;
				if (!data || !data.isActive) {
					console.warn('[winstopoffer] Widget is inactive');
					cfg = null;
					closeModal();
					teardownTriggers();
					if (AUTO_OPEN) showDisabledPage();
					return;
				}
				cfg = data;
				hasTriggered = false;
				setupTriggers();
				if (isOpen) {
					buildIntro();
					modal.style.transform = 'translateY(0) scale(1)';
					modal.style.opacity = '1';
				}
			})
			.catch(function (e) {
				console.error('[winstopoffer] Failed to load config:', e);
			});
	}

	function refreshConfig() {
		return loadConfig();
	}

	function handleExternalRefresh(event) {
		if (!event.detail || !event.detail.key || event.detail.key === KEY) {
			refreshConfig();
		}
	}

	function handleStorageRefresh(event) {
		if (event.key === 'winwidget:stop-offer:' + KEY + ':updated') {
			refreshConfig();
		}
	}

	function handleBackdropClick() {
		if (!AUTO_OPEN) closeModal();
	}

	function destroyWidget() {
		teardownTriggers();
		backdrop.removeEventListener('click', handleBackdropClick);
		window.removeEventListener(
			'winwidget:stop-offer:updated',
			handleExternalRefresh
		);
		window.removeEventListener('storage', handleStorageRefresh);
		var disabledPage = document.getElementById(
			'stop-offer-widget-disabled'
		);
		if (disabledPage && disabledPage.parentNode)
			disabledPage.parentNode.removeChild(disabledPage);
		if (host.parentNode) host.parentNode.removeChild(host);
		delete window.__winstopofferScriptRunning;
		if (
			window.winwidgetStopOffer &&
			window.winwidgetStopOffer.key === KEY
		) {
			delete window.winwidgetStopOffer;
		}
	}

	backdrop.addEventListener('click', handleBackdropClick);
	window.addEventListener(
		'winwidget:stop-offer:updated',
		handleExternalRefresh
	);
	window.addEventListener('storage', handleStorageRefresh);

	window.winwidgetStopOffer = {
		key: KEY,
		open: openModal,
		close: closeModal,
		refresh: refreshConfig,
		destroy: destroyWidget
	};

	loadConfig();
})();
