export interface SessionFuzzyMatch {
	readonly matches: boolean;
	readonly score: number;
}

export function fuzzyMatchSessionText(query: string, text: string): SessionFuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const matchQuery = (normalizedQuery: string): SessionFuzzyMatch => {
		if (normalizedQuery.length === 0) return { matches: true, score: 0 };
		if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;

		for (let index = 0; index < textLower.length && queryIndex < normalizedQuery.length; index += 1) {
			if (textLower[index] !== normalizedQuery[queryIndex]) continue;

			const isWordBoundary = index === 0 || /[\s\-_./:]/.test(textLower[index - 1]!);
			if (lastMatchIndex === index - 1) {
				consecutiveMatches += 1;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				if (lastMatchIndex >= 0) score += (index - lastMatchIndex - 1) * 2;
			}
			if (isWordBoundary) score -= 10;
			score += index * 0.1;
			lastMatchIndex = index;
			queryIndex += 1;
		}

		if (queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
		if (normalizedQuery === textLower) score -= 100;
		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) return primaryMatch;

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	let swappedQuery = "";
	if (alphaNumericMatch?.groups) {
		swappedQuery = `${alphaNumericMatch.groups.digits ?? ""}${alphaNumericMatch.groups.letters ?? ""}`;
	} else if (numericAlphaMatch?.groups) {
		swappedQuery = `${numericAlphaMatch.groups.letters ?? ""}${numericAlphaMatch.groups.digits ?? ""}`;
	}
	if (!swappedQuery) return primaryMatch;

	const swappedMatch = matchQuery(swappedQuery);
	return swappedMatch.matches ? { matches: true, score: swappedMatch.score + 5 } : primaryMatch;
}
