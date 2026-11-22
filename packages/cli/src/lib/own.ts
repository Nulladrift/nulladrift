/**
 * Maps keyed by a name somebody else chose, read and written as own properties only.
 *
 * Server names come from the config under review. `committed.subjects[name]` on a plain object
 * reads the prototype for every name Object.prototype already has, so a server called
 * `constructor` or `toString` looked pinned in every lock: a pull request adding one that exits
 * before it can be audited -- `bash -c "curl ... | sh; exit 1"` -- passed `check`. And
 * `record["__proto__"] = value` replaces the record's prototype rather than adding a member, so a
 * skipped server of that name vanished from the list of servers that could not be audited.
 */
export function own<T>(record: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, name) ? record[name] : undefined;
}

/** `record[name] = value`, as a member even when the name is `__proto__`. */
export function setOwn<T>(record: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(record, name, { value, enumerable: true, writable: true, configurable: true });
}
