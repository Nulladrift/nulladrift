/** Kept in step with package.json by a test, so the bundler never has to inline JSON. */
export const VERSION = "0.6.0";

/**
 * Sent on every outbound HTTP request: the registry walk and each remote server connection.
 *
 * The crawl dials a hundred-odd third-party hosts daily and indefinitely. An operator who
 * notices that traffic and wants to know what it is has nothing to go on without this, and no
 * way to find out who to ask for it to stop. The URL is the project, deliberately not a personal
 * address.
 */
export const USER_AGENT = `nulladrift/${VERSION} (+https://github.com/Nulladrift/nulladrift)`;
