/**
 * Moved to @nulladrift/core: the control plane computes the same diff from the surface it is
 * sent, so the engine cannot live inside the CLI. Re-exported here so the CLI's own imports
 * keep reading as local modules.
 */
export * from "@nulladrift/core/lock/types";
