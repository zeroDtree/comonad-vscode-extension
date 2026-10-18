/**
 * The source forms the copy handler writes back. Math always comes back as `$...$` / `$$...$$`,
 * never the `\(...\)` / `\[...\]` form a model may have used: the user asked for Markdown math.
 */

/** The Markdown source of a formula, given its inner TeX. */
export function wrapTex(tex, display) {
	const source = String(tex ?? '');
	if (!source.trim()) {
		return '';
	}
	if (display) {
		const body = source.replace(/^\n+|\n+$/g, '');
		return body.includes('\n') ? `$$\n${body}\n$$` : `$$${body}$$`;
	}
	return `$${source}$`;
}

/** A code fence long enough to contain the text. */
export function fenceFor(text) {
	let longest = 0;
	for (const match of String(text).matchAll(/`+/g)) {
		longest = Math.max(longest, match[0].length);
	}
	return '`'.repeat(Math.max(3, longest + 1));
}

/** Inline code with a delimiter the text itself does not contain. */
export function inlineCode(text) {
	const value = String(text ?? '');
	const fence = fenceFor(value);
	const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
	return `${fence}${padding}${value}${padding}${fence}`;
}
