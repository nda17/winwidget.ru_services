#!/usr/bin/env bash

set -Eeuo pipefail

readonly PLATFORM_FRONTEND_ATTESTATION_MAX_FILE_SIZE='16384'
readonly PLATFORM_FRONTEND_ATTESTATION_MAX_HTTP_FILE_SIZE='16777216'
readonly PLATFORM_FRONTEND_ATTESTATION_PROJECT='winwidget'
readonly PLATFORM_FRONTEND_ATTESTATION_SERVICE='client'
readonly PLATFORM_FRONTEND_ATTESTATION_DEFAULT_MAX_AGE_SECONDS='600'
readonly PLATFORM_FRONTEND_ATTESTATION_HARD_CUTOVER_FRONTEND_REVISION='7dfc706feff5a8c70bc6fa03af726926e7d3dd15'

platform_frontend_attestation_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

platform_frontend_attestation_stat_mode() {
	stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

platform_frontend_attestation_stat_owner() {
	stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"
}

platform_frontend_attestation_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	else
		shasum -a 256 "$1" | awk '{ print $1 }'
	fi
}

platform_frontend_attestation_require_command() {
	command -v "$1" >/dev/null 2>&1 ||
		platform_frontend_attestation_fail "Required command is unavailable: $1"
}

platform_frontend_attestation_require_root() {
	[[ "$(id -u)" == '0' ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend runtime attestation must run as root.'
}

platform_frontend_attestation_require_identity() {
	local backend_revision="${PLATFORM_BACKEND_REVISION:-}"
	local frontend_revision="${PLATFORM_FRONTEND_REVISION:-}"
	local generation="${PLATFORM_CUTOVER_GENERATION:-}"
	local challenge="${PLATFORM_FRONTEND_RUNTIME_CHALLENGE:-}"
	local origin="${PLATFORM_FRONTEND_ORIGIN:-}"
	[[ "$backend_revision" =~ ^[0-9a-f]{40}$ &&
		"$frontend_revision" =~ ^[0-9a-f]{40}$ &&
		"$generation" =~ ^[1-9][0-9]{0,17}$ &&
		"$challenge" =~ ^[0-9a-f]{64}$ &&
		"$origin" =~ ^https://[a-z0-9.-]+(:[1-9][0-9]{0,4})?$ ]] ||
		platform_frontend_attestation_fail \
			'Exact backend/frontend revisions, cutover generation, challenge and canonical lowercase HTTPS origin are required.'
}

platform_frontend_attestation_require_safe_ancestors() {
	local path="$1" current mode owner
	current="$path"
	while :; do
		owner="$(platform_frontend_attestation_stat_owner "$current")" || return 1
		mode="$(platform_frontend_attestation_stat_mode "$current")" || return 1
		[[ "$owner" == '0:0' && "$mode" =~ ^[0-7]{3,4}$ ]] ||
			platform_frontend_attestation_fail \
				'Platform frontend attestation path ancestors must be root-owned directories with numeric modes.' || return 1
		if (( (8#$mode & 0022) != 0 && (8#$mode & 01000) == 0 )); then
			platform_frontend_attestation_fail \
				'Platform frontend attestation path ancestors must not be writable by group or others unless protected by the sticky bit.'
			return 1
		fi
		[[ "$current" == '/' ]] && break
		current="$(dirname -- "$current")" || return 1
	done
}

platform_frontend_attestation_require_safe_directory() {
	local path="$1" mode canonical
	[[ "$path" == /* && -d "$path" && ! -L "$path" &&
		"$(platform_frontend_attestation_stat_owner "$path")" == '0:0' ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend attestation directory must be absolute, root-owned and not a symlink.' || return 1
	canonical="$(cd -- "$path" && pwd -P)" || return 1
	[[ "$canonical" == "$path" ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend attestation directory must use its canonical path.' || return 1
	mode="$(platform_frontend_attestation_stat_mode "$path")" || return 1
	[[ "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 0022)) -eq 0 ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend attestation directory must not be writable by group or others.' || return 1
	platform_frontend_attestation_require_safe_ancestors "$path"
}

platform_frontend_attestation_require_direct_child() {
	local root="$1" path="$2"
	[[ "$path" == "$root/"* && "$(dirname -- "$path")" == "$root" ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend attestation artifacts must stay directly inside the reviewed directory.'
}

platform_frontend_attestation_require_distinct_paths() {
	local left right
	local -a paths=("$@")
	for ((left = 0; left < ${#paths[@]}; left += 1)); do
		for ((right = left + 1; right < ${#paths[@]}; right += 1)); do
			[[ "${paths[$left]}" != "${paths[$right]}" ]] ||
				platform_frontend_attestation_fail \
					'Platform frontend attestation artifact and lock paths must be pairwise distinct.' || return 1
		done
	done
}

platform_frontend_attestation_require_safe_file() {
	local path="$1" label="$2" size
	[[ "$path" == /* && -f "$path" && ! -L "$path" &&
		"$(platform_frontend_attestation_stat_owner "$path")" == '0:0' &&
		"$(platform_frontend_attestation_stat_mode "$path")" == '600' ]] ||
		platform_frontend_attestation_fail \
			"$label must be an absolute root-owned mode-600 regular file." || return 1
	size="$(wc -c <"$path" | tr -d '[:space:]')" || return 1
	[[ "$size" =~ ^[0-9]+$ && "$size" -ge 32 &&
		"$size" -le "$PLATFORM_FRONTEND_ATTESTATION_MAX_FILE_SIZE" ]] ||
		platform_frontend_attestation_fail "$label has an unsafe size."
}

platform_frontend_attestation_require_safe_lock_file() {
	local path="$1"
	[[ "$path" == /* && -f "$path" && ! -L "$path" &&
		"$(platform_frontend_attestation_stat_owner "$path")" == '0:0' &&
		"$(platform_frontend_attestation_stat_mode "$path")" == '600' ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend attestation lock must be an absolute root-owned mode-600 regular file.'
}

platform_frontend_attestation_acquire_lock() {
	local lock_file="$1"
	platform_frontend_attestation_require_command flock
	if [[ ! -e "$lock_file" && ! -L "$lock_file" ]]; then
		(umask 077; set -o noclobber; : >"$lock_file") 2>/dev/null || true
	fi
	platform_frontend_attestation_require_safe_lock_file "$lock_file" || return 1
	exec 9>>"$lock_file"
	flock -n 9 ||
		platform_frontend_attestation_fail \
			'Another Platform frontend attestation operation holds the generation lock.'
}

platform_frontend_attestation_require_ed25519_private_key() {
	local path="$1" key_text
	key_text="$(openssl pkey -in "$path" -text -noout 2>/dev/null)" || return 1
	[[ "$key_text" == ED25519\ Private-Key:* ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend attestation private key must be Ed25519.'
}

platform_frontend_attestation_require_ed25519_public_key() {
	local path="$1" key_text
	key_text="$(openssl pkey -pubin -in "$path" -text -noout 2>/dev/null)" || return 1
	[[ "$key_text" == ED25519\ Public-Key:* ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend attestation public key must be Ed25519.'
}

platform_frontend_attestation_build_evidence_scanner() {
	cat <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = process.env.CONTRACT_ROOT || "/app/.next";
const maxBytes = 16 * 1024 * 1024;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const safeRelative = value => typeof value === "string" &&
  value.length > 0 && value.length < 512 && !value.startsWith("/") &&
  path.posix.normalize(value) === value && !value.split("/").includes("..");
const readSafe = relative => {
  if (!safeRelative(relative)) process.exit(1);
  const absolute = `${root}/${relative}`;
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
    process.exit(1);
  }
  return readFileSync(absolute);
};
const parseJson = relative => {
  try { return JSON.parse(readSafe(relative).toString("utf8")); }
  catch { process.exit(1); }
};

const buildIdBuffer = readSafe("BUILD_ID");
const buildId = buildIdBuffer.toString("utf8");
if (!/^[A-Za-z0-9_-]{8,128}$/.test(buildId)) process.exit(1);
const appBuildManifestBuffer = readSafe("app-build-manifest.json");
let appBuildManifest;
try { appBuildManifest = JSON.parse(appBuildManifestBuffer.toString("utf8")); }
catch { process.exit(1); }
const appPaths = parseJson("server/app-paths-manifest.json");
if (appPaths["/payment/page"] !== "app/payment/page.js") process.exit(1);
const paymentEntries = appBuildManifest?.pages?.["/payment/page"];
const adminEntries = appBuildManifest?.pages?.["/admin/settings/page"];
if (!Array.isArray(paymentEntries) || !Array.isArray(adminEntries)) process.exit(1);
const paymentAssets = paymentEntries.filter(value =>
  /^static\/chunks\/app\/payment\/page-[A-Za-z0-9]+\.js$/.test(value));
if (paymentAssets.length !== 1) process.exit(1);
const paymentAssetRelative = paymentAssets[0];
const paymentAsset = readSafe(paymentAssetRelative);
const paymentServerRelative = "server/app/payment/page.js";
const paymentServer = readSafe(paymentServerRelative);
const paymentReferenceRelative = "server/app/payment/page_client-reference-manifest.js";
const paymentReference = readSafe(paymentReferenceRelative);
const publicBuildManifestRelative = `static/${buildId}/_buildManifest.js`;
const publicBuildManifest = readSafe(publicBuildManifestRelative);
if (!paymentReference.toString("utf8").includes('"/payment/page"')) process.exit(1);

const emitBuildEvidence = () => process.stdout.write([
  buildId,
  `/_next/${publicBuildManifestRelative}`,
  sha256(publicBuildManifest),
  sha256(appBuildManifestBuffer),
  `/_next/${paymentAssetRelative}`,
  sha256(paymentAsset),
  paymentServerRelative,
  sha256(paymentServer),
  paymentReferenceRelative,
  sha256(paymentReference),
].join("|"));
const integrityOnlyRevision = process.env.CONTRACT_INTEGRITY_ONLY_REVISION;
if (integrityOnlyRevision !== undefined) {
  if (integrityOnlyRevision !==
      "7dfc706feff5a8c70bc6fa03af726926e7d3dd15") process.exit(1);
  emitBuildEvidence();
  process.exit(0);
}

const quotedSource = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`;
const quotedPattern = new RegExp(quotedSource, "g");
const concatPattern = new RegExp(`${quotedSource}(?:\\s*\\+\\s*${quotedSource})+`, "g");
const staticStrings = text => {
  const values = [];
  for (const match of text.matchAll(quotedPattern)) {
    try { values.push(vm.runInNewContext(match[0], Object.create(null), { timeout: 20 })); }
    catch { /* A regex-like or template fragment is not a static string. */ }
  }
  for (const match of text.matchAll(concatPattern)) {
    try { values.push(vm.runInNewContext(match[0], Object.create(null), { timeout: 20 })); }
    catch { /* Only completely static concatenations are evidence. */ }
  }
  return values.filter(value => typeof value === "string");
};
const decodeJavaScriptEscapes = text => {
  const simpleEscapes = new Map([
    ["0", "\0"], ["b", "\b"], ["f", "\f"], ["n", "\n"],
    ["r", "\r"], ["t", "\t"], ["v", "\v"],
  ]);
  const withoutContinuations = text.replace(/\\(?:\r\n|[\n\r\u2028\u2029])/g, "");
  return withoutContinuations.replace(
    /\\(?:x([0-9A-Fa-f]{2})|u\{([0-9A-Fa-f]{1,6})\}|u([0-9A-Fa-f]{4})|([^0-9xu\r\n]))/g,
    (match, hex, braced, fixed, simple) => {
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      const unicode = braced ?? fixed;
      if (unicode !== undefined) {
        const codePoint = Number.parseInt(unicode, 16);
        if (!Number.isInteger(codePoint) || codePoint > 0x10ffff) process.exit(1);
        return String.fromCodePoint(codePoint);
      }
      return simpleEscapes.get(simple) ?? simple;
    },
  );
};
const staticInterpolationSource = `${quotedSource}(?:\\s*\\+\\s*${quotedSource})*`;
const staticInterpolationPattern = new RegExp(
  `\\$\\{\\s*(${staticInterpolationSource})\\s*\\}`,
  "g",
);
const resolveStaticStringInterpolations = text => text.replace(
  staticInterpolationPattern,
  (match, expression) => {
    try {
      const value = vm.runInNewContext(expression, Object.create(null), { timeout: 20 });
      if (typeof value !== "string") process.exit(1);
      return value;
    } catch {
      process.exit(1);
    }
  },
);
const forbiddenBillingRoute = value => {
  let offset = value.indexOf("/billing-");
  while (offset !== -1) {
    const suffix = value.slice(offset);
    if (!/^\/billing-settings\/(?:public|admin)(?:[/?#]|[^A-Za-z0-9._~%-]|$)/.test(suffix)) return true;
    offset = value.indexOf("/billing-", offset + 1);
  }
  return false;
};
const templateCouldContainForbiddenBillingRoute = text => {
  const templatePattern = /`(?:\\.|[^`\\])*`/g;
  for (const match of text.matchAll(templatePattern)) {
    const resolved = decodeJavaScriptEscapes(
      resolveStaticStringInterpolations(match[0]),
    );
    if (forbiddenBillingRoute(resolved)) return true;
    // Current reviewed templates may interpolate the API origin before an
    // otherwise literal public/admin route. Any interpolation inside an
    // incomplete /billing-* route is ambiguous and therefore rejected.
    if (resolved.includes("${") &&
        /\/billing-(?!settings\/(?:public|admin)(?:[/?#]|[^A-Za-z0-9._~%-]|$))/.test(resolved)) {
      return true;
    }
  }
  return false;
};
const staticTemplateStrings = text => {
  const values = [];
  const templatePattern = /`(?:\\.|[^`\\])*`/g;
  for (const match of text.matchAll(templatePattern)) {
    const resolved = resolveStaticStringInterpolations(match[0]);
    if (resolved.includes("${")) continue;
    try {
      const value = vm.runInNewContext(resolved, Object.create(null), { timeout: 20 });
      if (typeof value !== "string") process.exit(1);
      values.push(value);
    } catch {
      process.exit(1);
    }
  }
  return values;
};
const paymentText = paymentServer.toString("utf8");
const compactPayment = paymentText.replace(/\s+/g, "");
const paymentStrings = [
  ...staticStrings(paymentText),
  ...staticTemplateStrings(paymentText),
];
const decodedPaymentText = decodeJavaScriptEscapes(paymentText);
if (!paymentText.includes("/billing-settings/public") ||
    forbiddenBillingRoute(paymentText) ||
    forbiddenBillingRoute(decodedPaymentText) ||
    templateCouldContainForbiddenBillingRoute(paymentText) ||
    paymentStrings.some(forbiddenBillingRoute) ||
    paymentStrings.some(value => value.includes("/site-settings")) ||
    paymentStrings.some(value =>
      ["createElement", "jsx", "jsxs", "jsxDEV"].includes(value))) process.exit(1);

const maskJavaScriptNonCode = text => {
  const result = text.split("");
  let state = "code";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (state === "code") {
      if (char === '"' || char === "'") {
        state = char;
        result[index] = " ";
      } else if (char === "`") {
        state = "template";
        result[index] = " ";
      } else if (char === "/" && next === "/") {
        state = "line-comment";
        result[index] = result[index + 1] = " ";
        index += 1;
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        result[index] = result[index + 1] = " ";
        index += 1;
      }
      continue;
    }
    if (state === "line-comment") {
      if (char === "\n" || char === "\r") state = "code";
      else result[index] = " ";
      continue;
    }
    if (state === "block-comment") {
      result[index] = " ";
      if (char === "*" && next === "/") {
        result[index + 1] = " ";
        index += 1;
        state = "code";
      }
      continue;
    }
    result[index] = " ";
    if (char === "\\") {
      if (index + 1 < text.length) result[++index] = " ";
    } else if ((state === '"' || state === "'") && char === state) {
      state = "code";
    } else if (state === "template" && char === "`") {
      state = "code";
    }
  }
  if (state !== "code") process.exit(1);
  return result.join("");
};
const paymentCodeMask = maskJavaScriptNonCode(paymentText);
const findMatchingBrace = start => {
  let depth = 0;
  for (let index = start; index < paymentCodeMask.length; index += 1) {
    if (paymentCodeMask[index] === "{") depth += 1;
    else if (paymentCodeMask[index] === "}" && --depth === 0) return index;
  }
  return -1;
};
const returnedJsxProps = [];
const returnedJsxPattern = /\breturn\s+(?:[A-Za-z_$][\w$]*\.)?(?:jsx|jsxs)\s*\(/g;
for (const match of paymentCodeMask.matchAll(returnedJsxPattern)) {
  const callStart = match.index + match[0].lastIndexOf("(");
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  let firstComma = -1;
  for (let index = callStart + 1; index < paymentCodeMask.length; index += 1) {
    const char = paymentCodeMask[index];
    if (char === "(") parentheses += 1;
    else if (char === ")") {
      if (parentheses === 0 && braces === 0 && brackets === 0) break;
      parentheses -= 1;
    } else if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "," && parentheses === 0 && braces === 0 && brackets === 0) {
      firstComma = index;
      break;
    }
    if (parentheses < 0 || braces < 0 || brackets < 0) process.exit(1);
  }
  if (firstComma === -1) process.exit(1);
  let propsStart = firstComma + 1;
  while (/\s/.test(paymentCodeMask[propsStart] || "")) propsStart += 1;
  if (paymentCodeMask[propsStart] !== "{") process.exit(1);
  const propsEnd = findMatchingBrace(propsStart);
  if (propsEnd === -1) process.exit(1);
  returnedJsxProps.push({ end: propsEnd, start: propsStart });
}
if (returnedJsxProps.length !== 1) process.exit(1);
const renderFactoryReferences = [
  ...paymentCodeMask.matchAll(/\b(?:createElement|jsx|jsxs|jsxDEV)\b/g),
];
if (renderFactoryReferences.length !== 1 ||
    !/^(?:jsx|jsxs)$/.test(renderFactoryReferences[0][0])) process.exit(1);

const topLevelProperties = ({ start, end }) => {
  const segments = [];
  let segmentStart = start + 1;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  for (let index = start + 1; index <= end; index += 1) {
    const char = paymentCodeMask[index];
    if (char === "(") parentheses += 1;
    else if (char === ")") parentheses -= 1;
    else if (char === "{") braces += 1;
    else if (char === "}" && index !== end) braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    if ((char === "," || index === end) &&
        parentheses === 0 && braces === 0 && brackets === 0) {
      segments.push([segmentStart, index]);
      segmentStart = index + 1;
    }
    if (parentheses < 0 || braces < 0 || brackets < 0) process.exit(1);
  }
  const properties = new Map();
  for (const [segmentBegin, segmentEnd] of segments) {
    let colon = -1;
    parentheses = braces = brackets = 0;
    for (let index = segmentBegin; index < segmentEnd; index += 1) {
      const char = paymentCodeMask[index];
      if (char === "(") parentheses += 1;
      else if (char === ")") parentheses -= 1;
      else if (char === "{") braces += 1;
      else if (char === "}") braces -= 1;
      else if (char === "[") brackets += 1;
      else if (char === "]") brackets -= 1;
      else if (char === ":" && parentheses === 0 && braces === 0 && brackets === 0) {
        colon = index;
        break;
      }
    }
    if (colon === -1) continue;
    const rawKey = paymentText.slice(segmentBegin, colon).trim();
    let key = rawKey;
    if ((rawKey.startsWith('"') && rawKey.endsWith('"')) ||
        (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
      try { key = vm.runInNewContext(rawKey, Object.create(null), { timeout: 20 }); }
      catch { process.exit(1); }
    }
    if (typeof key !== "string") process.exit(1);
    const values = properties.get(key) ?? [];
    values.push(paymentText.slice(colon + 1, segmentEnd).trim());
    properties.set(key, values);
  }
  return properties;
};
const pricingProperties = topLevelProperties(returnedJsxProps[0]);
const fallbackExpressionIsSafe = (name, expected, expression) => {
  const escapedExpected = expected === "false" ? "(?:!1|false)" : "null";
  const compactExpression = expression.replace(/\s+/g, "");
  const direct = new RegExp(`^[A-Za-z_$][\\w$]*\\?\\.${name}\\?\\?${escapedExpected}$`);
  return direct.test(compactExpression);
};
for (const [name, expected] of [
  ["paymentEnabled", "false"],
  ["autoRenewalSignupEnabled", "false"],
  ["autoRenewalTerms", "null"],
]) {
  const values = pricingProperties.get(name);
  if (!Array.isArray(values) || values.length !== 1 ||
      !fallbackExpressionIsSafe(name, expected, values[0])) process.exit(1);
  const identifierMatches = [
    ...paymentCodeMask.matchAll(new RegExp(`\\b${name}\\b`, "g")),
  ];
  if (identifierMatches.length !== 2 || identifierMatches.some(match =>
    match.index <= returnedJsxProps[0].start ||
    match.index >= returnedJsxProps[0].end)) process.exit(1);
}

const adminText = adminEntries
  .filter(value => typeof value === "string" && value.endsWith(".js"))
  .map(value => readSafe(value).toString("utf8"))
  .join("\n");
const adminStrings = [
  ...staticStrings(adminText),
  ...staticTemplateStrings(adminText),
];
if (forbiddenBillingRoute(adminText) ||
    forbiddenBillingRoute(decodeJavaScriptEscapes(adminText)) ||
    templateCouldContainForbiddenBillingRoute(adminText) ||
    adminStrings.some(forbiddenBillingRoute) ||
    !/\.get\(\s*["'`]\/billing-settings\/admin["'`]/.test(adminText) ||
    !/\.patch\(\s*["'`]\/billing-settings\/admin["'`]/.test(adminText) ||
    !/\.get\(\s*["'`]\/site-settings["'`]/.test(adminText) ||
    !/\.patch\(\s*["'`]\/site-settings["'`]/.test(adminText)) process.exit(1);

emitBuildEvidence();
NODE
}

platform_frontend_attestation_payment_html_validator() {
	cat <<'NODE'
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const htmlPath = process.env.HTML_PATH || "/payment.html";
const paymentAssetPath = process.env.EXPECTED_PAYMENT_ASSET_PATH;
const documentOriginValue = process.env.EXPECTED_DOCUMENT_ORIGIN;
let documentOrigin;
try { documentOrigin = new URL(documentOriginValue); }
catch { process.exit(1); }
const htmlBuffer = readFileSync(htmlPath);
if (htmlBuffer.length < 32 || htmlBuffer.length > 16 * 1024 * 1024 ||
    !/^\/_next\/static\/chunks\/app\/payment\/page-[A-Za-z0-9]+\.js$/.test(paymentAssetPath) ||
    !["http:", "https:"].includes(documentOrigin.protocol) ||
    documentOrigin.origin !== documentOriginValue ||
    documentOrigin.href !== `${documentOriginValue}/` ||
    documentOrigin.username || documentOrigin.password ||
    documentOrigin.search || documentOrigin.hash) {
  process.exit(1);
}

let html;
try {
  html = new TextDecoder("utf-8", { fatal: true }).decode(htmlBuffer);
} catch {
  process.exit(1);
}
if (html.includes("\u0000") || html.charCodeAt(0) === 0xfeff) process.exit(1);

const asciiLower = value => value.replace(/[A-Z]/g, char => char.toLowerCase());
const trimAsciiWhitespace = value => value
  .replace(/^[\t\n\f\r ]+/, "")
  .replace(/[\t\n\f\r ]+$/, "");
const isSpace = char => char === " " || char === "\t" || char === "\n" ||
  char === "\r" || char === "\f";
const tagNamePattern = /^[A-Za-z][A-Za-z0-9:-]*$/;
const attributeNamePattern = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;
const rawTextElements = new Set([
  "iframe", "noembed", "noframes", "noscript", "style", "xmp",
]);
const rcdataElements = new Set(["textarea", "title"]);
const foreignHtmlParserStateElements = new Set([
  "plaintext", "script", "template", ...rawTextElements, ...rcdataElements,
]);
const javascriptMimeTypeEssences = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
const ambiguousExecutableAttributes = new Set([
  "disabled", "integrity", "media", "nomodule",
]);
const executionInvalidatingAttributes = new Set([
  "disabled", "integrity", "media",
]);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const sortedAttributes = attributes => [...attributes.entries()]
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
const isExecutableScript = attributes => {
  if (attributes.has("type")) {
    const rawType = attributes.get("type") ?? "";
    if (rawType === "") return true;
    if (asciiLower(rawType) === "module") return true;
    const type = asciiLower(trimAsciiWhitespace(rawType));
    if (type === "") return false;
    return javascriptMimeTypeEssences.has(type);
  }

  if (!attributes.has("language")) return true;
  const rawLanguage = attributes.get("language") ?? "";
  if (rawLanguage === "") return true;
  const language = asciiLower(rawLanguage);
  return javascriptMimeTypeEssences.has(`text/${language}`);
};

const parseStartTag = offset => {
  let cursor = offset + 1;
  const nameStart = cursor;
  while (cursor < html.length && !isSpace(html[cursor]) &&
      html[cursor] !== "/" && html[cursor] !== ">") cursor += 1;
  const rawName = html.slice(nameStart, cursor);
  if (!tagNamePattern.test(rawName)) return null;
  const name = asciiLower(rawName);
  const attributes = new Map();
  let selfClosing = false;

  while (cursor < html.length) {
    while (isSpace(html[cursor])) cursor += 1;
    if (html[cursor] === ">") {
      cursor += 1;
      return { attributes, end: cursor, name, selfClosing };
    }
    if (html[cursor] === "/" && html[cursor + 1] === ">") {
      cursor += 2;
      selfClosing = true;
      return { attributes, end: cursor, name, selfClosing };
    }
    if (cursor >= html.length) return null;

    const attributeStart = cursor;
    while (cursor < html.length && !isSpace(html[cursor]) &&
        html[cursor] !== "/" && html[cursor] !== ">" &&
        html[cursor] !== "=") cursor += 1;
    const rawAttributeName = html.slice(attributeStart, cursor);
    if (!attributeNamePattern.test(rawAttributeName)) return null;
    const attributeName = asciiLower(rawAttributeName);
    if (attributes.has(attributeName)) return null;
    while (isSpace(html[cursor])) cursor += 1;

    let attributeValue = null;
    if (html[cursor] === "=") {
      cursor += 1;
      while (isSpace(html[cursor])) cursor += 1;
      if (cursor >= html.length) return null;
      if (html[cursor] === '"' || html[cursor] === "'") {
        const quote = html[cursor];
        const valueStart = ++cursor;
        while (cursor < html.length && html[cursor] !== quote) cursor += 1;
        if (cursor >= html.length) return null;
        attributeValue = html.slice(valueStart, cursor);
        cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < html.length && !isSpace(html[cursor]) &&
            html[cursor] !== ">") {
          if (html[cursor] === '"' || html[cursor] === "'" ||
              html[cursor] === "<" || html[cursor] === "=" ||
              html[cursor] === "`") return null;
          cursor += 1;
        }
        if (cursor === valueStart) return null;
        attributeValue = html.slice(valueStart, cursor);
      }
    }
    attributes.set(attributeName, attributeValue);
  }
  return null;
};

const parseEndTag = offset => {
  let cursor = offset + 2;
  const nameStart = cursor;
  while (cursor < html.length && !isSpace(html[cursor]) &&
      html[cursor] !== "/" && html[cursor] !== ">") cursor += 1;
  const rawName = html.slice(nameStart, cursor);
  if (!tagNamePattern.test(rawName)) return null;
  while (isSpace(html[cursor])) cursor += 1;
  const ambiguous = html[cursor] !== ">";
  return {
    ambiguous,
    end: ambiguous ? -1 : cursor + 1,
    name: asciiLower(rawName),
  };
};

const findRawTextEnd = (name, offset) => {
  let cursor = offset;
  while ((cursor = html.indexOf("</", cursor)) !== -1) {
    const closing = parseEndTag(cursor);
    if (closing && closing.name === name) {
      // Browsers close raw-text/RCDATA elements even when the end tag carries
      // ignored attributes or a trailing solidus. Reject that malformed form
      // rather than skipping browser-visible markup until a later clean tag.
      if (closing.ambiguous) process.exit(1);
      return { closeStart: cursor, end: closing.end };
    }
    cursor += 2;
  }
  return -1;
};

const parseJsonArrayAt = (source, start) => {
  if (source[start] !== "[") process.exit(1);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        let value;
        try { value = JSON.parse(source.slice(start, index + 1)); }
        catch { process.exit(1); }
        if (!Array.isArray(value)) process.exit(1);
        return { end: index + 1, value };
      }
      if (depth < 0) process.exit(1);
    }
  }
  process.exit(1);
};

const inspectFlightValue = value => {
  if (typeof value === "string") {
    if (/\bdocument\s*\.\s*write\b|\bcreateElement\b/.test(value)) process.exit(1);
    const marker = "static/chunks/app/payment/page-";
    const expectedRelative = paymentAssetPath.slice("/_next/".length);
    let offset = value.indexOf(marker);
    while (offset !== -1) {
      const candidate = value.slice(offset);
      const match = candidate.match(
        /^static\/chunks\/app\/payment\/page-[A-Za-z0-9]+\.js/,
      );
      if (!match || match[0] !== expectedRelative ||
          /[A-Za-z0-9._~%/?#=&-]/.test(candidate[match[0].length] || "")) {
        process.exit(1);
      }
      offset = value.indexOf(marker, offset + marker.length);
    }
  } else if (Array.isArray(value)) {
    value.forEach(inspectFlightValue);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(inspectFlightValue);
  }
};

let nextFlightInitialized = false;
let nextFlightPayloads = 0;
const validateInlineNextFlight = source => {
  let offset = 0;
  const skipWhitespace = () => {
    while (/\s/.test(source[offset] || "")) offset += 1;
  };
  skipWhitespace();
  if (offset === source.length) process.exit(1);
  while (offset < source.length) {
    let bootstrap = false;
    const bootstrapPrefix = "(self.__next_f=self.__next_f||[]).push(";
    const payloadPrefix = "self.__next_f.push(";
    if (source.startsWith(bootstrapPrefix, offset)) {
      if (nextFlightInitialized) process.exit(1);
      bootstrap = true;
      offset += bootstrapPrefix.length;
    } else if (source.startsWith(payloadPrefix, offset)) {
      if (!nextFlightInitialized) process.exit(1);
      offset += payloadPrefix.length;
    } else {
      process.exit(1);
    }
    const parsed = parseJsonArrayAt(source, offset);
    offset = parsed.end;
    if (source[offset] !== ")") process.exit(1);
    offset += 1;
    if (bootstrap) {
      if (parsed.value.length !== 1 || parsed.value[0] !== 0) process.exit(1);
      nextFlightInitialized = true;
    } else {
      const validNullPayload = parsed.value.length === 2 &&
        parsed.value[0] === 2 && parsed.value[1] === null;
      const validDataPayload = parsed.value.length === 2 &&
        parsed.value[0] === 1 && typeof parsed.value[1] === "string";
      if (!validNullPayload && !validDataPayload) process.exit(1);
      inspectFlightValue(parsed.value);
      nextFlightPayloads += 1;
    }
    if (source[offset] === ";") offset += 1;
    skipWhitespace();
  }
};

const skipMarkupDeclaration = offset => {
  let cursor = offset;
  let quote = null;
  while (cursor < html.length) {
    const char = html[cursor];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return cursor + 1;
    }
    cursor += 1;
  }
  return -1;
};

let cursor = 0;
let executablePaymentReferences = 0;
let templateDepth = 0;
const foreignRoots = [];
const executableGraph = [];
while (cursor < html.length) {
  const opening = html.indexOf("<", cursor);
  if (opening === -1) break;
  cursor = opening;

  if (html.startsWith("<!--", cursor)) {
    // The HTML tokenizer also closes comments at --!> and treats <!--> / <!--->
    // as abruptly closed comments. Reject those malformed forms instead of
    // hiding browser-visible script tags until a later literal --> marker.
    if (html.startsWith("<!-->", cursor) || html.startsWith("<!--->", cursor)) {
      process.exit(1);
    }
    const end = html.indexOf("-->", cursor + 4);
    const bangEnd = html.indexOf("--!>", cursor + 4);
    if (bangEnd !== -1 && (end === -1 || bangEnd < end)) process.exit(1);
    if (end === -1) process.exit(1);
    cursor = end + 3;
    continue;
  }
  if (html.startsWith("<![CDATA[", cursor)) {
    const marker = foreignRoots.length > 0 ? "]]>": ">";
    const end = html.indexOf(marker, cursor + 9);
    if (end === -1) process.exit(1);
    cursor = end + marker.length;
    continue;
  }
  if (html.startsWith("<!", cursor) || html.startsWith("<?", cursor)) {
    const end = skipMarkupDeclaration(cursor + 2);
    if (end === -1) process.exit(1);
    cursor = end;
    continue;
  }
  if (html.startsWith("</", cursor)) {
    const closing = parseEndTag(cursor);
    if (!closing || closing.ambiguous) process.exit(1);
    if (closing.name === "template") {
      if (templateDepth === 0) process.exit(1);
      templateDepth -= 1;
    }
    if (foreignRoots.length > 0 &&
        closing.name === foreignRoots[foreignRoots.length - 1]) {
      foreignRoots.pop();
    }
    cursor = closing.end;
    continue;
  }
  if (!/[A-Za-z]/.test(html[cursor + 1] || "")) {
    cursor += 1;
    continue;
  }

  const tag = parseStartTag(cursor);
  if (!tag) process.exit(1);
  const inForeignContent = foreignRoots.length > 0;
  const inTemplate = templateDepth > 0;
  // Character references are browser-decoded inside attributes. Current Next
  // output needs none, so reject them globally rather than letting a second
  // security-sensitive attribute decoder disagree with the browser.
  if ([...tag.attributes.values()].some(value =>
    typeof value === "string" && value.includes("&"))) process.exit(1);
  if ([...tag.attributes.keys()].some(name => /^on/i.test(name) || name === "srcdoc")) {
    process.exit(1);
  }
  if ([...tag.attributes.values()].some(value => typeof value === "string" &&
      /^(?:javascript|vbscript|data)\s*:/i.test(trimAsciiWhitespace(value)))) {
    process.exit(1);
  }
  if (["embed", "iframe", "object"].includes(tag.name)) process.exit(1);
  const activeHtmlScript = !inForeignContent && !inTemplate &&
    tag.name === "script";
  if (activeHtmlScript && ["src", "type", "language"].some(attributeName => {
    const attributeValue = tag.attributes.get(attributeName);
    return typeof attributeValue === "string" && attributeValue.includes("&");
  })) process.exit(1);
  if (activeHtmlScript && tag.attributes.has("type")) {
    const scriptType = asciiLower(trimAsciiWhitespace(
      tag.attributes.get("type") ?? "",
    ));
    if (scriptType === "importmap" || scriptType === "speculationrules") {
      process.exit(1);
    }
  }
  const activeExecutableScript = activeHtmlScript &&
    isExecutableScript(tag.attributes);
  const scriptHasSrc = tag.attributes.has("src");
  const scriptSrc = tag.attributes.get("src");
  let executableScriptDescriptor = null;

  // Any active HTML base element can redirect a root-relative script URL to a
  // different origin. Reject every static base href, including conservative
  // foreign/template cases that this small parser does not namespace-resolve.
  if (tag.name === "base" && tag.attributes.has("href")) process.exit(1);

  // SVG/MathML integration points can switch descendants back to the HTML
  // parser. Reject any tag that could open an inert or non-data HTML tokenizer
  // state while our conservative namespace tracker still considers it foreign.
  if (inForeignContent && foreignHtmlParserStateElements.has(tag.name)) {
    process.exit(1);
  }

  if (!inForeignContent && !inTemplate && tag.name === "meta" &&
      tag.attributes.has("http-equiv")) {
    const rawHttpEquiv = tag.attributes.get("http-equiv") ?? "";
    const httpEquiv = asciiLower(trimAsciiWhitespace(rawHttpEquiv));
    if (httpEquiv === "content-security-policy" ||
        httpEquiv === "content-security-policy-report-only" ||
        httpEquiv === "refresh") process.exit(1);
  }

  if (activeExecutableScript) {
    if ([...executionInvalidatingAttributes]
      .some(attributeName => tag.attributes.has(attributeName))) process.exit(1);
    if (scriptHasSrc) {
      if (typeof scriptSrc !== "string" || scriptSrc.includes("&") ||
          !/^\/_next\/static\/chunks\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(scriptSrc)) {
        process.exit(1);
      }
      let resolved;
      try { resolved = new URL(scriptSrc, `${documentOriginValue}/payment`); }
      catch { process.exit(1); }
      if (resolved.origin !== documentOriginValue || resolved.pathname !== scriptSrc ||
          resolved.search || resolved.hash) process.exit(1);
      if (scriptSrc.includes("/_next/static/chunks/app/payment/page-")) {
        const ambiguous = [...ambiguousExecutableAttributes]
          .some(attributeName => tag.attributes.has(attributeName));
        if (ambiguous || scriptSrc !== paymentAssetPath) process.exit(1);
        executablePaymentReferences += 1;
      }
      executableScriptDescriptor = {
        attributes: sortedAttributes(tag.attributes),
        kind: "external",
        src: scriptSrc,
      };
    } else if ([...ambiguousExecutableAttributes]
      .some(attributeName => tag.attributes.has(attributeName))) {
      process.exit(1);
    }
  }

  // In the HTML namespace, a self-closing flag is ignored for non-void
  // elements. In particular, <template/>, <plaintext/> and raw-text/RCDATA
  // start tags remain open. Foreign-content self-closing flags are honoured.
  if (!inForeignContent && tag.name === "template") templateDepth += 1;
  if ((tag.name === "svg" || tag.name === "math") && !tag.selfClosing) {
    foreignRoots.push(tag.name);
  }

  cursor = tag.end;
  if (!inForeignContent && tag.name === "plaintext") {
    cursor = html.length;
  } else if (tag.name === "script" || rawTextElements.has(tag.name) ||
      rcdataElements.has(tag.name)) {
    if (tag.selfClosing && inForeignContent) continue;
    const rawTextEnd = findRawTextEnd(tag.name, cursor);
    if (rawTextEnd === -1) process.exit(1);
    if (activeExecutableScript) {
      const source = html.slice(cursor, rawTextEnd.closeStart);
      if (scriptHasSrc) {
        if (trimAsciiWhitespace(source) !== "" || !executableScriptDescriptor) {
          process.exit(1);
        }
        executableGraph.push(executableScriptDescriptor);
      } else {
        validateInlineNextFlight(source);
        executableGraph.push({
          attributes: sortedAttributes(tag.attributes),
          kind: "inline-next-flight",
          sha256: sha256(source),
        });
      }
    }
    cursor = rawTextEnd.end;
  }
}
if (executablePaymentReferences !== 1 || templateDepth !== 0 ||
    foreignRoots.length !== 0 ||
    (nextFlightInitialized && nextFlightPayloads < 1)) process.exit(1);
process.stdout.write(sha256(JSON.stringify(executableGraph)));
NODE
}

platform_frontend_attestation_content_type_is_html() {
	local value pattern LC_ALL=C
	[[ $# -eq 1 ]] || return 1
	value="$1"
	pattern='^[Tt][Ee][Xx][Tt]/[Hh][Tt][Mm][Ll]([ ]*;[ ]*[Cc][Hh][Aa][Rr][Ss][Ee][Tt][ ]*=[ ]*[Uu][Tt][Ff]-8[ ]*)?$'
	[[ -n "$value" && "$value" != *[![:print:]]* && "$value" =~ $pattern ]]
}

platform_frontend_attestation_response_headers_are_safe() {
	local path="$1"
	[[ $# -eq 1 && -f "$path" && ! -L "$path" ]] || return 1
	LC_ALL=C awk '
		BEGIN { status = 0; ended = 0 }
		{
			line = $0
			if (substr(line, length(line), 1) == "\r") {
				line = substr(line, 1, length(line) - 1)
			}
			if (line ~ /[^ -~]/) exit 1
			if (ended) {
				if (line != "") exit 1
				next
			}
			if (!status) {
				if (line !~ /^HTTP\/(1\.[01]|2|3) 200( [ -~]*)?$/) exit 1
				status = 1
				next
			}
			if (line == "") {
				ended = 1
				next
			}
			separator = index(line, ":")
			if (separator < 2) exit 1
			name = substr(line, 1, separator - 1)
			if (name !~ /^[A-Za-z0-9-]+$/) exit 1
			name = tolower(name)
			if (name == "content-security-policy" ||
				name == "content-security-policy-report-only") exit 1
		}
		END { if (status != 1 || ended != 1) exit 1 }
	' "$path"
}

platform_frontend_attestation_port_binding_parser() {
	cat <<'NODE'
let bindings;
try { bindings = JSON.parse(process.env.PORT_BINDINGS); }
catch { process.exit(1); }
if (!Array.isArray(bindings) || bindings.length !== 1 ||
    bindings[0]?.HostIp !== "127.0.0.1" ||
    !/^[1-9][0-9]{0,4}$/.test(bindings[0]?.HostPort || "")) process.exit(1);
const port = Number(bindings[0].HostPort);
if (!Number.isInteger(port) || port > 65535) process.exit(1);
process.stdout.write(String(port));
NODE
}

platform_frontend_attestation_json_validator() {
	cat <<'NODE'
const { readFileSync } = require("node:fs");
const path = process.env.ATTESTATION_PATH || "/attestation.json";
let value;
try { value = JSON.parse(readFileSync(path, "utf8")); }
catch { process.exit(1); }
const keys = [
  "version", "purpose", "backendRevision", "cutoverGeneration",
  "frontendRevision", "verificationMode", "origin", "challenge", "composeProject",
  "composeService", "containerId", "imageId", "appRevision",
  "imageRevision", "status", "health", "restarting", "restartCount",
  "containerHostPort", "buildId", "buildManifestPath",
  "buildManifestSha256", "appBuildManifestSha256", "paymentAssetPath",
  "paymentAssetSha256", "paymentServerPath", "paymentServerSha256",
  "paymentReferenceManifestPath", "paymentReferenceManifestSha256",
  "localPaymentHtmlSha256", "publicPaymentHtmlSha256",
  "paymentExecutableGraphSha256",
  "contractDefenseScan", "localPaymentHttp", "publicPaymentHttp",
  "verifiedAt",
];
const exact = value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
let origin;
try { origin = new URL(value.origin); } catch { process.exit(1); }
const verifiedAt = Date.parse(value.verifiedAt);
const maxAgeSeconds = Number(process.env.MAX_AGE_SECONDS);
const ageMs = Date.now() - verifiedAt;
if (!exact || value.version !== 3 ||
    value.purpose !== "platform-frontend-runtime" ||
    value.backendRevision !== process.env.EXPECTED_BACKEND_REVISION ||
    value.frontendRevision !== process.env.EXPECTED_FRONTEND_REVISION ||
    value.frontendRevision !== "7dfc706feff5a8c70bc6fa03af726926e7d3dd15" ||
    value.verificationMode !== "pinned-hard-cutover-integrity" ||
    value.cutoverGeneration !== process.env.EXPECTED_CUTOVER_GENERATION ||
    value.challenge !== process.env.EXPECTED_CHALLENGE ||
    value.origin !== process.env.EXPECTED_ORIGIN ||
    origin.protocol !== "https:" || origin.origin !== value.origin ||
    origin.href !== `${value.origin}/` || origin.username || origin.password ||
    origin.search || origin.hash ||
    value.composeProject !== "winwidget" || value.composeService !== "client" ||
    !/^[0-9a-f]{64}$/.test(value.containerId) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.imageId) ||
    value.appRevision !== value.frontendRevision ||
    value.imageRevision !== value.frontendRevision ||
    value.status !== "running" ||
    !["healthy", "not-configured"].includes(value.health) ||
    value.restarting !== false || value.restartCount !== 0 ||
    !Number.isInteger(value.containerHostPort) || value.containerHostPort < 1 ||
    value.containerHostPort > 65535 ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value.buildId) ||
    value.buildManifestPath !== `/_next/static/${value.buildId}/_buildManifest.js` ||
    !/^[0-9a-f]{64}$/.test(value.buildManifestSha256) ||
    !/^[0-9a-f]{64}$/.test(value.appBuildManifestSha256) ||
    !/^\/_next\/static\/chunks\/app\/payment\/page-[A-Za-z0-9]+\.js$/.test(value.paymentAssetPath) ||
    !/^[0-9a-f]{64}$/.test(value.paymentAssetSha256) ||
    value.paymentServerPath !== "server/app/payment/page.js" ||
    !/^[0-9a-f]{64}$/.test(value.paymentServerSha256) ||
    value.paymentReferenceManifestPath !== "server/app/payment/page_client-reference-manifest.js" ||
    !/^[0-9a-f]{64}$/.test(value.paymentReferenceManifestSha256) ||
    !/^[0-9a-f]{64}$/.test(value.localPaymentHtmlSha256) ||
    !/^[0-9a-f]{64}$/.test(value.publicPaymentHtmlSha256) ||
    !/^[0-9a-f]{64}$/.test(value.paymentExecutableGraphSha256) ||
    value.contractDefenseScan !== false ||
    value.localPaymentHttp !== true || value.publicPaymentHttp !== true ||
    typeof value.verifiedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.verifiedAt) ||
    !Number.isFinite(verifiedAt) || !Number.isInteger(maxAgeSeconds) ||
    maxAgeSeconds < 60 || maxAgeSeconds > 3600 || ageMs < -120000 ||
    ageMs > maxAgeSeconds * 1000) process.exit(1);
process.stdout.write([
  value.buildId,
  value.buildManifestPath,
  value.buildManifestSha256,
  value.paymentAssetPath,
  value.paymentAssetSha256,
  value.localPaymentHtmlSha256,
  value.publicPaymentHtmlSha256,
  value.paymentExecutableGraphSha256,
  value.verifiedAt,
].join("|"));
NODE
}

platform_frontend_attestation_fetch_local() {
	local url="$1" output="$2" expected_type="${3:-}" metadata code content_type
	local redirect_count headers
	headers="$(mktemp "$(dirname -- "$output")/.platform-frontend-response-headers.XXXXXX")" || return 1
	if ! code="$(curl --noproxy '*' --max-redirs 0 -fsS --connect-timeout 2 --max-time 10 \
		--max-filesize "$PLATFORM_FRONTEND_ATTESTATION_MAX_HTTP_FILE_SIZE" \
		--dump-header "$headers" --write-out '%{http_code}|%{content_type}|%{num_redirects}' \
		--output "$output" "$url")"; then
		rm -f -- "$headers"
		return 1
	fi
	metadata="$code"
	IFS='|' read -r code content_type redirect_count <<<"$metadata"
	if [[ "$code" != '200' || "$redirect_count" != '0' ]] ||
		! platform_frontend_attestation_response_headers_are_safe "$headers"; then
		rm -f -- "$headers"
		platform_frontend_attestation_fail \
			"Exact local frontend resource did not return one CSP-free HTTP 200 response: $url"
		return 1
	fi
	rm -f -- "$headers"
	if [[ -n "$expected_type" ]]; then
		if [[ "$expected_type" != html ]] ||
			! platform_frontend_attestation_content_type_is_html "$content_type"; then
			platform_frontend_attestation_fail \
				"Exact local frontend resource returned an unexpected media type: $url" || return 1
		fi
	fi
}

platform_frontend_attestation_fetch_public() {
	local url="$1" output="$2" expected_type="${3:-}" metadata code content_type
	local redirect_count headers
	headers="$(mktemp "$(dirname -- "$output")/.platform-frontend-response-headers.XXXXXX")" || return 1
	if ! code="$(curl --noproxy '*' --proto '=https' --tlsv1.2 --max-redirs 0 -fsS \
		--connect-timeout 5 --max-time 20 \
		--max-filesize "$PLATFORM_FRONTEND_ATTESTATION_MAX_HTTP_FILE_SIZE" \
		--dump-header "$headers" --write-out '%{http_code}|%{content_type}|%{num_redirects}' \
		--output "$output" "$url")"; then
		rm -f -- "$headers"
		return 1
	fi
	metadata="$code"
	IFS='|' read -r code content_type redirect_count <<<"$metadata"
	if [[ "$code" != '200' || "$redirect_count" != '0' ]] ||
		! platform_frontend_attestation_response_headers_are_safe "$headers"; then
		rm -f -- "$headers"
		platform_frontend_attestation_fail \
			"Exact public frontend resource did not return one CSP-free HTTP 200 response: $url"
		return 1
	fi
	rm -f -- "$headers"
	if [[ -n "$expected_type" ]]; then
		if [[ "$expected_type" != html ]] ||
			! platform_frontend_attestation_content_type_is_html "$content_type"; then
			platform_frontend_attestation_fail \
				"Exact public frontend resource returned an unexpected media type: $url" || return 1
		fi
	fi
}

platform_frontend_attestation_bootstrap_key() (
	set -Eeuo pipefail
	umask 077
	platform_frontend_attestation_require_root
	platform_frontend_attestation_require_command openssl

	local output_root="${PLATFORM_FRONTEND_ATTESTATION_ROOT:-/opt/winwidget/deploy/frontend}"
	local private_key="${PLATFORM_FRONTEND_ATTESTATION_PRIVATE_KEY:-$output_root/platform-frontend-runtime-attestation-v2.private.pem}"
	local public_key="${PLATFORM_FRONTEND_ATTESTATION_PUBLIC_KEY:-$output_root/platform-frontend-runtime-attestation-v2.public.pem}"
	local attestation="${PLATFORM_FRONTEND_ATTESTATION_FILE:-$output_root/platform-frontend-runtime-attestation-v2.json}"
	local signature="${PLATFORM_FRONTEND_ATTESTATION_SIGNATURE:-$output_root/platform-frontend-runtime-attestation-v2.sig}"
	local lock_file="${PLATFORM_FRONTEND_ATTESTATION_LOCK_FILE:-$output_root/.platform-frontend-runtime-attestation-v2.lock}"
	local private_tmp='' public_tmp='' value

	platform_frontend_attestation_require_safe_directory "$output_root"
	for value in "$private_key" "$public_key" "$attestation" "$signature" "$lock_file"; do
		platform_frontend_attestation_require_direct_child "$output_root" "$value"
	done
	platform_frontend_attestation_require_distinct_paths \
		"$private_key" "$public_key" "$attestation" "$signature" "$lock_file"
	platform_frontend_attestation_acquire_lock "$lock_file"
	trap 'rm -f -- "$private_tmp" "$public_tmp"' EXIT

	if [[ ! -e "$private_key" && ! -L "$private_key" ]]; then
		[[ ! -e "$public_key" && ! -L "$public_key" ]] ||
			platform_frontend_attestation_fail \
				'Cannot bootstrap a private key while an unmatched public key already exists.' || return 1
		private_tmp="$(mktemp "$output_root/.platform-frontend-private-key.XXXXXX")"
		openssl genpkey -algorithm ED25519 -out "$private_tmp" >/dev/null 2>&1
		chown 0:0 "$private_tmp"
		chmod 600 "$private_tmp"
		platform_frontend_attestation_require_ed25519_private_key "$private_tmp"
		mv -f "$private_tmp" "$private_key"
		private_tmp=''
	fi
	platform_frontend_attestation_require_safe_file "$private_key" \
		'Platform frontend attestation private key'
	platform_frontend_attestation_require_ed25519_private_key "$private_key"
	public_tmp="$(mktemp "$output_root/.platform-frontend-public-key.XXXXXX")"
	openssl pkey -in "$private_key" -pubout -out "$public_tmp"
	chown 0:0 "$public_tmp"
	chmod 600 "$public_tmp"
	platform_frontend_attestation_require_ed25519_public_key "$public_tmp"
	if [[ -e "$public_key" || -L "$public_key" ]]; then
		platform_frontend_attestation_require_safe_file "$public_key" \
			'Platform frontend attestation public key'
		platform_frontend_attestation_require_ed25519_public_key "$public_key"
		[[ "$(platform_frontend_attestation_sha256 "$public_key")" == \
			"$(platform_frontend_attestation_sha256 "$public_tmp")" ]] ||
			platform_frontend_attestation_fail \
				'Existing Platform frontend public key does not match the private key.' || return 1
		rm -f -- "$public_tmp"
		public_tmp=''
	else
		mv -f "$public_tmp" "$public_key"
		public_tmp=''
	fi
	printf 'platform_frontend_runtime_key_bootstrap=complete\n'
	printf 'platform_frontend_runtime_trusted_public_key_sha256=%s\n' \
		"$(platform_frontend_attestation_sha256 "$public_key")"
)

platform_frontend_attestation_generate() (
	set -Eeuo pipefail
	umask 077
	platform_frontend_attestation_require_root
	platform_frontend_attestation_require_command docker
	platform_frontend_attestation_require_command curl
	platform_frontend_attestation_require_command openssl
	platform_frontend_attestation_require_identity

	local backend_revision="$PLATFORM_BACKEND_REVISION"
	local frontend_revision="$PLATFORM_FRONTEND_REVISION"
	local generation="$PLATFORM_CUTOVER_GENERATION"
	local challenge="$PLATFORM_FRONTEND_RUNTIME_CHALLENGE"
	local origin="$PLATFORM_FRONTEND_ORIGIN"
	local output_root="${PLATFORM_FRONTEND_ATTESTATION_ROOT:-/opt/winwidget/deploy/frontend}"
	local private_key="${PLATFORM_FRONTEND_ATTESTATION_PRIVATE_KEY:-$output_root/platform-frontend-runtime-attestation-v2.private.pem}"
	local public_key="${PLATFORM_FRONTEND_ATTESTATION_PUBLIC_KEY:-$output_root/platform-frontend-runtime-attestation-v2.public.pem}"
	local attestation="${PLATFORM_FRONTEND_ATTESTATION_FILE:-$output_root/platform-frontend-runtime-attestation-v2.json}"
	local signature="${PLATFORM_FRONTEND_ATTESTATION_SIGNATURE:-$output_root/platform-frontend-runtime-attestation-v2.sig}"
	local lock_file="${PLATFORM_FRONTEND_ATTESTATION_LOCK_FILE:-$output_root/.platform-frontend-runtime-attestation-v2.lock}"
	local container_id compose_project compose_service status health restarting
	local restart_count app_revision image_id image_revision runtime_user mount_count
	local port_bindings port_parser container_host_port evidence scanner value
	local build_id build_manifest_path build_manifest_sha app_build_manifest_sha
	local payment_asset_path payment_asset_sha payment_server_path payment_server_sha
	local payment_reference_path payment_reference_sha verified_at validator
	local public_tmp='' attestation_tmp='' signature_tmp=''
	local local_payment_tmp='' public_payment_tmp='' local_build_tmp='' public_build_tmp=''
	local local_asset_tmp='' public_asset_tmp='' html_validator current_container_id
	local local_payment_html_sha public_payment_html_sha
	local local_payment_graph_sha public_payment_graph_sha payment_graph_sha

	platform_frontend_attestation_require_safe_directory "$output_root"
	[[ "$frontend_revision" == \
		"$PLATFORM_FRONTEND_ATTESTATION_HARD_CUTOVER_FRONTEND_REVISION" ]] ||
		platform_frontend_attestation_fail \
			'Platform hard-cutover attestation is pinned to the reviewed frontend revision.' || return 1
	for value in "$private_key" "$public_key" "$attestation" "$signature" "$lock_file"; do
		platform_frontend_attestation_require_direct_child "$output_root" "$value"
	done
	platform_frontend_attestation_require_distinct_paths \
		"$private_key" "$public_key" "$attestation" "$signature" "$lock_file"
	platform_frontend_attestation_acquire_lock "$lock_file"
	for value in "$private_key" "$public_key"; do
		platform_frontend_attestation_require_safe_file "$value" \
			'Platform frontend attestation key'
	done
	platform_frontend_attestation_require_ed25519_private_key "$private_key"
	platform_frontend_attestation_require_ed25519_public_key "$public_key"
	public_tmp="$(mktemp "$output_root/.platform-frontend-derived-public-key.XXXXXX")"
	openssl pkey -in "$private_key" -pubout -out "$public_tmp"
	[[ "$(platform_frontend_attestation_sha256 "$public_key")" == \
		"$(platform_frontend_attestation_sha256 "$public_tmp")" ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend public and private attestation keys do not match.' || return 1
	rm -f -- "$public_tmp"
	public_tmp=''
	for value in "$attestation" "$signature"; do
		if [[ -e "$value" || -L "$value" ]]; then
			platform_frontend_attestation_require_safe_file "$value" \
				'Existing Platform frontend attestation artifact'
		fi
	done

	container_id="$(docker ps --no-trunc -q \
		--filter "label=com.docker.compose.project=$PLATFORM_FRONTEND_ATTESTATION_PROJECT" \
		--filter "label=com.docker.compose.service=$PLATFORM_FRONTEND_ATTESTATION_SERVICE")" || return 1
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend attestation requires exactly one running WinWidget client container.' || return 1
	compose_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container_id")"
	compose_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id")"
	status="$(docker inspect --format '{{.State.Status}}' "$container_id")"
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$container_id")"
	restarting="$(docker inspect --format '{{.State.Restarting}}' "$container_id")"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	runtime_user="$(docker inspect --format '{{.Config.User}}' "$container_id")"
	mount_count="$(docker inspect --format '{{len .Mounts}}' "$container_id")"
	app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^APP_REVISION=//p')"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
	[[ "$compose_project" == "$PLATFORM_FRONTEND_ATTESTATION_PROJECT" &&
		"$compose_service" == "$PLATFORM_FRONTEND_ATTESTATION_SERVICE" &&
		"$status" == 'running' &&
		( "$health" == 'healthy' || "$health" == 'not-configured' ) &&
		"$restarting" == 'false' && "$restart_count" == '0' &&
		( "$runtime_user" == 'nextjs' || "$runtime_user" == '1001' ||
			"$runtime_user" == '1001:1001' ) && "$mount_count" == '0' &&
		"$app_revision" == "$frontend_revision" &&
		"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$image_revision" == "$frontend_revision" ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend container/image runtime identity is unsafe.' || return 1

	port_bindings="$(docker inspect --format '{{json (index .NetworkSettings.Ports "3000/tcp")}}' "$container_id")" || return 1
	port_parser="$(platform_frontend_attestation_port_binding_parser)"
	container_host_port="$(docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "PORT_BINDINGS=$port_bindings" --entrypoint node "$image_id" \
		-e "$port_parser")" ||
		platform_frontend_attestation_fail \
			'WinWidget client must expose container port 3000 through exactly one 127.0.0.1 host binding.' || return 1

	scanner="$(platform_frontend_attestation_build_evidence_scanner)"
	evidence="$(docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 192m --cpus 0.5 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		-e CONTRACT_ROOT=/app/.next \
		-e "CONTRACT_INTEGRITY_ONLY_REVISION=$frontend_revision" \
		--entrypoint node "$image_id" \
		-e "$scanner")" ||
		platform_frontend_attestation_fail \
			'Frontend image lacks exact pinned Next build evidence.' || return 1
	IFS='|' read -r build_id build_manifest_path build_manifest_sha \
		app_build_manifest_sha payment_asset_path payment_asset_sha \
		payment_server_path payment_server_sha payment_reference_path \
		payment_reference_sha <<<"$evidence"
	[[ "$build_id" =~ ^[A-Za-z0-9_-]{8,128}$ &&
		"$build_manifest_path" == "/_next/static/$build_id/_buildManifest.js" &&
		"$build_manifest_sha" =~ ^[0-9a-f]{64}$ &&
		"$app_build_manifest_sha" =~ ^[0-9a-f]{64}$ &&
		"$payment_asset_path" =~ ^/_next/static/chunks/app/payment/page-[A-Za-z0-9]+\.js$ &&
		"$payment_asset_sha" =~ ^[0-9a-f]{64}$ &&
		"$payment_server_path" == 'server/app/payment/page.js' &&
		"$payment_server_sha" =~ ^[0-9a-f]{64}$ &&
		"$payment_reference_path" == 'server/app/payment/page_client-reference-manifest.js' &&
		"$payment_reference_sha" =~ ^[0-9a-f]{64}$ ]] || return 1

	trap 'rm -f -- "$public_tmp" "$attestation_tmp" "$signature_tmp" "$local_payment_tmp" "$public_payment_tmp" "$local_build_tmp" "$public_build_tmp" "$local_asset_tmp" "$public_asset_tmp"' EXIT
	local_payment_tmp="$(mktemp "$output_root/.platform-frontend-local-payment.XXXXXX")"
	public_payment_tmp="$(mktemp "$output_root/.platform-frontend-public-payment.XXXXXX")"
	local_build_tmp="$(mktemp "$output_root/.platform-frontend-local-build.XXXXXX")"
	public_build_tmp="$(mktemp "$output_root/.platform-frontend-public-build.XXXXXX")"
	local_asset_tmp="$(mktemp "$output_root/.platform-frontend-local-asset.XXXXXX")"
	public_asset_tmp="$(mktemp "$output_root/.platform-frontend-public-asset.XXXXXX")"
	platform_frontend_attestation_fetch_local \
		"http://127.0.0.1:$container_host_port/payment" "$local_payment_tmp" html
	platform_frontend_attestation_fetch_public "$origin/payment" "$public_payment_tmp" html
	local_payment_html_sha="$(platform_frontend_attestation_sha256 "$local_payment_tmp")"
	public_payment_html_sha="$(platform_frontend_attestation_sha256 "$public_payment_tmp")"
	[[ "$local_payment_html_sha" =~ ^[0-9a-f]{64}$ &&
		"$public_payment_html_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	platform_frontend_attestation_fetch_local \
		"http://127.0.0.1:$container_host_port$build_manifest_path" "$local_build_tmp"
	platform_frontend_attestation_fetch_public "$origin$build_manifest_path" "$public_build_tmp"
	platform_frontend_attestation_fetch_local \
		"http://127.0.0.1:$container_host_port$payment_asset_path" "$local_asset_tmp"
	platform_frontend_attestation_fetch_public "$origin$payment_asset_path" "$public_asset_tmp"
	for value in "$local_build_tmp" "$public_build_tmp"; do
		[[ "$(platform_frontend_attestation_sha256 "$value")" == "$build_manifest_sha" ]] ||
			platform_frontend_attestation_fail \
				'Exact Next BUILD_ID manifest does not match the inspected frontend image.' || return 1
	done
	for value in "$local_asset_tmp" "$public_asset_tmp"; do
		[[ "$(platform_frontend_attestation_sha256 "$value")" == "$payment_asset_sha" ]] ||
			platform_frontend_attestation_fail \
				'Exact payment page asset does not match the inspected frontend image.' || return 1
	done
	html_validator="$(platform_frontend_attestation_payment_html_validator)"
	local_payment_graph_sha="$(docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "EXPECTED_PAYMENT_ASSET_PATH=$payment_asset_path" \
		-e "EXPECTED_DOCUMENT_ORIGIN=http://127.0.0.1:$container_host_port" \
		-v "$local_payment_tmp:/payment.html:ro" --entrypoint node "$image_id" \
		-e "$html_validator")" ||
		platform_frontend_attestation_fail \
			'Local payment page does not match the inspected executable graph.' || return 1
	public_payment_graph_sha="$(docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "EXPECTED_PAYMENT_ASSET_PATH=$payment_asset_path" \
		-e "EXPECTED_DOCUMENT_ORIGIN=$origin" \
		-v "$public_payment_tmp:/payment.html:ro" --entrypoint node "$image_id" \
		-e "$html_validator")" ||
		platform_frontend_attestation_fail \
			'Public payment page does not match the inspected executable graph.' || return 1
	[[ "$local_payment_graph_sha" =~ ^[0-9a-f]{64}$ &&
		"$public_payment_graph_sha" =~ ^[0-9a-f]{64}$ &&
		"$local_payment_graph_sha" == "$public_payment_graph_sha" ]] ||
		platform_frontend_attestation_fail \
			'Local and public payment pages expose different executable graphs.' || return 1
	[[ "$(platform_frontend_attestation_sha256 "$local_payment_tmp")" == \
		"$local_payment_html_sha" &&
		"$(platform_frontend_attestation_sha256 "$public_payment_tmp")" == \
		"$public_payment_html_sha" ]] ||
		platform_frontend_attestation_fail \
			'Payment HTML changed between exact hashing and executable-graph inspection.' || return 1
	payment_graph_sha="$local_payment_graph_sha"
	current_container_id="$(docker ps --no-trunc -q \
		--filter "label=com.docker.compose.project=$PLATFORM_FRONTEND_ATTESTATION_PROJECT" \
		--filter "label=com.docker.compose.service=$PLATFORM_FRONTEND_ATTESTATION_SERVICE")" || return 1
	[[ "$current_container_id" == "$container_id" &&
		"$(docker inspect --format '{{.Image}}|{{.State.Status}}|{{.State.Restarting}}|{{.RestartCount}}' "$container_id")" == "$image_id|running|false|0" ]] ||
		platform_frontend_attestation_fail \
			'Frontend container changed while runtime evidence was being generated.' || return 1

	verified_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	attestation_tmp="$(mktemp "$output_root/.platform-frontend-attestation.XXXXXX")"
	signature_tmp="$(mktemp "$output_root/.platform-frontend-signature.XXXXXX")"
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "BACKEND_REVISION=$backend_revision" \
		-e "CUTOVER_GENERATION=$generation" \
		-e "FRONTEND_REVISION=$frontend_revision" \
		-e "FRONTEND_ORIGIN=$origin" -e "CHALLENGE=$challenge" \
		-e "CONTAINER_ID=$container_id" -e "IMAGE_ID=$image_id" \
		-e "IMAGE_REVISION=$image_revision" -e "STATUS=$status" \
		-e "HEALTH=$health" -e "RESTARTING=$restarting" \
		-e "RESTART_COUNT=$restart_count" -e "HOST_PORT=$container_host_port" \
		-e "BUILD_ID=$build_id" -e "BUILD_MANIFEST_PATH=$build_manifest_path" \
		-e "BUILD_MANIFEST_SHA=$build_manifest_sha" \
		-e "APP_BUILD_MANIFEST_SHA=$app_build_manifest_sha" \
		-e "PAYMENT_ASSET_PATH=$payment_asset_path" -e "PAYMENT_ASSET_SHA=$payment_asset_sha" \
		-e "PAYMENT_SERVER_PATH=$payment_server_path" -e "PAYMENT_SERVER_SHA=$payment_server_sha" \
		-e "PAYMENT_REFERENCE_PATH=$payment_reference_path" \
		-e "PAYMENT_REFERENCE_SHA=$payment_reference_sha" \
		-e "LOCAL_PAYMENT_HTML_SHA=$local_payment_html_sha" \
		-e "PUBLIC_PAYMENT_HTML_SHA=$public_payment_html_sha" \
		-e "PAYMENT_EXECUTABLE_GRAPH_SHA=$payment_graph_sha" \
		-e "VERIFIED_AT=$verified_at" \
		--entrypoint node "$image_id" -e '
const value = {
  version: 3,
  purpose: "platform-frontend-runtime",
  backendRevision: process.env.BACKEND_REVISION,
  cutoverGeneration: process.env.CUTOVER_GENERATION,
  frontendRevision: process.env.FRONTEND_REVISION,
  verificationMode: "pinned-hard-cutover-integrity",
  origin: process.env.FRONTEND_ORIGIN,
  challenge: process.env.CHALLENGE,
  composeProject: "winwidget",
  composeService: "client",
  containerId: process.env.CONTAINER_ID,
  imageId: process.env.IMAGE_ID,
  appRevision: process.env.FRONTEND_REVISION,
  imageRevision: process.env.IMAGE_REVISION,
  status: process.env.STATUS,
  health: process.env.HEALTH,
  restarting: process.env.RESTARTING === "true",
  restartCount: Number(process.env.RESTART_COUNT),
  containerHostPort: Number(process.env.HOST_PORT),
  buildId: process.env.BUILD_ID,
  buildManifestPath: process.env.BUILD_MANIFEST_PATH,
  buildManifestSha256: process.env.BUILD_MANIFEST_SHA,
  appBuildManifestSha256: process.env.APP_BUILD_MANIFEST_SHA,
  paymentAssetPath: process.env.PAYMENT_ASSET_PATH,
  paymentAssetSha256: process.env.PAYMENT_ASSET_SHA,
  paymentServerPath: process.env.PAYMENT_SERVER_PATH,
  paymentServerSha256: process.env.PAYMENT_SERVER_SHA,
  paymentReferenceManifestPath: process.env.PAYMENT_REFERENCE_PATH,
  paymentReferenceManifestSha256: process.env.PAYMENT_REFERENCE_SHA,
  localPaymentHtmlSha256: process.env.LOCAL_PAYMENT_HTML_SHA,
  publicPaymentHtmlSha256: process.env.PUBLIC_PAYMENT_HTML_SHA,
  paymentExecutableGraphSha256: process.env.PAYMENT_EXECUTABLE_GRAPH_SHA,
  contractDefenseScan: false,
  localPaymentHttp: true,
  publicPaymentHttp: true,
  verifiedAt: process.env.VERIFIED_AT,
};
process.stdout.write(`${JSON.stringify(value)}\n`);
' >"$attestation_tmp"
	validator="$(platform_frontend_attestation_json_validator)"
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "EXPECTED_BACKEND_REVISION=$backend_revision" \
		-e "EXPECTED_FRONTEND_REVISION=$frontend_revision" \
		-e "EXPECTED_CUTOVER_GENERATION=$generation" \
		-e "EXPECTED_CHALLENGE=$challenge" -e "EXPECTED_ORIGIN=$origin" \
		-e "MAX_AGE_SECONDS=$PLATFORM_FRONTEND_ATTESTATION_DEFAULT_MAX_AGE_SECONDS" \
		-v "$attestation_tmp:/attestation.json:ro" \
		--entrypoint node "$image_id" -e "$validator" >/dev/null
	openssl pkeyutl -sign -inkey "$private_key" -rawin \
		-in "$attestation_tmp" -out "$signature_tmp"
	openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
		-in "$attestation_tmp" -sigfile "$signature_tmp" >/dev/null
	for value in "$attestation_tmp" "$signature_tmp"; do
		chown 0:0 "$value"
		chmod 600 "$value"
	done
	# Publish the signature first and the signed generation manifest last. Any
	# interrupted or mixed handoff therefore remains fail-closed.
	mv -f "$signature_tmp" "$signature"
	signature_tmp=''
	mv -f "$attestation_tmp" "$attestation"
	attestation_tmp=''
	platform_frontend_attestation_require_safe_file "$attestation" \
		'Platform frontend runtime attestation'
	platform_frontend_attestation_require_safe_file "$signature" \
		'Platform frontend runtime attestation signature'
	openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
		-in "$attestation" -sigfile "$signature" >/dev/null

	printf 'platform_frontend_revision=%s\n' "$frontend_revision"
	printf 'platform_frontend_origin=%s\n' "$origin"
	printf 'platform_frontend_runtime_challenge=%s\n' "$challenge"
	printf 'platform_frontend_runtime_build_id=%s\n' "$build_id"
	printf 'platform_frontend_runtime_attestation_sha256=%s\n' \
		"$(platform_frontend_attestation_sha256 "$attestation")"
	printf 'platform_frontend_runtime_signature_sha256=%s\n' \
		"$(platform_frontend_attestation_sha256 "$signature")"
	printf 'platform_frontend_runtime_trusted_public_key_sha256=%s\n' \
		"$(platform_frontend_attestation_sha256 "$public_key")"
	printf 'platform_frontend_runtime_build_manifest_sha256=%s\n' "$build_manifest_sha"
	printf 'platform_frontend_runtime_payment_asset_path=%s\n' "$payment_asset_path"
	printf 'platform_frontend_runtime_payment_asset_sha256=%s\n' "$payment_asset_sha"
	printf 'platform_frontend_runtime_local_payment_html_sha256=%s\n' \
		"$local_payment_html_sha"
	printf 'platform_frontend_runtime_public_payment_html_sha256=%s\n' \
		"$public_payment_html_sha"
	printf 'platform_frontend_runtime_payment_executable_graph_sha256=%s\n' \
		"$payment_graph_sha"
)

platform_frontend_attestation_validate() (
	set -Eeuo pipefail
	umask 077
	platform_frontend_attestation_require_root
	platform_frontend_attestation_require_command docker
	platform_frontend_attestation_require_command curl
	platform_frontend_attestation_require_command openssl
	platform_frontend_attestation_require_identity

	local backend_revision="$PLATFORM_BACKEND_REVISION"
	local frontend_revision="$PLATFORM_FRONTEND_REVISION"
	local generation="$PLATFORM_CUTOVER_GENERATION"
	local challenge="$PLATFORM_FRONTEND_RUNTIME_CHALLENGE"
	local origin="$PLATFORM_FRONTEND_ORIGIN"
	local input_root="${PLATFORM_FRONTEND_ATTESTATION_ROOT:-/opt/winwidget/deploy/backend}"
	local public_key="${PLATFORM_FRONTEND_ATTESTATION_PUBLIC_KEY:-$input_root/platform-frontend-runtime-attestation-v2.public.pem}"
	local attestation="${PLATFORM_FRONTEND_ATTESTATION_FILE:-$input_root/platform-frontend-runtime-attestation-v2.json}"
	local signature="${PLATFORM_FRONTEND_ATTESTATION_SIGNATURE:-$input_root/platform-frontend-runtime-attestation-v2.sig}"
	local expected_attestation_sha="${PLATFORM_FRONTEND_EXPECTED_ATTESTATION_SHA256:-}"
	local expected_signature_sha="${PLATFORM_FRONTEND_EXPECTED_SIGNATURE_SHA256:-}"
	local trusted_public_key_sha="${PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256:-}"
	local max_age="${PLATFORM_FRONTEND_ATTESTATION_MAX_AGE_SECONDS:-$PLATFORM_FRONTEND_ATTESTATION_DEFAULT_MAX_AGE_SECONDS}"
	local validator_image_ref="${PLATFORM_FRONTEND_ATTESTATION_VALIDATOR_IMAGE:-winwidget-platform:git-$backend_revision}"
	local validator_image_id validator_image_revision validator value
	local attestation_sha signature_sha public_key_sha artifact
	local build_id build_manifest_path build_manifest_sha payment_asset_path
	local payment_asset_sha local_payment_html_sha public_payment_html_sha
	local payment_graph_sha verified_at build_tmp='' asset_tmp='' payment_tmp=''
	local html_validator public_payment_graph_sha

	[[ "$frontend_revision" == \
		"$PLATFORM_FRONTEND_ATTESTATION_HARD_CUTOVER_FRONTEND_REVISION" ]] ||
		platform_frontend_attestation_fail \
			'Platform hard-cutover validation is pinned to the reviewed frontend revision.' || return 1
	[[ "$expected_attestation_sha" =~ ^[0-9a-f]{64}$ &&
		"$expected_signature_sha" =~ ^[0-9a-f]{64}$ &&
		"$trusted_public_key_sha" =~ ^[0-9a-f]{64}$ &&
		"$max_age" =~ ^[0-9]{2,4}$ && "$max_age" -ge 60 && "$max_age" -le 3600 ]] ||
		platform_frontend_attestation_fail \
			'Exact attestation/signature pins, a pre-trusted public-key pin and a safe freshness limit are required.' || return 1
	platform_frontend_attestation_require_safe_directory "$input_root"
	for artifact in "$public_key" "$attestation" "$signature"; do
		platform_frontend_attestation_require_direct_child "$input_root" "$artifact"
	done
	platform_frontend_attestation_require_distinct_paths \
		"$public_key" "$attestation" "$signature"
	platform_frontend_attestation_require_safe_file "$public_key" \
		'Platform frontend attestation public key'
	platform_frontend_attestation_require_ed25519_public_key "$public_key"
	platform_frontend_attestation_require_safe_file "$attestation" \
		'Platform frontend runtime attestation'
	platform_frontend_attestation_require_safe_file "$signature" \
		'Platform frontend runtime attestation signature'
	attestation_sha="$(platform_frontend_attestation_sha256 "$attestation")"
	signature_sha="$(platform_frontend_attestation_sha256 "$signature")"
	public_key_sha="$(platform_frontend_attestation_sha256 "$public_key")"
	[[ "$attestation_sha" == "$expected_attestation_sha" &&
		"$signature_sha" == "$expected_signature_sha" &&
		"$public_key_sha" == "$trusted_public_key_sha" ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend runtime artifacts differ from the generation evidence or trusted key pin.' || return 1
	openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
		-in "$attestation" -sigfile "$signature" >/dev/null 2>&1 ||
		platform_frontend_attestation_fail \
			'Platform frontend runtime attestation signature is invalid.' || return 1

	validator_image_id="$(docker image inspect --format '{{.Id}}' "$validator_image_ref")" || return 1
	validator_image_revision="$(docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		"$validator_image_id")" || return 1
	[[ "$validator_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$validator_image_revision" == "$backend_revision" ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend attestation validator image is not bound to the backend revision.' || return 1
	validator="$(platform_frontend_attestation_json_validator)"
	value="$(docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "EXPECTED_BACKEND_REVISION=$backend_revision" \
		-e "EXPECTED_FRONTEND_REVISION=$frontend_revision" \
		-e "EXPECTED_CUTOVER_GENERATION=$generation" \
		-e "EXPECTED_CHALLENGE=$challenge" -e "EXPECTED_ORIGIN=$origin" \
		-e "MAX_AGE_SECONDS=$max_age" \
		-v "$attestation:/attestation.json:ro" \
		--entrypoint node "$validator_image_id" -e "$validator")" ||
		platform_frontend_attestation_fail \
			'Platform frontend runtime attestation is stale or does not match the live cutover identity.' || return 1
	IFS='|' read -r build_id build_manifest_path build_manifest_sha \
		payment_asset_path payment_asset_sha local_payment_html_sha \
		public_payment_html_sha payment_graph_sha verified_at <<<"$value"
	[[ "$build_id" =~ ^[A-Za-z0-9_-]{8,128}$ &&
		"$build_manifest_path" == "/_next/static/$build_id/_buildManifest.js" &&
		"$build_manifest_sha" =~ ^[0-9a-f]{64}$ &&
		"$payment_asset_path" =~ ^/_next/static/chunks/app/payment/page-[A-Za-z0-9]+\.js$ &&
		"$payment_asset_sha" =~ ^[0-9a-f]{64}$ &&
		"$local_payment_html_sha" =~ ^[0-9a-f]{64}$ &&
		"$public_payment_html_sha" =~ ^[0-9a-f]{64}$ &&
		"$payment_graph_sha" =~ ^[0-9a-f]{64}$ && -n "$verified_at" ]] || return 1

	trap 'rm -f -- "$build_tmp" "$asset_tmp" "$payment_tmp"' EXIT
	build_tmp="$(mktemp "${TMPDIR:-/tmp}/winwidget-platform-frontend-build.XXXXXX")"
	asset_tmp="$(mktemp "${TMPDIR:-/tmp}/winwidget-platform-frontend-asset.XXXXXX")"
	payment_tmp="$(mktemp "${TMPDIR:-/tmp}/winwidget-platform-frontend-payment.XXXXXX")"
	platform_frontend_attestation_fetch_public "$origin$build_manifest_path" "$build_tmp"
	platform_frontend_attestation_fetch_public "$origin$payment_asset_path" "$asset_tmp"
	platform_frontend_attestation_fetch_public "$origin/payment" "$payment_tmp" html
	[[ "$(platform_frontend_attestation_sha256 "$build_tmp")" == "$build_manifest_sha" &&
		"$(platform_frontend_attestation_sha256 "$asset_tmp")" == "$payment_asset_sha" &&
		"$(platform_frontend_attestation_sha256 "$payment_tmp")" == "$public_payment_html_sha" ]] ||
		platform_frontend_attestation_fail \
			'Public Next BUILD_ID/payment resources or HTML do not match the signed inspected image.' || return 1
	html_validator="$(platform_frontend_attestation_payment_html_validator)"
	public_payment_graph_sha="$(docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "EXPECTED_PAYMENT_ASSET_PATH=$payment_asset_path" \
		-e "EXPECTED_DOCUMENT_ORIGIN=$origin" \
		-v "$payment_tmp:/payment.html:ro" --entrypoint node "$validator_image_id" \
		-e "$html_validator")" ||
		platform_frontend_attestation_fail \
			'Public payment page is not served by the exact signed Next build.' || return 1
	[[ "$public_payment_graph_sha" == "$payment_graph_sha" ]] ||
		platform_frontend_attestation_fail \
			'Public payment executable graph differs from the signed inspected graph.' || return 1
	# Re-run freshness after network verification and re-hash every transferred
	# artifact so a concurrent or mixed-generation handoff cannot become valid.
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "EXPECTED_BACKEND_REVISION=$backend_revision" \
		-e "EXPECTED_FRONTEND_REVISION=$frontend_revision" \
		-e "EXPECTED_CUTOVER_GENERATION=$generation" \
		-e "EXPECTED_CHALLENGE=$challenge" -e "EXPECTED_ORIGIN=$origin" \
		-e "MAX_AGE_SECONDS=$max_age" \
		-v "$attestation:/attestation.json:ro" \
		--entrypoint node "$validator_image_id" -e "$validator" >/dev/null || return 1
	[[ "$(platform_frontend_attestation_sha256 "$attestation")" == "$attestation_sha" &&
		"$(platform_frontend_attestation_sha256 "$signature")" == "$signature_sha" &&
		"$(platform_frontend_attestation_sha256 "$public_key")" == "$public_key_sha" &&
		"$(platform_frontend_attestation_sha256 "$payment_tmp")" == "$public_payment_html_sha" ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend runtime artifacts changed during validation.' || return 1

	printf 'platform_frontend_runtime_attestation=valid\n'
	printf 'platform_frontend_revision=%s\n' "$frontend_revision"
	printf 'platform_frontend_origin=%s\n' "$origin"
	printf 'platform_frontend_runtime_challenge=%s\n' "$challenge"
	printf 'platform_frontend_runtime_build_id=%s\n' "$build_id"
	printf 'platform_frontend_runtime_attestation_sha256=%s\n' "$attestation_sha"
	printf 'platform_frontend_runtime_signature_sha256=%s\n' "$signature_sha"
	printf 'platform_frontend_runtime_trusted_public_key_sha256=%s\n' "$public_key_sha"
	printf 'platform_frontend_runtime_build_manifest_sha256=%s\n' "$build_manifest_sha"
	printf 'platform_frontend_runtime_payment_asset_path=%s\n' "$payment_asset_path"
	printf 'platform_frontend_runtime_payment_asset_sha256=%s\n' "$payment_asset_sha"
	printf 'platform_frontend_runtime_local_payment_html_sha256=%s\n' \
		"$local_payment_html_sha"
	printf 'platform_frontend_runtime_public_payment_html_sha256=%s\n' \
		"$public_payment_html_sha"
	printf 'platform_frontend_runtime_payment_executable_graph_sha256=%s\n' \
		"$payment_graph_sha"
	printf 'platform_frontend_runtime_verified_at=%s\n' "$verified_at"
)

platform_frontend_attestation_self_test() (
	set -Eeuo pipefail
	platform_frontend_attestation_require_command node
	platform_frontend_attestation_require_command openssl
	local root fixture_next payment_file admin_file payment_asset reference_file
	local scanner evidence html_validator port_parser validator expected_payment_asset
	local graph_first graph_second graph_third
	local private_key public_key rsa_key payload signature mixed_signature now stale
	local response_headers
	local backend_revision='0123456789abcdef0123456789abcdef01234567'
	local frontend_revision="$PLATFORM_FRONTEND_ATTESTATION_HARD_CUTOVER_FRONTEND_REVISION"
	local generation='7'
	local challenge='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	local origin='https://winwidget.ru'
	local container_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	local image_id='sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
	local build_id='CandidateBuild_123456'
	local build_manifest_sha='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
	local app_build_manifest_sha='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
	local payment_asset_sha='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
	local payment_server_sha='1111111111111111111111111111111111111111111111111111111111111111'
	local reference_sha='2222222222222222222222222222222222222222222222222222222222222222'
	local local_payment_html_sha='3333333333333333333333333333333333333333333333333333333333333333'
	local public_payment_html_sha='4444444444444444444444444444444444444444444444444444444444444444'
	local payment_graph_sha='5555555555555555555555555555555555555555555555555555555555555555'
	local payload_text

	root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-platform-frontend-attestation.XXXXXX")"
	trap 'rm -rf -- "$root"' EXIT
	fixture_next="$root/.next"
	payment_file="$fixture_next/server/app/payment/page.js"
	admin_file="$fixture_next/static/chunks/app/admin/settings/page-admin123.js"
	payment_asset="$fixture_next/static/chunks/app/payment/page-payment123.js"
	reference_file="$fixture_next/server/app/payment/page_client-reference-manifest.js"
	mkdir -p "$(dirname -- "$payment_file")" "$(dirname -- "$admin_file")" \
		"$(dirname -- "$payment_asset")" "$(dirname -- "$reference_file")" \
		"$fixture_next/static/$build_id"
	printf '%s' "$build_id" >"$fixture_next/BUILD_ID"
	printf '%s\n' \
		'{"pages":{"/payment/page":["static/chunks/app/payment/page-payment123.js"],"/admin/settings/page":["static/chunks/app/admin/settings/page-admin123.js"]}}' \
		>"$fixture_next/app-build-manifest.json"
	printf '%s\n' '{"/payment/page":"app/payment/page.js"}' \
		>"$fixture_next/server/app-paths-manifest.json"
	printf '%s\n' 'self.__BUILD_MANIFEST={};' \
		>"$fixture_next/static/$build_id/_buildManifest.js"
	printf '%s\n' 'payment asset' >"$payment_asset"
	printf '%s\n' 'globalThis.__RSC_MANIFEST={"/payment/page":{}};' >"$reference_file"
	# Literal JavaScript template string fixture.
	# shellcheck disable=SC2016
	printf '%s\n' \
		'const url=`${api}/billing-settings/public`;async function page(){const settings=await fetch(url);return jsx(Pricing,{paymentEnabled:settings?.paymentEnabled??false,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null});}' \
		>"$payment_file"
	printf '%s\n' \
		'api.get("/billing-settings/admin");api.patch("/billing-settings/admin",body);api.get("/site-settings");api.patch("/site-settings",body);' \
		>"$admin_file"
	scanner="$(platform_frontend_attestation_build_evidence_scanner)"
	evidence="$(CONTRACT_ROOT="$fixture_next" node -e "$scanner")"
	[[ "$evidence" == "$build_id|/_next/static/$build_id/_buildManifest.js|"* ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend build scanner rejected structurally valid equivalent fail-closed code.'
	printf '%s\n' \
		'const decoy="/billing-settings/public";const fake={paymentEnabled:x?.paymentEnabled??false,autoRenewalSignupEnabled:x?.autoRenewalSignupEnabled??false,autoRenewalTerms:x?.autoRenewalTerms??null};fetch("/billing-"+"settings");' \
		>>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted decoy evidence with a composed legacy route.'
	fi
	evidence="$(
		CONTRACT_ROOT="$fixture_next" \
		CONTRACT_INTEGRITY_ONLY_REVISION="$PLATFORM_FRONTEND_ATTESTATION_HARD_CUTOVER_FRONTEND_REVISION" \
			node -e "$scanner"
	)"
	[[ "$evidence" == "$build_id|/_next/static/$build_id/_buildManifest.js|"* ]] ||
		platform_frontend_attestation_fail \
			'Pinned hard-cutover inventory mode rejected exact Next build evidence.'
	if CONTRACT_ROOT="$fixture_next" \
		CONTRACT_INTEGRITY_ONLY_REVISION='0000000000000000000000000000000000000000' \
		node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Hard-cutover inventory mode accepted an unreviewed frontend revision.'
	fi
	# Literal JavaScript template string fixtures.
	# shellcheck disable=SC2016
	printf '%s\n' \
		'const url=`${api}/billing-settings/public`;async function page(){const settings=await fetch(url);return jsx(Pricing,{paymentEnabled:settings?.paymentEnabled??false,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null});}const legacy=`${api}/billing-settings`;' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted a legacy route inside an interpolated template literal.'
	fi
	# shellcheck disable=SC2016
	printf '%s\n' \
		'const url=`${api}/billing-settings/public`;async function page(){const settings=await fetch(url);return jsx(Pricing,{paymentEnabled:settings?.paymentEnabled??false,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null});}const legacy=`/billing-${"settings"}`;' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted a statically resolved legacy-route template interpolation.'
	fi
	# Literal JavaScript template string fixtures with cooked escape sequences.
	# shellcheck disable=SC2016
	printf '%s\n' \
		'const url=`${api}/billing-settings/public`;async function page(){const settings=await fetch(url);return jsx(Pricing,{paymentEnabled:settings?.paymentEnabled??false,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null});}const legacy=`${api}\x2fbilling-settings`;' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted a hex-escaped legacy route inside a template literal.'
	fi
	# shellcheck disable=SC2016
	printf '%s\n' \
		'const url=`${api}/billing-settings/public`;async function page(){const settings=await fetch(url);return jsx(Pricing,{paymentEnabled:settings?.paymentEnabled??false,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null});}const legacy=`${api}\u002fbilling-settings`;' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted a Unicode-escaped legacy route inside a template literal.'
	fi
	# Literal JavaScript template string fixture.
	# shellcheck disable=SC2016
	printf '%s\n' \
		'const url=`${api}/billing-settings/public`;async function page(){const settings=await fetch(url);return jsx(Pricing,{paymentEnabled:settings?.paymentEnabled??true,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null});}' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted a fail-open payment fallback.'
	fi
	printf '%s\n' \
		'const url="/billing-settings/public";async function page(){const settings=await fetch(url);const decoy={paymentEnabled:settings?.paymentEnabled??false,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null};return jsx(Pricing,{paymentEnabled:true,autoRenewalSignupEnabled:true,autoRenewalTerms:"unsafe"});}' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted unused fail-closed decoys around fail-open rendered Pricing props.'
	fi
	printf '%s\n' \
		'const url="/billing-settings/public";async function page(flag){const settings=await fetch(url);let enabled=settings?.paymentEnabled;enabled=flag?true:enabled;let signup=settings?.autoRenewalSignupEnabled;signup=flag?true:signup;let terms=settings?.autoRenewalTerms;terms=flag?"unsafe":terms;return jsx(Pricing,{paymentEnabled:enabled??false,autoRenewalSignupEnabled:signup??false,autoRenewalTerms:terms??null});}' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted conditionally overwritten aliases for rendered Pricing props.'
	fi
	printf '%s\n' \
		'const url="/billing-settings/public";function decoy(settings){return jsx(Pricing,{paymentEnabled:settings?.paymentEnabled??false,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null});}async function page(){await fetch(url);return React.createElement(Pricing,{paymentEnabled:true,autoRenewalSignupEnabled:true,autoRenewalTerms:"unsafe"});}' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted a safe JSX decoy beside fail-open createElement Pricing props.'
	fi
	# shellcheck disable=SC2016
	printf '%s\n' \
		'const url=`${api}/billing-settings/public`;const factory=React[`crea${"teElement"}`];function decoy(settings){return jsx(Pricing,{paymentEnabled:settings?.paymentEnabled??false,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null});}async function page(){await fetch(url);return factory(Pricing,{"paymentEnabled":true,"autoRenewalSignupEnabled":true,"autoRenewalTerms":"unsafe"});}' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted a statically computed createElement factory beside quoted fail-open props.'
	fi
	printf '%s\n' \
		'const url="/billing-settings/public";const render=jsx;function decoy(settings){return jsx(Pricing,{paymentEnabled:settings?.paymentEnabled??false,autoRenewalSignupEnabled:settings?.autoRenewalSignupEnabled??false,autoRenewalTerms:settings?.autoRenewalTerms??null});}async function page(){await fetch(url);return render(Pricing,{paymentEnabled:true,autoRenewalSignupEnabled:true,autoRenewalTerms:"unsafe"});}' \
		>"$payment_file"
	if CONTRACT_ROOT="$fixture_next" node -e "$scanner" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend build scanner accepted a safe JSX decoy beside an indirect fail-open Pricing render.'
	fi

	html_validator="$(platform_frontend_attestation_payment_html_validator)"
	expected_payment_asset='/_next/static/chunks/app/payment/page-payment123.js'
	export EXPECTED_DOCUMENT_ORIGIN="$origin"
	platform_frontend_attestation_expect_html_rejected() {
		local fixture="$1" label="$2"
		printf '%s\n' "$fixture" >"$root/payment.html"
		if HTML_PATH="$root/payment.html" \
			EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
			node -e "$html_validator" >/dev/null 2>&1; then
			platform_frontend_attestation_fail \
				"Platform frontend HTML verifier accepted $label."
		fi
	}
	platform_frontend_attestation_expect_content_type_rejected() {
		local content_type="$1" label="$2"
		if platform_frontend_attestation_content_type_is_html "$content_type"; then
			platform_frontend_attestation_fail \
				"Platform frontend media-type verifier accepted $label."
		fi
	}

	platform_frontend_attestation_content_type_is_html 'text/html'
	platform_frontend_attestation_content_type_is_html 'Text/Html; charset=utf-8'
	platform_frontend_attestation_content_type_is_html 'text/html;charset=UTF-8'
	platform_frontend_attestation_expect_content_type_rejected \
		'text/plain' 'a non-HTML response'
	platform_frontend_attestation_expect_content_type_rejected \
		'text/html; charset=iso-8859-1' 'a non-UTF-8 charset'
	platform_frontend_attestation_expect_content_type_rejected \
		'text/html; charset=utf-8; boundary=x' 'multiple media-type parameters'
	platform_frontend_attestation_expect_content_type_rejected \
		'text/html; charset="utf-8"' 'an ambiguous quoted charset'
	platform_frontend_attestation_expect_content_type_rejected \
		' text/html' 'leading media-type whitespace'
	platform_frontend_attestation_expect_content_type_rejected \
		'text/html ' 'trailing media-type whitespace without a charset'
	platform_frontend_attestation_expect_content_type_rejected \
		$'text/html;\tcharset=utf-8' 'a media type containing a tab control byte'
	platform_frontend_attestation_expect_content_type_rejected \
		$'text/html\r' 'a media type containing a carriage-return control byte'
	platform_frontend_attestation_expect_content_type_rejected \
		$'text/html\177' 'a media type containing a DEL control byte'
	platform_frontend_attestation_expect_content_type_rejected \
		'text/html; charset=utf-8 ' 'a media type containing non-ASCII whitespace'

	response_headers="$root/response.headers"
	printf 'HTTP/2 200\r\ncontent-type: text/html; charset=utf-8\r\nx-nextjs-cache: HIT\r\n\r\n' \
		>"$response_headers"
	platform_frontend_attestation_response_headers_are_safe "$response_headers" ||
		platform_frontend_attestation_fail \
			'Platform frontend response-header verifier rejected one CSP-free HTTP 200 block.'
	platform_frontend_attestation_expect_headers_rejected() {
		local fixture="$1" label="$2"
		printf '%b' "$fixture" >"$response_headers"
		if platform_frontend_attestation_response_headers_are_safe "$response_headers"; then
			platform_frontend_attestation_fail \
				"Platform frontend response-header verifier accepted $label."
		fi
	}
	platform_frontend_attestation_expect_headers_rejected \
		'HTTP/1.1 200 OK\r\nContent-Security-Policy: script-src '\''none'\''\r\n\r\n' \
		'an enforced Content-Security-Policy response header'
	platform_frontend_attestation_expect_headers_rejected \
		'HTTP/2 200\r\ncOnTeNt-SeCuRiTy-PoLiCy-RePoRt-OnLy: default-src '\''none'\''\r\n\r\n' \
		'a Content-Security-Policy-Report-Only response header'
	platform_frontend_attestation_expect_headers_rejected \
		'HTTP/1.1 302 Found\r\nlocation: /payment\r\n\r\nHTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n' \
		'a redirect chain with more than one response block'
	platform_frontend_attestation_expect_headers_rejected \
		'HTTP/1.1 200 OK\r\n Content-Security-Policy: script-src '\''none'\''\r\n\r\n' \
		'an obsolete folded response header'

	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/framework-shared.js"></script></html>' \
		'an old page sharing only a framework asset'
	platform_frontend_attestation_expect_html_rejected \
		'<html><!-- <script src="/_next/static/chunks/app/payment/page-payment123.js"></script> --><body>old</body></html>' \
		'a comment-only route asset decoy'
	platform_frontend_attestation_expect_html_rejected \
		'<html><!-- harmless --!><script src="/_next/static/chunks/app/payment/page-other456.js"></script> --><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'an additional legacy chunk exposed by the browser-specific --!> comment close'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script type="application/json">{}</script ignored><script src="/_next/static/chunks/app/payment/page-other456.js"></script></script><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'an additional legacy chunk after a raw-text end tag carrying ignored attributes'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script type="application/json">{}</script/><script src="/_next/static/chunks/app/payment/page-other456.js"></script></script><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'an additional legacy chunk after a raw-text end tag carrying a trailing solidus'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script>window.decoy="/_next/static/chunks/app/payment/page-payment123.js"</script></html>' \
		'an inline script-body route asset decoy'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script data-src="/_next/static/chunks/app/payment/page-payment123.js"></script><link rel="stylesheet" href="/_next/static/chunks/app/payment/page-payment123.js"></html>' \
		'a non-executable route asset attribute'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script src="/_next/static/chunks/app/payment/page-other456.js"></script></html>' \
		'an additional executable payment page chunk from another build'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script>document.write("<script src=\"/_next/static/chunks/app/payment/page-other456.js\"><\/script>")</script></html>' \
		'an inline document.write of a legacy payment page chunk'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script>const legacy=document.createElement("script");legacy.src="/_next/static/chunks/app/payment/page-other456.js";document.head.appendChild(legacy)</script></html>' \
		'an inline dynamically created legacy payment page chunk'
	platform_frontend_attestation_expect_html_rejected \
		'<html><body onload="document.write(legacy)"><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></body></html>' \
		'an executable event-handler attribute outside a script element'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script>(self.__next_f=self.__next_f||[]).push([0]);self.__next_f.push([2,null]);document.write("old")</script></html>' \
		'executable code appended to an otherwise valid Next Flight bootstrap'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script>(self.__next_f=self.__next_f||[]).push([0]);self.__next_f.push([1,"static/chunks/app/payment/page-other456.js"])</script></html>' \
		'a legacy payment chunk reference inside decoded Next Flight data'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script src="/_next/static/chunks/app/payment/page-other456.js?generation=old"></script></html>' \
		'an additional executable payment page chunk carrying a query string'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script src="/_next/static/chunks/app/payment/page-other&#52;56.js"></script></html>' \
		'an entity-obfuscated additional executable payment page chunk'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script type="text/jav&#97;script" src="/_next/static/chunks/app/payment/page-other456.js"></script></html>' \
		'an entity-obfuscated executable script type on a legacy payment page chunk'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a duplicate executable reference to the expected payment page chunk'
	platform_frontend_attestation_expect_html_rejected \
		'<html><head><base href="https://attacker.invalid/"></head><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a base element that redirects the signed root-relative payment asset to another origin'
	platform_frontend_attestation_expect_html_rejected \
		"<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"></head><script src=\"/_next/static/chunks/app/payment/page-payment123.js\"></script></html>" \
		'a CSP meta element that blocks executable script'
	platform_frontend_attestation_expect_html_rejected \
		'<html><head><meta http-equiv="Content-Security-Polic&#121;" content="script-src none"></head><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'an entity-obfuscated CSP meta http-equiv value'
	platform_frontend_attestation_expect_html_rejected \
		'<html><div title="> <script src=&quot;/_next/static/chunks/app/payment/page-payment123.js&quot;></script>">quoted decoy</div></html>' \
		'a tag-shaped string inside a quoted attribute'
	platform_frontend_attestation_expect_html_rejected \
		'<html><div title='"'"'unterminated><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'an unterminated quoted attribute'
	platform_frontend_attestation_expect_html_rejected \
		'<html><template><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></template></html>' \
		'a script inside inert template content'
	platform_frontend_attestation_expect_html_rejected \
		'<html><template/><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></template></html>' \
		'a script after an HTML template start tag with an ignored self-closing flag'
	platform_frontend_attestation_expect_html_rejected \
		'<html><textarea><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></textarea></html>' \
		'a script-shaped string inside textarea RCDATA'
	platform_frontend_attestation_expect_html_rejected \
		'<html><textarea/><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></textarea></html>' \
		'a script-shaped string after an HTML textarea start tag with an ignored self-closing flag'
	platform_frontend_attestation_expect_html_rejected \
		'<html><title><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></title></html>' \
		'a script-shaped string inside title RCDATA'
	platform_frontend_attestation_expect_html_rejected \
		'<html><title/><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></title></html>' \
		'a script-shaped string after an HTML title start tag with an ignored self-closing flag'
	platform_frontend_attestation_expect_html_rejected \
		'<html><style><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></style></html>' \
		'a script-shaped string inside style raw text'
	platform_frontend_attestation_expect_html_rejected \
		'<html><style/><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></style></html>' \
		'a script-shaped string after an HTML style start tag with an ignored self-closing flag'
	platform_frontend_attestation_expect_html_rejected \
		'<html><noscript><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></noscript></html>' \
		'a script inside scripting-enabled noscript raw text'
	platform_frontend_attestation_expect_html_rejected \
		'<html><xmp><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></xmp></html>' \
		'a script-shaped string inside xmp raw text'
	platform_frontend_attestation_expect_html_rejected \
		'<html><iframe><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></iframe></html>' \
		'a script-shaped string inside iframe raw text'
	platform_frontend_attestation_expect_html_rejected \
		'<html><noembed><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></noembed></html>' \
		'a script-shaped string inside noembed raw text'
	platform_frontend_attestation_expect_html_rejected \
		'<html><plaintext><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></plaintext></html>' \
		'a script-shaped string after a plaintext start tag'
	platform_frontend_attestation_expect_html_rejected \
		'<html><plaintext/><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a script-shaped string after an HTML plaintext start tag with an ignored self-closing flag'
	platform_frontend_attestation_expect_html_rejected \
		'<html><svg><script href="/_next/static/chunks/app/payment/page-payment123.js"></script></svg></html>' \
		'an SVG namespace script'
	platform_frontend_attestation_expect_html_rejected \
		'<html><svg><foreignObject><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></foreignObject></svg></html>' \
		'an HTML integration-point script nested in SVG'
	platform_frontend_attestation_expect_html_rejected \
		'<html><svg><foreignObject><template></foreignObject></svg><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'an HTML template state escaping an SVG foreignObject integration point'
	platform_frontend_attestation_expect_html_rejected \
		'<html><svg><foreignObject><plaintext/></foreignObject></svg><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'an HTML plaintext state escaping an SVG foreignObject integration point'
	platform_frontend_attestation_expect_html_rejected \
		'<html><math><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></math></html>' \
		'a MathML namespace script'
	platform_frontend_attestation_expect_html_rejected \
		'<html><math><annotation-xml encoding="text/html"><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></annotation-xml></math></html>' \
		'an HTML integration-point script nested in MathML'
	platform_frontend_attestation_expect_html_rejected \
		'<html><math><annotation-xml encoding="text/html"><template></annotation-xml></math><script src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'an HTML template state escaping a MathML annotation-xml integration point'
	platform_frontend_attestation_expect_html_rejected \
		'<!DOCTYPE html><html><body><!script src="/_next/static/chunks/app/payment/page-payment123.js"><p>bogus declaration</p></body></html>' \
		'a bogus declaration route asset decoy'
	platform_frontend_attestation_expect_html_rejected \
		'<html><![CDATA[<script src="/_next/static/chunks/app/payment/page-payment123.js"></script>]]><body>old</body></html>' \
		'an HTML CDATA-shaped route asset decoy'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script-x src="/_next/static/chunks/app/payment/page-payment123.js"></script-x></html>' \
		'a custom script-x element'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script:decoy src="/_next/static/chunks/app/payment/page-payment123.js"></script:decoy></html>' \
		'a namespaced-looking script:decoy custom element'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script type="application/json" src="/_next/static/chunks/app/payment/page-payment123.js">{}</script></html>' \
		'an application/json script'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script type="importmap" src="/_next/static/chunks/app/payment/page-payment123.js">{}</script></html>' \
		'an importmap script'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js"></script><script type="importmap">{"imports":{"legacy":"/_next/static/chunks/app/payment/page-other456.js"}}</script></html>' \
		'an import map that changes the executable dependency graph'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script type=" " src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a whitespace-only script type that browsers treat as a data block'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script type=" MODULE " src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a whitespace-padded module keyword that browsers treat as a data block'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script language="vbscript" src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a legacy non-JavaScript language script'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script language="module" src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a language attribute that does not select a JavaScript MIME type'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script language="javascript" type="application/json" src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a non-JavaScript type that takes precedence over a JavaScript language attribute'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script integrity="sha256-decoy" src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'an integrity-constrained script ambiguity'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script media="not all" src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a media-constrained script ambiguity'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script disabled src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a disabled script ambiguity'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script nomodule src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'a nomodule script ambiguity'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js" src="/_next/static/chunks/app/payment/page-payment123.js"></script></html>' \
		'duplicate src attributes'
	platform_frontend_attestation_expect_html_rejected \
		'<html><script src="/_next/static/chunks/app/payment/page-payment123.js" /></html>' \
		'a self-closing HTML script ambiguity'
	platform_frontend_attestation_expect_html_rejected \
		'<html><link rel="modulepreload" href="/_next/static/chunks/app/payment/page-payment123.js"><body>preload only</body></html>' \
		'a modulepreload-only reference without executable proof'
	platform_frontend_attestation_expect_html_rejected \
		'<html><link rel="preload" as="script" href="/_next/static/chunks/app/payment/page-payment123.js"><body>preload only</body></html>' \
		'a script-preload-only reference without executable proof'

	printf '\377<html><script src="%s"></script></html>\n' \
		"$expected_payment_asset" >"$root/payment.html"
	if HTML_PATH="$root/payment.html" \
		EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
		node -e "$html_validator" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend HTML verifier accepted invalid UTF-8.'
	fi

	printf '<!DOCTYPE html><html><body><script async="" src="%s"></script><script>(self.__next_f=self.__next_f||[]).push([0]);self.__next_f.push([2,null])</script><script>self.__next_f.push([1,"static/chunks/app/payment/page-payment123.js"])</script></body></html>\n' \
		"$expected_payment_asset" >"$root/payment.html"
	graph_first="$(HTML_PATH="$root/payment.html" \
		EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
		node -e "$html_validator")"
	graph_second="$(HTML_PATH="$root/payment.html" \
		EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
		node -e "$html_validator")"
	[[ "$graph_first" =~ ^[0-9a-f]{64}$ && "$graph_first" == "$graph_second" ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend HTML verifier did not produce a deterministic executable graph hash.'
	printf '<!DOCTYPE html><html><body><script async="" src="%s"></script><script>(self.__next_f=self.__next_f||[]).push([0]);self.__next_f.push([2,null])</script><script>self.__next_f.push([1,"different-current-flight-payload"])</script></body></html>\n' \
		"$expected_payment_asset" >"$root/payment.html"
	graph_third="$(HTML_PATH="$root/payment.html" \
		EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
		node -e "$html_validator")"
	[[ "$graph_third" =~ ^[0-9a-f]{64}$ && "$graph_third" != "$graph_first" ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend executable graph hash did not bind exact inline script bytes.'

	local valid_type
	for valid_type in '' 'type' 'type=""' 'type="text/javascript"' \
		'type="Text/JavaScript"' 'type="application/javascript"' \
		'type=" text/javascript "' 'type="module"' 'type="MoDuLe"'; do
		printf '<!DOCTYPE html><html><head></head><body><ScRiPt %s src="%s" async=""></sCrIpT></body></html>\n' \
			"$valid_type" "$expected_payment_asset" >"$root/payment.html"
		HTML_PATH="$root/payment.html" \
			EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
			node -e "$html_validator" >/dev/null ||
			platform_frontend_attestation_fail \
				"Platform frontend HTML verifier rejected executable script type: ${valid_type:-absent}."
	done
	local valid_language
	for valid_language in 'language' 'language=""' 'language="javascript"' \
		'language="JavaScript1.5"' 'language="ecmascript"' \
		'language="vbscript" type=""' 'language="vbscript" type="module"'; do
		printf '<!DOCTYPE html><html><head></head><body><script %s src="%s"></script></body></html>\n' \
			"$valid_language" "$expected_payment_asset" >"$root/payment.html"
		HTML_PATH="$root/payment.html" \
			EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
			node -e "$html_validator" >/dev/null ||
			platform_frontend_attestation_fail \
				"Platform frontend HTML verifier rejected executable script attributes: $valid_language."
	done
	printf '<!DOCTYPE html><html><head></head><body><script src="%s" /></script></body></html>\n' \
		"$expected_payment_asset" >"$root/payment.html"
	HTML_PATH="$root/payment.html" \
		EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
		node -e "$html_validator" >/dev/null ||
		platform_frontend_attestation_fail \
			'Platform frontend HTML verifier rejected an executable HTML script whose ignored self-closing flag is followed by its end tag.'
	printf '<!DOCTYPE html><html><head><!-- harmless --><link rel="modulepreload" href="%s"><template><script src="%s"></script></template><svg><use href="%s"></use></svg><script type="application/json">{"decoy":"<script src=\\"%s\\"></script>"}</script></head><body><script defer src="%s"></script></body></html>\n' \
		"$expected_payment_asset" "$expected_payment_asset" \
		"$expected_payment_asset" "$expected_payment_asset" \
		"$expected_payment_asset" >"$root/payment.html"
	HTML_PATH="$root/payment.html" \
		EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
		node -e "$html_validator" >/dev/null ||
		platform_frontend_attestation_fail \
			'Platform frontend HTML verifier rejected a valid executable reference surrounded by inert decoys.'
	printf '<!DOCTYPE html><html><head></head><body><script data-note="> remains inside the quoted value" src="%s"></script></body></html>\n' \
		"$expected_payment_asset" >"$root/payment.html"
	HTML_PATH="$root/payment.html" \
		EXPECTED_PAYMENT_ASSET_PATH="$expected_payment_asset" \
		node -e "$html_validator" >/dev/null ||
		platform_frontend_attestation_fail \
			'Platform frontend HTML verifier rejected a valid script after a greater-than byte inside a quoted attribute.'

	port_parser="$(platform_frontend_attestation_port_binding_parser)"
	[[ "$(PORT_BINDINGS='[{"HostIp":"127.0.0.1","HostPort":"3000"}]' node -e "$port_parser")" == '3000' ]] ||
		platform_frontend_attestation_fail \
			'Platform frontend port binding parser rejected the exact loopback binding.'
	if PORT_BINDINGS='[{"HostIp":"0.0.0.0","HostPort":"3000"}]' \
		node -e "$port_parser" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend port binding parser accepted a public host binding.'
	fi

	if platform_frontend_attestation_require_distinct_paths \
		'/safe/a' '/safe/b' '/safe/a' >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend path validator accepted colliding artifact paths.'
	fi
	private_key="$root/private.pem"
	public_key="$root/public.pem"
	rsa_key="$root/rsa.pem"
	openssl genpkey -algorithm ED25519 -out "$private_key" >/dev/null 2>&1
	openssl pkey -in "$private_key" -pubout -out "$public_key"
	platform_frontend_attestation_require_ed25519_private_key "$private_key"
	platform_frontend_attestation_require_ed25519_public_key "$public_key"
	openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
		-out "$rsa_key" >/dev/null 2>&1
	if platform_frontend_attestation_require_ed25519_private_key "$rsa_key" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend key validator accepted an RSA private key.'
	fi

	now="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	stale="$(node -e 'process.stdout.write(new Date(Date.now() - 7200000).toISOString().replace(".000", ""))')"
	payload="$root/attestation.json"
	signature="$root/attestation.sig"
	mixed_signature="$root/mixed.sig"
	payload_text="{\"version\":3,\"purpose\":\"platform-frontend-runtime\",\"backendRevision\":\"$backend_revision\",\"cutoverGeneration\":\"$generation\",\"frontendRevision\":\"$frontend_revision\",\"verificationMode\":\"pinned-hard-cutover-integrity\",\"origin\":\"$origin\",\"challenge\":\"$challenge\",\"composeProject\":\"winwidget\",\"composeService\":\"client\",\"containerId\":\"$container_id\",\"imageId\":\"$image_id\",\"appRevision\":\"$frontend_revision\",\"imageRevision\":\"$frontend_revision\",\"status\":\"running\",\"health\":\"not-configured\",\"restarting\":false,\"restartCount\":0,\"containerHostPort\":3000,\"buildId\":\"$build_id\",\"buildManifestPath\":\"/_next/static/$build_id/_buildManifest.js\",\"buildManifestSha256\":\"$build_manifest_sha\",\"appBuildManifestSha256\":\"$app_build_manifest_sha\",\"paymentAssetPath\":\"/_next/static/chunks/app/payment/page-payment123.js\",\"paymentAssetSha256\":\"$payment_asset_sha\",\"paymentServerPath\":\"server/app/payment/page.js\",\"paymentServerSha256\":\"$payment_server_sha\",\"paymentReferenceManifestPath\":\"server/app/payment/page_client-reference-manifest.js\",\"paymentReferenceManifestSha256\":\"$reference_sha\",\"localPaymentHtmlSha256\":\"$local_payment_html_sha\",\"publicPaymentHtmlSha256\":\"$public_payment_html_sha\",\"paymentExecutableGraphSha256\":\"$payment_graph_sha\",\"contractDefenseScan\":false,\"localPaymentHttp\":true,\"publicPaymentHttp\":true,\"verifiedAt\":\"$now\"}"
	printf '%s\n' "$payload_text" >"$payload"
	validator="$(platform_frontend_attestation_json_validator)"
	ATTESTATION_PATH="$payload" EXPECTED_BACKEND_REVISION="$backend_revision" \
		EXPECTED_FRONTEND_REVISION="$frontend_revision" \
		EXPECTED_CUTOVER_GENERATION="$generation" EXPECTED_CHALLENGE="$challenge" \
		EXPECTED_ORIGIN="$origin" MAX_AGE_SECONDS=600 node -e "$validator" >/dev/null
	ATTESTATION_PAYLOAD="$payload_text" node -e '
const value = JSON.parse(process.env.ATTESTATION_PAYLOAD);
value.contractDefenseScan = true;
process.stdout.write(`${JSON.stringify(value)}\n`);
' >"$root/false-defense-claim.json"
	if ATTESTATION_PATH="$root/false-defense-claim.json" \
		EXPECTED_BACKEND_REVISION="$backend_revision" \
		EXPECTED_FRONTEND_REVISION="$frontend_revision" \
		EXPECTED_CUTOVER_GENERATION="$generation" EXPECTED_CHALLENGE="$challenge" \
		EXPECTED_ORIGIN="$origin" MAX_AGE_SECONDS=600 \
		node -e "$validator" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Hard-cutover attestation accepted a false semantic-defense claim.'
	fi
	ATTESTATION_PAYLOAD="$payload_text" node -e '
const value = JSON.parse(process.env.ATTESTATION_PAYLOAD);
const revision = "89abcdef0123456789abcdef0123456789abcdef";
value.frontendRevision = revision;
value.appRevision = revision;
value.imageRevision = revision;
process.stdout.write(`${JSON.stringify(value)}\n`);
' >"$root/unreviewed-frontend.json"
	if ATTESTATION_PATH="$root/unreviewed-frontend.json" \
		EXPECTED_BACKEND_REVISION="$backend_revision" \
		EXPECTED_FRONTEND_REVISION='89abcdef0123456789abcdef0123456789abcdef' \
		EXPECTED_CUTOVER_GENERATION="$generation" EXPECTED_CHALLENGE="$challenge" \
		EXPECTED_ORIGIN="$origin" MAX_AGE_SECONDS=600 \
		node -e "$validator" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Hard-cutover attestation accepted an unreviewed frontend identity.'
	fi
	printf '%s\n' \
		"${payload_text/,\"paymentExecutableGraphSha256\":\"$payment_graph_sha\"/}" \
		>"$root/missing-graph.json"
	if ATTESTATION_PATH="$root/missing-graph.json" \
		EXPECTED_BACKEND_REVISION="$backend_revision" \
		EXPECTED_FRONTEND_REVISION="$frontend_revision" \
		EXPECTED_CUTOVER_GENERATION="$generation" EXPECTED_CHALLENGE="$challenge" \
		EXPECTED_ORIGIN="$origin" MAX_AGE_SECONDS=600 \
		node -e "$validator" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend attestation validator accepted an unsigned executable-graph contract.'
	fi
	openssl pkeyutl -sign -inkey "$private_key" -rawin \
		-in "$payload" -out "$signature"
	openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
		-in "$payload" -sigfile "$signature" >/dev/null
	printf '%s\n' "${payload_text/$now/$stale}" >"$payload"
	if ATTESTATION_PATH="$payload" EXPECTED_BACKEND_REVISION="$backend_revision" \
		EXPECTED_FRONTEND_REVISION="$frontend_revision" \
		EXPECTED_CUTOVER_GENERATION="$generation" EXPECTED_CHALLENGE="$challenge" \
		EXPECTED_ORIGIN="$origin" MAX_AGE_SECONDS=600 node -e "$validator" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend attestation validator accepted a stale payload.'
	fi
	printf '%s\n' "$payload_text" >"$payload"
	printf '%s\n' "${payload_text/$challenge/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}" \
		>"$root/mixed.json"
	openssl pkeyutl -sign -inkey "$private_key" -rawin \
		-in "$root/mixed.json" -out "$mixed_signature"
	if openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
		-in "$payload" -sigfile "$mixed_signature" >/dev/null 2>&1; then
		platform_frontend_attestation_fail \
			'Platform frontend signature accepted mixed-generation evidence.'
	fi
	printf 'platform_frontend_runtime_attestation_self_test=passed\n'
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--bootstrap-key)
		[[ $# -eq 1 ]] || exit 1
		platform_frontend_attestation_bootstrap_key
		;;
	--generate)
		[[ $# -eq 1 ]] || exit 1
		platform_frontend_attestation_generate
		;;
	--validate)
		[[ $# -eq 1 ]] || exit 1
		platform_frontend_attestation_validate
		;;
	--self-test)
		[[ $# -eq 1 ]] || exit 1
		platform_frontend_attestation_self_test
		;;
	*)
		platform_frontend_attestation_fail \
			"Usage: $0 --bootstrap-key|--generate|--validate|--self-test"
		exit 1
		;;
	esac
fi
