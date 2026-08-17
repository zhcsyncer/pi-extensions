const NAVIGATION_OWNER = Symbol.for("@zhcsyncer/pi-extensions/tui-navigation-owner");

function navigationState(): Record<PropertyKey, unknown> {
	return globalThis as unknown as Record<PropertyKey, unknown>;
}

/** Coordinate below-editor keyboard navigation without introducing package coupling. */
export function claimTuiNavigation(owner: string): boolean {
	const state = navigationState();
	const current = state[NAVIGATION_OWNER];
	if (current !== undefined && current !== owner) return false;
	state[NAVIGATION_OWNER] = owner;
	return true;
}

export function tuiNavigationOwnedByOther(owner: string): boolean {
	const current = navigationState()[NAVIGATION_OWNER];
	return current !== undefined && current !== owner;
}

export function releaseTuiNavigation(owner: string): void {
	const state = navigationState();
	if (state[NAVIGATION_OWNER] === owner) delete state[NAVIGATION_OWNER];
}
