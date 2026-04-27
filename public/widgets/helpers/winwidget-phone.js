(function () {
	'use strict';

	if (window.winwidgetPhone) return;

	var currentScript = document.currentScript;
	var BASE_URL = (function () {
		try {
			var src = new URL(
				currentScript && currentScript.src
					? currentScript.src
					: location.href
			);
			src.pathname = src.pathname.replace(/\/[^/]*$/, '/');
			src.search = '';
			src.hash = '';
			return src.toString();
		} catch (e) {
			return 'https://winwidget.ru/widgets/';
		}
	})();

	var loadingPromise = null;

	function loadScript(src) {
		return new Promise(function (resolve, reject) {
			var existing = document.querySelector('script[src="' + src + '"]');
			if (existing) {
				existing.addEventListener('load', resolve, { once: true });
				existing.addEventListener('error', reject, { once: true });
				if (window.libphonenumber) resolve();
				return;
			}

			var script = document.createElement('script');
			script.src = src;
			script.async = true;
			script.onload = resolve;
			script.onerror = reject;
			document.head.appendChild(script);
		});
	}

	function load() {
		if (window.libphonenumber)
			return Promise.resolve(window.libphonenumber);
		if (!loadingPromise) {
			loadingPromise = loadScript(BASE_URL + 'libphonenumber-min.js').then(
				function () {
					if (!window.libphonenumber) {
						throw new Error('libphonenumber-js is not available');
					}
					return window.libphonenumber;
				}
			);
		}
		return loadingPromise;
	}

	function normalizeInitialValue(value) {
		var raw = String(value || '').trim();
		var digits = raw.replace(/\D/g, '');

		if (raw.indexOf('+') === 0) return raw;
		if (raw.indexOf('8') === 0 && digits.length >= 10) {
			return '7' + digits.slice(1);
		}

		return raw;
	}

	function format(value) {
		var lib = window.libphonenumber;
		var raw = normalizeInitialValue(value);
		if (!lib || !raw) return raw;

		try {
			var formatter =
				raw.indexOf('+') === 0
					? new lib.AsYouType()
					: new lib.AsYouType('RU');
			return formatter.input(raw);
		} catch (e) {
			return raw;
		}
	}

	function parse(value) {
		var lib = window.libphonenumber;
		var raw = normalizeInitialValue(value);
		if (!lib || !raw) return null;

		try {
			var phone = lib.parsePhoneNumberFromString(
				raw,
				raw.indexOf('+') === 0 ? undefined : 'RU'
			);
			return phone && phone.isValid() ? phone.number : null;
		} catch (e) {
			return null;
		}
	}

	function attach(input, options) {
		options = options || {};
		if (!input) return null;

		input.placeholder = options.placeholder || '+7 999 123-45-67';
		input.setAttribute('inputmode', 'tel');
		input.setAttribute('autocomplete', 'tel');

		function update() {
			var startAtEnd = input.selectionStart === input.value.length;
			input.value = format(input.value);
			if (startAtEnd) {
				try {
					input.setSelectionRange(input.value.length, input.value.length);
				} catch (e) {}
			}
			if (typeof options.onChange === 'function') {
				options.onChange(parse(input.value));
			}
		}

		input.addEventListener('input', update);
		input.addEventListener('paste', function () {
			setTimeout(update, 0);
		});

		return {
			getNumber: function () {
				return parse(input.value);
			},
			isValid: function () {
				return Boolean(parse(input.value));
			},
			format: update,
			destroy: function () {
				input.removeEventListener('input', update);
			}
		};
	}

	window.winwidgetPhone = {
		load: load,
		format: format,
		parse: parse,
		attach: attach
	};
})();
