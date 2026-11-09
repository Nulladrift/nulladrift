/**
 * In @nulladrift/core, beside sanitizeUrl: the control plane receives the same locked transport
 * and has to agree on what was left out of it. Re-exported here so the CLI's own imports keep
 * reading as local modules.
 */
export * from "@nulladrift/core/lock/credentials";
